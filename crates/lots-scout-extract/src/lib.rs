use ammonia::{Builder, UrlRelative};
use anyhow::{bail, Context, Result};
use dom_query::{Document, NodeRef};
use dom_smoothie::{Config, Readability};
use htmd::HtmlToMarkdown;
use html5ever::{
    buffer_queue::BufferQueue,
    tendril::StrTendril,
    tokenizer::{EndTag, StartTag, Token, TokenSink, TokenSinkResult, Tokenizer, TokenizerOpts},
    LocalName,
};
use lots_scout_types::{
    captured_attachment_relative_path, DraftAttachmentRef, ExtractedDraft, VerifiedBlob,
    VerifiedCapture,
};
use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque};
use url::Url;

mod comments;
pub use comments::{extract_comments, CommentsState, ExtractedComments};
mod linkresearcher;
pub use linkresearcher::LinkresearcherArticleExtractor;
mod amp_podcast;
pub use amp_podcast::AmpPodcastExtractor;
mod weixin;
pub use weixin::WeixinAssets;
pub mod web;
pub mod ratings;
pub mod titles;
pub use lots_scout_types::{
    normalize_title_lang, ItemTitle, Rating, RatingMetric, TitleKind, TitleSource,
};

const MAX_HTML_BYTES: usize = 8 * 1024 * 1024;
const MAX_HTML_ELEMENTS: usize = 100_000;
const MAX_HTML_NESTING_DEPTH: usize = 256;

pub trait Extractor {
    fn id(&self) -> &'static str;
    fn version(&self) -> &'static str;
    fn extract(&self, capture: &VerifiedCapture) -> Result<ExtractedDraft>;
}

/// Picks the site extractor that recognizes this capture, falling back to the
/// generic webpage extractor, and runs it.
pub fn extract(capture: &VerifiedCapture) -> Result<ExtractedDraft> {
    if LinkresearcherArticleExtractor::supports(capture) {
        LinkresearcherArticleExtractor.extract(capture)
    } else if AmpPodcastExtractor::supports(capture) {
        AmpPodcastExtractor.extract(capture)
    } else if WeixinArticleExtractor::supports_url(&capture.capture.source_url) {
        WeixinArticleExtractor.extract(capture)
    } else {
        GenericWebpageExtractor.extract(capture)
    }
}

pub struct GenericWebpageExtractor;

/// Extract one explicit video identity from a trusted fetched episode page.
/// Unrelated script text, client hints and arbitrary thumbnail URLs are ignored.
pub fn podcast_video_id(html: &str) -> Result<Option<String>> {
    anyhow::ensure!(html.len() <= MAX_HTML_BYTES, "podcast_page_limit");
    preflight_html_structure(html)?;
    let document = Document::from(html);
    verify_dom_depth(&document)?;
    // Site-wide navigation may advertise another video. Only the explicit
    // episode content region can provide its cover identity.
    let region = if document.select("main").length() > 0 { "main" } else { "article" };
    anyhow::ensure!(document.select(region).length() == 1, "podcast_video_scope_invalid");
    let mut ids = BTreeSet::new();
    for node in document.select(region).select("iframe[src], a[href], meta[property='og:video'], meta[property='og:video:url']").nodes() {
        let raw = node.attr("src").or_else(|| node.attr("href")).or_else(|| node.attr("content"));
        let Some(raw) = raw else { continue };
        let Ok(url) = Url::parse(&raw) else { continue };
        if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() || url.port().is_some() { continue; }
        let id = match url.host_str() {
            Some("youtube.com" | "www.youtube.com" | "www.youtube-nocookie.com" | "youtube-nocookie.com") => {
                if url.path() == "/watch" {
                    let videos: Vec<_> = url.query_pairs().filter(|(k, _)| k == "v").map(|(_, v)| v.into_owned()).collect();
                    if videos.len() == 1 { videos.into_iter().next() } else { None }
                } else { url.path().strip_prefix("/embed/").map(str::to_owned) }
            }
            Some("youtu.be") => url.path().strip_prefix('/').map(str::to_owned),
            _ => None,
        };
        if let Some(id) = id.filter(|id| id.len() == 11 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')) {
            ids.insert(id);
        }
    }
    anyhow::ensure!(ids.len() <= 1, "podcast_video_ambiguous");
    Ok(ids.into_iter().next())
}

fn base_media_type(value: &str) -> &str {
    value
        .split_once(';')
        .map_or(value, |(media_type, _)| media_type)
        .trim()
}

fn is_html(blob: &VerifiedBlob) -> bool {
    matches!(
        base_media_type(&blob.descriptor.media_type)
            .to_ascii_lowercase()
            .as_str(),
        "text/html" | "application/xhtml+xml"
    )
}

fn is_text(blob: &VerifiedBlob) -> bool {
    matches!(
        base_media_type(&blob.descriptor.media_type)
            .to_ascii_lowercase()
            .as_str(),
        "text/plain" | "text/markdown"
    )
}

fn blob_text(blob: &VerifiedBlob) -> Result<&str> {
    std::str::from_utf8(&blob.bytes).context("verified text artifact is not UTF-8")
}

fn non_empty(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

fn canonical_markdown(value: String) -> Result<String> {
    let normalized = value.replace("\r\n", "\n").replace('\r', "\n");
    let trimmed = normalized.trim();
    if trimmed.is_empty() {
        bail!("webpage extraction produced empty markdown");
    }
    Ok(format!("{trimmed}\n"))
}

fn css_value<'a>(style: &'a str, property: &str) -> Option<&'a str> {
    style.split(';').find_map(|declaration| {
        let (name, value) = declaration.split_once(':')?;
        name.trim()
            .eq_ignore_ascii_case(property)
            .then(|| value.trim().trim_end_matches("!important").trim())
    })
}

/// Neither the node nor any ancestor is hidden by attribute or inline style.
fn visible_in_tree(node: &NodeRef) -> bool {
    std::iter::once(*node).chain(node.ancestors_it(None)).all(|ancestor| {
        let style = ancestor.attr("style").unwrap_or_default();
        ancestor.attr("hidden").is_none()
            && !ancestor.attr("aria-hidden").is_some_and(|v| v.eq_ignore_ascii_case("true"))
            && !css_value(&style, "display").is_some_and(|v| v.eq_ignore_ascii_case("none"))
            && !css_value(&style, "visibility").is_some_and(|v| v.eq_ignore_ascii_case("hidden"))
    })
}

/// Bounded JSON-LD scan in document and breadth-first order: at most 16
/// scripts of 256 KiB each and 64 nodes per script. `visit` returns true to stop.
fn walk_json_ld(document: &Document, mut visit: impl FnMut(&serde_json::Value) -> bool) {
    for node in document.select("script[type='application/ld+json']").nodes().iter().take(16) {
        let raw = node.text();
        if raw.len() > 256 * 1024 {
            continue;
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) else {
            continue;
        };
        let mut pending = VecDeque::from([&value]);
        let mut visited = 0;
        while let Some(node) = pending.pop_front() {
            visited += 1;
            if visited > 64 {
                break;
            }
            if let Some(nodes) = node.as_array() {
                pending.extend(nodes.iter().take(64));
                continue;
            }
            if let Some(nodes) = node["@graph"].as_array() {
                pending.extend(nodes.iter().take(64));
            }
            if visit(node) {
                return;
            }
        }
    }
}

fn has_bold_style(style: &str) -> bool {
    css_value(style, "font-weight").is_some_and(|value| {
        matches!(value.to_ascii_lowercase().as_str(), "bold" | "bolder")
            || value.parse::<u16>().is_ok_and(|weight| weight >= 600)
    })
}

fn has_red_style(style: &str) -> bool {
    css_value(style, "color").is_some_and(|value| {
        matches!(
            value
                .chars()
                .filter(|character| !character.is_ascii_whitespace())
                .collect::<String>()
                .to_ascii_lowercase()
                .as_str(),
            "red" | "#f00" | "#ff0000" | "rgb(255,0,0)" | "rgba(255,0,0,1)"
        )
    })
}

fn text_length(value: &str) -> usize {
    value
        .chars()
        .filter(|character| !character.is_whitespace())
        .count()
}

fn nearest_text_block<'a>(node: NodeRef<'a>) -> Option<NodeRef<'a>> {
    node.ancestors_it(None)
        .find(|ancestor| {
            ancestor.node_name().is_some_and(|name| {
                matches!(
                    name.as_ref(),
                    "p" | "li" | "blockquote" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6"
                )
            })
        })
        .or_else(|| node.parent().filter(NodeRef::is_element))
}

fn primary_heading(value: &str) -> bool {
    let value = value.trim_start();
    [
        "一、", "二、", "三、", "四、", "五、", "六、", "七、", "八、", "九、", "十、",
    ]
    .iter()
    .any(|prefix| value.starts_with(prefix))
        || value.split_once(['、', '.']).is_some_and(|(number, _)| {
            !number.is_empty() && number.chars().all(|c| c.is_ascii_digit())
        })
}

fn secondary_heading(value: &str) -> bool {
    let value = value.trim_start();
    [
        "（一）",
        "（二）",
        "（三）",
        "（四）",
        "（五）",
        "(一)",
        "(二)",
        "(三)",
        "(四)",
        "(五)",
    ]
    .iter()
    .any(|prefix| value.starts_with(prefix))
        || value.split_whitespace().next().is_some_and(|token| {
            let mut parts = token.trim_end_matches(['.', '、']).split('.');
            parts.clone().count() >= 2
                && parts.all(|part| {
                    !part.is_empty() && part.chars().all(|character| character.is_ascii_digit())
                })
        })
}

fn normalize_weixin_semantics(document: &Document) {
    for heading in document.select("#js_content h1").nodes() {
        heading.rename("h2");
    }
    for node in document
        .select("#js_content span[style], #js_content strong, #js_content b")
        .nodes()
    {
        let name = node.node_name().unwrap_or_default();
        let style = node.attr("style").unwrap_or_default();
        let semantic_bold = matches!(name.as_ref(), "strong" | "b");
        let emphasis_candidate = semantic_bold || has_bold_style(&style) || has_red_style(&style);
        if !emphasis_candidate {
            continue;
        }
        let text = node.text();
        let candidate_length = text_length(&text);
        let Some(block) = nearest_text_block(*node) else {
            continue;
        };
        let block_text = block.text();
        let block_length = text_length(&block_text);
        if candidate_length == 0 || block_length == 0 {
            continue;
        }
        let coverage = candidate_length.saturating_mul(100) / block_length;
        let block_name = block.node_name().unwrap_or_default();
        let heading_level = if coverage >= 85 && candidate_length <= 64 {
            if secondary_heading(&block_text) {
                Some("h3")
            } else if primary_heading(&block_text) {
                Some("h2")
            } else {
                None
            }
        } else {
            None
        };
        if let Some(level) = heading_level {
            block.rename(level);
            node.rename("span");
        } else if matches!(block_name.as_ref(), "h1" | "h2" | "h3" | "h4" | "h5" | "h6")
            || (coverage >= 85 && candidate_length > 80)
        {
            node.rename("span");
        } else {
            node.rename("strong");
        }
        node.remove_attr("style");
    }
    for nested in document.select("#js_content strong strong").nodes() {
        nested.rename("span");
    }
}

fn restore_numeric_heading_markers(markdown: &str) -> String {
    markdown
        .lines()
        .map(|line| {
            let Some((prefix, text)) = ["## ", "### "]
                .into_iter()
                .find_map(|prefix| line.strip_prefix(prefix).map(|text| (prefix, text)))
            else {
                return line.to_owned();
            };
            let digits = text.bytes().take_while(u8::is_ascii_digit).count();
            let (number, suffix) = text.split_at(digits);
            for escaped in [r"\\.", r"\."] {
                if !number.is_empty() {
                    if let Some(rest) = suffix.strip_prefix(escaped) {
                        return format!("{prefix}{number}.{rest}");
                    }
                }
            }
            line.to_owned()
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[derive(Default)]
struct HtmlPreflightState {
    elements: usize,
    open_tags: Vec<LocalName>,
    depth_exceeded: bool,
}

#[derive(Default)]
struct HtmlPreflight(RefCell<HtmlPreflightState>);

fn is_void_html_element(name: &LocalName) -> bool {
    matches!(
        name.as_ref(),
        "area"
            | "base"
            | "br"
            | "col"
            | "embed"
            | "hr"
            | "img"
            | "input"
            | "link"
            | "meta"
            | "param"
            | "source"
            | "track"
            | "wbr"
    )
}

impl TokenSink for HtmlPreflight {
    type Handle = ();

    fn process_token(&self, token: Token, _: u64) -> TokenSinkResult<Self::Handle> {
        if let Token::TagToken(tag) = token {
            let mut state = self.0.borrow_mut();
            match tag.kind {
                StartTag => {
                    state.elements = state.elements.saturating_add(1);
                    // HTML ignores the self-closing flag on non-void elements, so `<div/>`
                    // still increases the DOM depth constructed by html5ever.
                    if !is_void_html_element(&tag.name) {
                        state.open_tags.push(tag.name);
                        state.depth_exceeded |= state.open_tags.len() > MAX_HTML_NESTING_DEPTH;
                    }
                }
                EndTag => {
                    // Only a properly nested close reduces this conservative budget. This keeps
                    // malformed/raw-text end tags from hiding actual DOM nesting.
                    if state.open_tags.last() == Some(&tag.name) {
                        state.open_tags.pop();
                    }
                }
            }
        }
        TokenSinkResult::Continue
    }
}

fn inspect_html_structure(html: &str) -> HtmlPreflightState {
    let tokenizer = Tokenizer::new(HtmlPreflight::default(), TokenizerOpts::default());
    let input = BufferQueue::default();
    input.push_back(StrTendril::from(html));
    let _ = tokenizer.feed(&input);
    tokenizer.end();
    tokenizer.sink.0.into_inner()
}

fn preflight_html_elements(html: &str) -> Result<HtmlPreflightState> {
    let state = inspect_html_structure(html);
    if state.elements > MAX_HTML_ELEMENTS {
        bail!("HTML artifact exceeds element limit");
    }
    Ok(state)
}

fn preflight_html_structure(html: &str) -> Result<()> {
    let state = preflight_html_elements(html)?;
    if state.depth_exceeded {
        bail!("HTML artifact exceeds nesting depth limit");
    }
    Ok(())
}

fn verify_dom_depth(document: &Document) -> Result<()> {
    let mut pending = vec![(document.root(), 0usize)];
    while let Some((node, depth)) = pending.pop() {
        if depth > MAX_HTML_NESTING_DEPTH {
            bail!("HTML artifact exceeds normalized DOM nesting depth limit");
        }
        pending.extend(
            node.children_it(false)
                .map(|child| (child, depth.saturating_add(1))),
        );
    }
    Ok(())
}

/// Title, Markdown, whether comments were removed, and the Web V1 structure
/// when `structured` was requested.
fn extract_html(blob: &VerifiedBlob, source_url: &str, structured: bool) -> Result<(String, String, bool, Option<web::WebExtraction>)> {
    if blob.bytes.len() > MAX_HTML_BYTES {
        bail!("HTML artifact exceeds extraction size limit");
    }
    let html = blob_text(blob)?;
    let Ok(base_url) = Url::parse(source_url) else {
        bail!("HTML source URL must be an absolute credential-free http or https URL");
    };
    if !matches!(base_url.scheme(), "http" | "https")
        || base_url.host_str().is_none()
        || !base_url.username().is_empty()
        || base_url.password().is_some()
    {
        bail!("HTML source URL must be an absolute credential-free http or https URL");
    }
    // Only explicit Web V1 requests change conversion semantics. Replaying an
    // old capture must retain its original draft and extractor version.
    if structured {
        // Same preflight, depth check and comment removal as below, on its own parse.
        let (extracted, comments_removed) = web::extract_webpage_with_comments(source_url, html)?;
        return Ok((extracted.title.clone(), extracted.markdown.clone(), comments_removed, Some(extracted)));
    }
    preflight_html_structure(html)?;
    let document = Document::from(html);
    verify_dom_depth(&document)?;
    let comments_removed = comments::remove_comments(&document);
    let config = Config {
        max_elements_to_parse: MAX_HTML_ELEMENTS,
        ..Default::default()
    };
    // An untouched parse is exactly what `Readability::new(html)` would build.
    // After comment removal, keep the historical serialize-and-reparse view so
    // replayed drafts stay byte-identical.
    let readability = if comments_removed {
        Readability::new(document.html().to_string(), Some(source_url), Some(config))
    } else {
        Readability::with_document(document, Some(source_url), Some(config))
    };
    let mut readability = readability.context("initialize webpage readability extraction")?;
    let article = readability
        .parse()
        .context("extract readable webpage content")?;
    if article.length == 0 || article.text_content.trim().is_empty() {
        bail!("webpage extraction produced no readable content");
    }

    let mut sanitizer = Builder::default();
    sanitizer.url_schemes(HashSet::from(["http", "https"]));
    sanitizer.url_relative(UrlRelative::RewriteWithBase(base_url));
    let safe_html = sanitizer.clean(article.content.as_ref()).to_string();
    let markdown = HtmlToMarkdown::new()
        .convert(&safe_html)
        .context("convert readable webpage content to markdown")?;
    Ok((
        article.title,
        canonical_markdown(markdown)?,
        comments_removed,
        None,
    ))
}

impl Extractor for GenericWebpageExtractor {
    fn id(&self) -> &'static str {
        "generic.webpage"
    }

    fn version(&self) -> &'static str {
        "2"
    }

    fn extract(&self, capture: &VerifiedCapture) -> Result<ExtractedDraft> {
        let mut html_blobs = capture.blobs.iter().filter(|blob| is_html(blob));
        let html = html_blobs.next();
        if html_blobs.next().is_some() {
            bail!("capture contains multiple HTML artifacts");
        }
        let (extracted_title, mut content_markdown, comments_removed, web_structure) = match html {
            Some(blob) => {
                let structured = capture.capture.adapter_id == "memex.loopback-intake"
                    && capture.capture.adapter_version == "1-web-snapshot-v1";
                let (title, markdown, removed, web_structure) = extract_html(blob, &capture.capture.source_url, structured)?;
                (Some(title), markdown, removed, web_structure)
            }
            None => (
                None,
                capture
                    .blobs
                    .iter()
                    .filter(|blob| is_text(blob))
                    .map(blob_text)
                    .collect::<Result<Vec<_>>>()?
                    .join("\n"),
                false,
                None,
            ),
        };
        let structured = web_structure.is_some();
        let title = if html.is_some() {
            non_empty(capture.capture.title.as_deref())
                .or_else(|| non_empty(extracted_title.as_deref()))
                .unwrap_or(&capture.capture.source_url)
                .to_owned()
        } else {
            capture
                .capture
                .title
                .clone()
                .unwrap_or_else(|| capture.capture.source_url.clone())
        };

        let mut attachments = Vec::new();
        if let Some(extracted) = web_structure.filter(|_| capture.blobs.iter().any(|b| b.descriptor.media_type.starts_with("image/"))) {
            (content_markdown, attachments) = web::localize_images(
                &extracted.html, &capture.capture.source_url, &capture.blobs,
            )?;
        }
        let ratings = match html {
            Some(blob) => ratings::page_ratings(
                &capture.capture.source_url,
                blob_text(blob)?,
                &capture.capture.captured_at,
            ),
            None => Vec::new(),
        };
        Ok(ExtractedDraft {
            item_type: "webpage".into(),
            title,
            source_url: capture.capture.source_url.clone(),
            canonical_url: capture.capture.canonical_url.clone(),
            content_markdown,
            sensitivity: capture.capture.sensitivity,
            extractor_id: self.id().into(),
            extractor_version: if structured {
                "3-web-structure-v1"
            } else if comments_removed {
                "2-comments-v1"
            } else {
                self.version()
            }
            .into(),
            attachments,
            ratings,
        })
    }
}

pub struct WeixinArticleExtractor;

impl WeixinArticleExtractor {
    pub fn supports_url(value: &str) -> bool {
        let Ok(url) = Url::parse(value) else {
            return false;
        };
        let lowered = value.to_ascii_lowercase();
        if lowered.contains("%2f")
            || lowered.contains("%5c")
            || lowered.contains("%2e")
            || value.contains('\\')
            || value.contains("/./")
            || value.contains("/../")
        {
            return false;
        }
        let Some(mut segments) = url.path_segments() else {
            return false;
        };
        let article = match (segments.next(), segments.next(), segments.next()) {
            (Some("s"), Some(article), None) => article,
            _ => return false,
        };
        url.scheme() == "https"
            && url.host_str() == Some("mp.weixin.qq.com")
            && url.port().is_none()
            && url.username().is_empty()
            && url.password().is_none()
            && url.fragment().is_none()
            && !article.is_empty()
            && article
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    }
}

impl WeixinArticleExtractor {
    /// The one HTML artifact of a supported WeChat article capture, within the size limit.
    fn page_html(capture: &VerifiedCapture) -> Result<&str> {
        if !Self::supports_url(&capture.capture.source_url) {
            bail!("unsupported WeChat article URL");
        }
        let mut html_blobs = capture.blobs.iter().filter(|blob| is_html(blob));
        let blob = html_blobs
            .next()
            .ok_or_else(|| anyhow::anyhow!("capture contains no HTML artifact"))?;
        if html_blobs.next().is_some() {
            bail!("capture contains multiple HTML artifacts");
        }
        if blob.bytes.len() > MAX_HTML_BYTES {
            bail!("HTML artifact exceeds extraction size limit");
        }
        blob_text(blob)
    }

    /// The article region only: `#activity-name` (when present) and `#js_content`, wrapped in
    /// `<article>`. The page shell around them (QR login dialogs, follow and share buttons) is left
    /// out, so a caller can classify the article without the shell's controls. The caller still
    /// checks the whole page for credentials and challenges; this function does not.
    /// Every failure is `weixin_body_missing`.
    pub fn article_html(capture: &VerifiedCapture) -> Result<String> {
        Self::article_region(capture).map_err(|_| anyhow::anyhow!("weixin_body_missing"))
    }

    fn article_region(capture: &VerifiedCapture) -> Result<String> {
        let html = Self::page_html(capture)?;
        preflight_html_structure(html)?;
        let document = Document::from(html);
        verify_dom_depth(&document)?;
        let content = document.select("#js_content");
        let title = document.select("#activity-name");
        anyhow::ensure!(content.length() == 1 && title.length() <= 1, "weixin_body_missing");
        for region in [&content, &title] {
            anyhow::ensure!(region.length() == 0 || !region.text().trim().is_empty(), "weixin_body_missing");
            for node in region.nodes() {
                anyhow::ensure!(visible_in_tree(node), "weixin_body_missing");
            }
        }
        Ok(format!("<article>{}{}</article>", title.html(), content.html()))
    }
}

impl Extractor for WeixinArticleExtractor {
    fn id(&self) -> &'static str {
        "weixin.article"
    }

    fn version(&self) -> &'static str {
        "3"
    }

    fn extract(&self, capture: &VerifiedCapture) -> Result<ExtractedDraft> {
        self.extract_with(capture, false)
    }
}

impl WeixinArticleExtractor {
    /// Like `extract`, but images without a captured blob keep their original
    /// http(s) link instead of failing the article. For reading, not for a library
    /// item, which must hold every image locally.
    pub fn extract_with_remote_images(&self, capture: &VerifiedCapture) -> Result<ExtractedDraft> {
        self.extract_with(capture, true)
    }

    fn extract_with(&self, capture: &VerifiedCapture, remote_images: bool) -> Result<ExtractedDraft> {
        let html = Self::page_html(capture)?;
        preflight_html_elements(html)?;

        let base_url = Url::parse(&capture.capture.source_url)?;
        let document = Document::from(html);
        verify_dom_depth(&document)?;
        let comments_removed = comments::remove_comments(&document);
        let content = document.select("#js_content");
        if content.length() != 1 || content.text().trim().is_empty() {
            bail!("WeChat article body missing");
        }
        let mut captured_images = BTreeMap::new();
        for (index, image) in capture.blobs.iter().enumerate() {
            if is_html(image) {
                continue;
            }
            let Some(source_url) = image.descriptor.source_url.as_deref() else {
                bail!("non-HTML WeChat artifact has no source URL");
            };
            let source_url = Url::parse(source_url)
                .context("captured image source URL is invalid")?
                .to_string();
            let relative_path =
                captured_attachment_relative_path(&image.blob_id, &image.descriptor.media_type)
                    .context("captured image media type is unsupported")?;
            if captured_images
                .insert(source_url, (index, image, relative_path))
                .is_some()
            {
                bail!("duplicate captured image source URL");
            }
        }
        for image in document.select("#js_content img").nodes() {
            let src = image
                .attr("src")
                .filter(|value| !value.trim().is_empty())
                .and_then(|value| base_url.join(value.trim()).ok())
                .map(|url| url.to_string());
            let lazy = image
                .attr("data-src")
                .filter(|value| !value.trim().is_empty())
                .and_then(|value| base_url.join(value.trim()).ok())
                .map(|url| url.to_string());
            if src.as_ref().zip(lazy.as_ref()).is_some_and(|(src, lazy)| {
                src != lazy
                    && captured_images.contains_key(src)
                    && captured_images.contains_key(lazy)
            }) {
                bail!("ambiguous WeChat image source");
            }
            if let Some(preferred) = lazy.or(src) {
                image.set_attr("src", &preferred);
            }
        }
        normalize_weixin_semantics(&document);

        let extracted_title = document.select("#activity-name").text();
        let extracted_title = non_empty(Some(extracted_title.as_ref()))
            .map(str::to_owned)
            .or_else(|| {
                document
                    .select(r#"meta[property="og:title"]"#)
                    .attr("content")
                    .and_then(|value| non_empty(Some(value.as_ref())).map(str::to_owned))
            });
        let mut sanitizer = Builder::default();
        sanitizer.url_schemes(HashSet::from(["http", "https"]));
        sanitizer.url_relative(UrlRelative::RewriteWithBase(base_url.clone()));
        let safe_html = sanitizer.clean(content.html().as_ref()).to_string();
        let safe_document = Document::from(safe_html.as_str());
        let mut used_images = BTreeSet::new();
        let mut attached_blobs = BTreeSet::new();
        let mut attachments = Vec::new();
        for image in safe_document.select("img").nodes() {
            let source = image
                .attr("src")
                .filter(|value| !value.trim().is_empty())
                .context("WeChat article image has no safe source")?;
            let source = base_url
                .join(source.trim())
                .context("WeChat article image source is invalid")?
                .to_string();
            let Some((index, blob, relative_path)) = captured_images.get(&source) else {
                if remote_images {
                    image.set_attr("src", &source);
                    continue;
                }
                bail!("WeChat article image was not captured");
            };
            image.set_attr("src", relative_path);
            used_images.insert(*index);
            // Distinct CDN URLs can serve identical bytes. Keep both source
            // occurrences as Evidence, but install that content-addressed
            // attachment only once; every image occurrence still points to it.
            if attached_blobs.insert(&blob.blob_id) {
                let title = image
                    .attr("alt")
                    .and_then(|value| non_empty(Some(value.as_ref())).map(str::to_owned));
                if title.as_ref().is_some_and(|value| value.len() > 4096) {
                    bail!("captured image title is too long");
                }
                attachments.push(DraftAttachmentRef::Captured {
                    blob_index: u32::try_from(*index).context("captured image index overflow")?,
                    blob_id: blob.blob_id.clone(),
                    title,
                });
            }
        }
        if used_images.len() != captured_images.len() {
            bail!("capture contains unused WeChat images");
        }
        attachments.sort();
        let localized_html = safe_document.select("body").html().to_string();
        let markdown = HtmlToMarkdown::new()
            .convert(&localized_html)
            .context("convert WeChat article content to markdown")?;
        let content_markdown = canonical_markdown(restore_numeric_heading_markers(&markdown))?;
        let title = non_empty(capture.capture.title.as_deref())
            .or_else(|| non_empty(extracted_title.as_deref()))
            .unwrap_or(&capture.capture.source_url)
            .to_owned();

        Ok(ExtractedDraft {
            item_type: "webpage".into(),
            title,
            source_url: capture.capture.source_url.clone(),
            canonical_url: capture.capture.canonical_url.clone(),
            content_markdown,
            sensitivity: capture.capture.sensitivity,
            extractor_id: self.id().into(),
            extractor_version: if comments_removed {
                "3-comments-v1"
            } else {
                self.version()
            }
            .into(),
            attachments,
            ratings: Vec::new(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use lots_scout_types::{
        BlobDescriptor, CaptureEnvelope, Sensitivity, SourceProfile, VerifiedBlob, SCHEMA_VERSION,
    };

    fn capture(media_type: &str, bodies: &[&str], title: Option<&str>) -> VerifiedCapture {
        let blobs = bodies
            .iter()
            .enumerate()
            .map(|(index, body)| VerifiedBlob {
                descriptor: BlobDescriptor {
                    schema_version: SCHEMA_VERSION,
                    locator: format!("artifacts/{index}"),
                    media_type: media_type.into(),
                    byte_size: body.len() as u64,
                    sha256: format!("{:064x}", index + 1),
                    source_url: None,
                },
                blob_id: format!("sha256:{:064x}", index + 1),
                source_backend_ref: Some(format!("synthetic:{index}")),
                bytes: body.as_bytes().to_vec(),
            })
            .collect();
        VerifiedCapture {
            source: SourceProfile {
                schema_version: SCHEMA_VERSION,
                source_id: "source_test".into(),
                name: "Synthetic".into(),
                source_kind: "web".into(),
                canonical_uris: vec![],
                evidence_roles: vec![],
                default_sensitivity: Sensitivity::Internal,
                preferred_extractor: Some("generic.webpage".into()),
            },
            capture: CaptureEnvelope {
                schema_version: SCHEMA_VERSION,
                adapter_id: "synthetic".into(),
                adapter_version: "1".into(),
                external_capture_id: "capture_test".into(),
                source_id: "source_test".into(),
                captured_at: "2026-08-09T00:00:00Z".into(),
                capture_method: "fixture".into(),
                sensitivity: Sensitivity::Internal,
                route_summary: None,
                title: title.map(str::to_owned),
                source_url: "https://example.test/articles/rust".into(),
                canonical_url: None,
                artifacts: vec![],
            },
            blobs,
        }
    }

    fn readable_html(inner: &str) -> String {
        format!("<article><h1>Links</h1><p>This article contains enough readable prose for deterministic extraction and URL normalization in the focused synthetic test.</p>{inner}</article>")
    }

    fn add_png(capture: &mut VerifiedCapture, source_url: &str) {
        let digest = "4c4b6a3be1314ab86138bef4314dde022e600960d8689a2c8f8631802d20dab6";
        capture.blobs.push(VerifiedBlob {
            descriptor: BlobDescriptor {
                schema_version: SCHEMA_VERSION,
                locator: "artifacts/image-0".into(),
                media_type: "image/png".into(),
                byte_size: 8,
                sha256: digest.into(),
                source_url: Some(source_url.into()),
            },
            blob_id: format!("sha256:{digest}"),
            source_backend_ref: None,
            bytes: b"\x89PNG\r\n\x1a\n".to_vec(),
        });
    }

    #[test]
    fn extracts_clean_deterministic_cjk_markdown() {
        let html = r#"<!doctype html>
<html lang="zh-CN"><head>
<title>页面噪声标题</title>
<meta property="og:title" content="结构化资料进入 AI 时代">
</head><body>
<nav>不应进入正文的导航</nav>
<main><article>
<h1>结构化资料进入 AI 时代</h1>
<p>这是供人类和 AI 阅读的中文正文，包含足够长的文字来通过正文识别。本文继续说明资料应该保持稳定、清晰并且可以引用。</p>
<h2>能力</h2>
<ul><li>确定性 Markdown</li><li>可追溯来源</li></ul>
<p><a href="../sources">来源链接</a></p>
<figure><img src="/images/diagram.png" alt="系统结构图"><figcaption>图一</figcaption></figure>
<table><thead><tr><th>层</th><th>职责</th></tr></thead><tbody><tr><td>Rust</td><td>规范化</td></tr></tbody></table>
<pre><code>let corpus = "markdown";</code></pre>
<p><a href="javascript:alert(1)" onclick="steal()">危险链接</a></p>
</article></main>
<aside>不应进入正文的推荐内容</aside>
<script>script_sentinel = "must-not-leak"</script>
</body></html>"#;
        let capture = capture("Text/HTML; charset=utf-8", &[html], None);
        let first = GenericWebpageExtractor.extract(&capture).unwrap();
        let replay = GenericWebpageExtractor.extract(&capture).unwrap();

        assert_eq!(first, replay);
        assert_eq!(first.title, "结构化资料进入 AI 时代");
        assert_eq!(first.extractor_version, "2");
        assert!(first.content_markdown.ends_with('\n'));
        assert!(first
            .content_markdown
            .contains("这是供人类和 AI 阅读的中文正文"));
        assert!(first.content_markdown.contains("## 能力"));
        assert!(first.content_markdown.contains("确定性 Markdown"));
        assert!(first
            .content_markdown
            .contains("https://example.test/sources"));
        assert!(first
            .content_markdown
            .contains("https://example.test/images/diagram.png"));
        assert!(first.content_markdown.contains("系统结构图"));
        assert!(first.content_markdown.contains("| Rust"));
        assert!(first
            .content_markdown
            .contains("let corpus = \"markdown\";"));
        for forbidden in [
            "不应进入正文的导航",
            "不应进入正文的推荐内容",
            "must-not-leak",
            "javascript:",
            "onclick",
        ] {
            assert!(
                !first.content_markdown.contains(forbidden),
                "leaked {forbidden}"
            );
        }
    }

    #[test]
    fn capture_title_wins_over_extracted_title() {
        let html = "<article><h1>Extracted</h1><p>This article has enough readable content to produce a deterministic Markdown document for the synthetic test.</p></article>";
        let draft = GenericWebpageExtractor
            .extract(&capture("text/html", &[html], Some("Capture title")))
            .unwrap();
        assert_eq!(draft.title, "Capture title");
    }

    #[test]
    fn rewrites_relative_urls_and_removes_non_http_urls() {
        let html = readable_html(
            "<p><a href='/root'>root</a> <a href='../parent'>parent</a> <a href='//cdn.example.test/protocol'>protocol</a> <a href='#part'>fragment</a> <a href='mailto:a@example.test'>mail anchor</a></p><img src='mailto:image@example.test' alt='mail image'>",
        );
        let markdown = GenericWebpageExtractor
            .extract(&capture("text/html", &[&html], None))
            .unwrap()
            .content_markdown;
        for expected in [
            "https://example.test/root",
            "https://example.test/parent",
            "https://cdn.example.test/protocol",
            "https://example.test/articles/rust#part",
        ] {
            assert!(
                markdown.contains(expected),
                "missing {expected}: {markdown}"
            );
        }
        assert!(!markdown.contains("mailto:"));
        assert!(!markdown.contains("mail image"));
    }

    #[test]
    fn rejects_unsafe_html_source_urls_but_not_plaintext_source_url() {
        let html = readable_html("<p>body</p>");
        for source_url in [
            "file:///synthetic/article",
            "relative/article",
            "https://synthetic-user@example.test/article",
        ] {
            let mut html_capture = capture("text/html", &[&html], None);
            html_capture.capture.source_url = source_url.into();
            assert_eq!(
                GenericWebpageExtractor
                    .extract(&html_capture)
                    .unwrap_err()
                    .to_string(),
                "HTML source URL must be an absolute credential-free http or https URL"
            );
        }

        let mut text_capture = capture("text/plain", &["body"], None);
        text_capture.capture.source_url = "legacy:not-a-web-url".into();
        assert_eq!(
            GenericWebpageExtractor
                .extract(&text_capture)
                .unwrap()
                .title,
            "legacy:not-a-web-url"
        );
    }

    #[test]
    fn rejects_more_than_element_limit_before_dom_construction() {
        let html = "<i>".repeat(MAX_HTML_ELEMENTS + 1);
        assert!(html.len() < MAX_HTML_BYTES);
        assert_eq!(
            GenericWebpageExtractor
                .extract(&capture("text/html", &[&html], None))
                .unwrap_err()
                .to_string(),
            "HTML artifact exceeds element limit"
        );
    }

    #[test]
    fn rejects_excessive_nesting_before_dom_construction() {
        for html in [
            format!(
                "{}<p>This nested article has enough readable text, but its explicit nesting depth must be rejected before constructing a recursive DOM walker.</p>{}",
                "<div>".repeat(MAX_HTML_NESTING_DEPTH + 1),
                "</div>".repeat(MAX_HTML_NESTING_DEPTH + 1)
            ),
            "<div/>".repeat(MAX_HTML_NESTING_DEPTH + 1),
            format!(
                "{}<script>{}</script>{}",
                "<div>".repeat(200),
                "</div>".repeat(200),
                "<div>".repeat(100)
            ),
        ] {
            assert!(html.len() < MAX_HTML_BYTES);
            assert_eq!(
                GenericWebpageExtractor
                    .extract(&capture("text/html", &[&html], None))
                    .unwrap_err()
                    .to_string(),
                "HTML artifact exceeds nesting depth limit"
            );
        }
    }

    #[test]
    fn symmetric_equal_score_fixture_is_exactly_deterministic() {
        let prose = "Equal length readable prose repeated to give both symmetric article candidates the same readability score and stable document ordering.";
        let html = format!(
            "<main><article><h2>First</h2><p>{prose}</p></article><article><h2>Second</h2><p>{prose}</p></article></main>"
        );
        let capture = capture("text/html", &[&html], None);
        let expected = GenericWebpageExtractor
            .extract(&capture)
            .unwrap()
            .content_markdown;
        for _ in 0..20 {
            assert_eq!(
                GenericWebpageExtractor
                    .extract(&capture)
                    .unwrap()
                    .content_markdown,
                expected
            );
        }
    }

    #[test]
    fn rejects_multiple_html_artifacts() {
        let error = GenericWebpageExtractor
            .extract(&capture("text/html", &["<p>one</p>", "<p>two</p>"], None))
            .unwrap_err();
        assert_eq!(
            error.to_string(),
            "capture contains multiple HTML artifacts"
        );
    }

    #[test]
    fn rejects_oversized_html_before_parsing() {
        let body = "x".repeat(MAX_HTML_BYTES + 1);
        let error = GenericWebpageExtractor
            .extract(&capture("text/html", &[&body], None))
            .unwrap_err();
        assert_eq!(
            error.to_string(),
            "HTML artifact exceeds extraction size limit"
        );
    }

    #[test]
    fn rejects_html_without_readable_content() {
        let error = GenericWebpageExtractor
            .extract(&capture(
                "text/html",
                &["<html><head><title>Empty</title></head><body><script>only_script()</script></body></html>"],
                None,
            ))
            .unwrap_err();
        assert_eq!(error.to_string(), "extract readable webpage content");
        assert!(error
            .chain()
            .any(|cause| cause.to_string().contains("failed to grab the article")));
    }

    #[test]
    fn preserves_plaintext_behavior() {
        let draft = GenericWebpageExtractor
            .extract(&capture("text/plain", &["first", "second"], None))
            .unwrap();
        assert_eq!(draft.title, "https://example.test/articles/rust");
        assert_eq!(draft.content_markdown, "first\nsecond");
    }

    #[test]
    fn preserves_empty_and_whitespace_plaintext_titles_verbatim() {
        for title in ["", "  \t "] {
            let draft = GenericWebpageExtractor
                .extract(&capture("text/plain", &["body"], Some(title)))
                .unwrap();
            assert_eq!(draft.title, title);
        }
    }

    #[test]
    fn extracts_weixin_article_body_and_lazy_images() {
        let html = r#"<!doctype html><html><head>
<meta property="og:title" content="Fallback title">
</head><body>
<h1 id="activity-name">微信资料进入 Markdown</h1>
<nav>WEIXIN_NAV_SENTINEL</nav>
<section id="js_content">
<p>这是一段供人类与 AI 阅读的微信公众号正文，应该被稳定提取为 Markdown。</p>
<img data-src="/media/diagram.png" alt="资料流图">
<a href="javascript:alert(1)" onclick="steal()">危险链接</a>
<script>WEIXIN_SCRIPT_SENTINEL</script>
</section>
</body></html>"#;
        let mut capture = capture("text/html", &[html], None);
        capture.capture.source_url = "https://mp.weixin.qq.com/s/synthetic-article".into();
        capture.capture.canonical_url = Some(capture.capture.source_url.clone());
        add_png(&mut capture, "https://mp.weixin.qq.com/media/diagram.png");

        let first = WeixinArticleExtractor.extract(&capture).unwrap();
        let replay = WeixinArticleExtractor.extract(&capture).unwrap();
        assert_eq!(first, replay);
        assert_eq!(first.title, "微信资料进入 Markdown");
        assert_eq!(first.extractor_id, "weixin.article");
        assert_eq!(first.extractor_version, "3");
        assert!(first.content_markdown.contains("微信公众号正文"));
        assert!(first
            .content_markdown
            .contains("![资料流图](attachments/sha256-4c4b6a3be1314ab86138bef4314dde022e600960d8689a2c8f8631802d20dab6.png)"));
        assert_eq!(first.attachments.len(), 1);
        for forbidden in [
            "WEIXIN_NAV_SENTINEL",
            "WEIXIN_SCRIPT_SENTINEL",
            "javascript:",
            "onclick",
        ] {
            assert!(!first.content_markdown.contains(forbidden));
        }
    }

    #[test]
    fn weixin_image_occurrences_reject_ambiguity_and_unused_inputs_but_reuse_one_capture() {
        let ambiguous_html = r#"<html><body><section id="js_content">
<p>这是用于图片 occurrence 歧义验证的合成正文。</p>
<img src="/media/source.png" data-src="/media/lazy.png">
</section></body></html>"#;
        let mut ambiguous = capture("text/html", &[ambiguous_html], None);
        ambiguous.capture.source_url = "https://mp.weixin.qq.com/s/ambiguous-images".into();
        add_png(&mut ambiguous, "https://mp.weixin.qq.com/media/source.png");
        add_png(&mut ambiguous, "https://mp.weixin.qq.com/media/lazy.png");
        assert_eq!(
            WeixinArticleExtractor
                .extract(&ambiguous)
                .unwrap_err()
                .to_string(),
            "ambiguous WeChat image source"
        );

        let unused_html = r#"<html><body><section id="js_content">
<p>这是用于图片 unused capture 验证的合成正文。</p>
<img src="/media/used.png">
</section></body></html>"#;
        let mut unused = capture("text/html", &[unused_html], None);
        unused.capture.source_url = "https://mp.weixin.qq.com/s/unused-image".into();
        add_png(&mut unused, "https://mp.weixin.qq.com/media/used.png");
        add_png(&mut unused, "https://mp.weixin.qq.com/media/unused.png");
        assert_eq!(
            WeixinArticleExtractor
                .extract(&unused)
                .unwrap_err()
                .to_string(),
            "capture contains unused WeChat images"
        );

        let repeated_html = r#"<html><body><section id="js_content">
<p>这是用于同一图片重复出现验证的合成正文。</p>
<img src="/media/repeated.png" alt="first">
<img src="/media/repeated.png" alt="second">
</section></body></html>"#;
        let mut repeated = capture("text/html", &[repeated_html], None);
        repeated.capture.source_url = "https://mp.weixin.qq.com/s/repeated-image".into();
        add_png(&mut repeated, "https://mp.weixin.qq.com/media/repeated.png");
        let draft = WeixinArticleExtractor.extract(&repeated).unwrap();
        let path = "attachments/sha256-4c4b6a3be1314ab86138bef4314dde022e600960d8689a2c8f8631802d20dab6.png";
        assert_eq!(draft.content_markdown.matches(path).count(), 2);
        assert_eq!(draft.attachments.len(), 1);
    }

    #[test]
    fn normalizes_weixin_headings_and_selective_emphasis() {
        let long_decoration = "整段装饰性粗体".repeat(14);
        let html = format!(
            r#"<!doctype html><html><body>
<h1 id="activity-name">语义结构演习</h1>
<section id="js_content">
<h1>原有正文标题</h1>
<p><span style="color: rgb(255, 0, 0); font-weight: bold">一、主要章节</span></p>
<p>普通正文中的<span style="font-weight: 700">真正关键词</span>应当保留强调。</p>
<p><span style="color:#ff0000;font-weight:bold">（一）下级章节</span></p>
<p><strong>1. Numeric primary</strong></p>
<p><strong>1.2 Numeric secondary</strong></p>
<p><span style="font-weight:bold">{long_decoration}</span></p>
</section></body></html>"#
        );
        let mut capture = capture("text/html", &[&html], None);
        capture.capture.source_url = "https://mp.weixin.qq.com/s/semantic-structure".into();

        let first = WeixinArticleExtractor.extract(&capture).unwrap();
        let replay = WeixinArticleExtractor.extract(&capture).unwrap();
        assert_eq!(first, replay);
        assert!(first.content_markdown.contains("## 原有正文标题"));
        assert!(first.content_markdown.contains("## 一、主要章节"));
        assert!(first.content_markdown.contains("### （一）下级章节"));
        assert!(first.content_markdown.contains("## 1. Numeric primary"));
        assert!(first.content_markdown.contains("### 1.2 Numeric secondary"));
        assert!(first.content_markdown.contains("**真正关键词**"));
        assert!(first.content_markdown.contains(&long_decoration));
        assert!(!first
            .content_markdown
            .contains(&format!("**{long_decoration}**")));
    }

    #[test]
    fn weixin_article_html_keeps_title_and_body_but_not_the_login_shell() {
        let body = "公众号长文正文。".repeat(400);
        let html = format!(r#"<html><body>
<div class="qrcode_dialog" style="display:none"><p>微信扫一扫</p><img src="https://mp.weixin.qq.com/qrcode.png"></div>
<button>关注</button><button>分享</button>
<h1 id="activity-name">正文标题</h1>
<section id="js_content"><p>{body}</p></section>
</body></html>"#);
        let weixin = |html: &str| {
            let mut c = capture("text/html", &[html], None);
            c.capture.source_url = "https://mp.weixin.qq.com/s/synthetic-article".into();
            c
        };
        let region = WeixinArticleExtractor::article_html(&weixin(&html)).unwrap();
        assert!(region.starts_with("<article>") && region.contains("正文标题") && region.contains(&body));
        assert!(region.contains(r#"id="js_content""#));
        for shell in ["qrcode", "<button", "扫一扫"] {
            assert!(!region.contains(shell), "{shell} leaked into the article region");
        }

        let hidden = html.replace(r#"<section id="js_content">"#, r#"<section id="js_content" style="visibility: hidden">"#);
        let hidden_parent = html.replace(r#"<section id="js_content">"#, r#"<div hidden><section id="js_content">"#);
        let no_body = html.replace("js_content", "other");
        let empty_title = html.replace("正文标题", " ");
        for bad in [hidden, hidden_parent, no_body, empty_title] {
            let error = WeixinArticleExtractor::article_html(&weixin(&bad)).unwrap_err();
            assert_eq!(error.to_string(), "weixin_body_missing");
        }
        let mut elsewhere = weixin(&html);
        elsewhere.capture.source_url = "https://example.com/s/synthetic-article".into();
        assert!(WeixinArticleExtractor::article_html(&elsewhere).is_err());
    }

    #[test]
    fn weixin_extractor_matches_exact_public_article_origin_and_fails_closed() {
        for supported in [
            "https://mp.weixin.qq.com/s/abc",
            "https://mp.weixin.qq.com/s/abc?scene=1",
        ] {
            assert!(WeixinArticleExtractor::supports_url(supported));
        }
        for unsupported in [
            "http://mp.weixin.qq.com/s/abc",
            "https://mp.weixin.qq.com:444/s/abc",
            "https://mp.weixin.qq.com/s/",
            "https://mp.weixin.qq.com/s/abc/",
            "https://mp.weixin.qq.com/s/abc/def",
            "https://mp.weixin.qq.com/s//abc",
            "https://mp.weixin.qq.com/s/abc%2Fdef",
            "https://mp.weixin.qq.com/s/abc%5Cdef",
            "https://mp.weixin.qq.com/s/abc#fragment",
            "https://mp.weixin.qq.com/s/abc\\def",
            "https://mp.weixin.qq.com/s/abc/../def",
            "https://mp.weixin.qq.com/s/%2e%2e/def",
            "https://mp.weixin.qq.com.evil.invalid/s/abc",
            "https://user@mp.weixin.qq.com/s/abc",
            "https://mp.weixin.qq.com/mp/profile_ext?action=home",
        ] {
            assert!(!WeixinArticleExtractor::supports_url(unsupported));
        }

        let mut blocked = capture(
            "text/html",
            &["<html><body><h1>环境异常</h1><p>完成验证后即可访问。</p></body></html>"],
            None,
        );
        blocked.capture.source_url = "https://mp.weixin.qq.com/s/blocked".into();
        assert_eq!(
            WeixinArticleExtractor
                .extract(&blocked)
                .unwrap_err()
                .to_string(),
            "WeChat article body missing"
        );
    }

    #[test]
    fn weixin_checks_normalized_dom_depth_without_relaxing_generic_preflight() {
        let html = format!(
            "<html><body>{}<section id='js_content'><p>Normalized WeChat body.</p></section></body></html>",
            "<p>outer shell".repeat(MAX_HTML_NESTING_DEPTH + 1)
        );
        let mut normalized_capture = capture("text/html", &[&html], None);
        normalized_capture.capture.source_url =
            "https://mp.weixin.qq.com/s/normalized-shell".into();
        assert_eq!(
            GenericWebpageExtractor
                .extract(&normalized_capture)
                .unwrap_err()
                .to_string(),
            "HTML artifact exceeds nesting depth limit"
        );
        assert!(WeixinArticleExtractor
            .extract(&normalized_capture)
            .unwrap()
            .content_markdown
            .contains("Normalized WeChat body."));

        let genuinely_deep = format!(
            "<html><body><section id='js_content'>{}<p>Too deep.</p>{}</section></body></html>",
            "<div>".repeat(MAX_HTML_NESTING_DEPTH + 1),
            "</div>".repeat(MAX_HTML_NESTING_DEPTH + 1)
        );
        let mut capture = capture("text/html", &[&genuinely_deep], None);
        capture.capture.source_url = "https://mp.weixin.qq.com/s/genuinely-deep".into();
        assert_eq!(
            WeixinArticleExtractor
                .extract(&capture)
                .unwrap_err()
                .to_string(),
            "HTML artifact exceeds normalized DOM nesting depth limit"
        );
    }
}
