//! Deterministic public episode body extraction; raw HTML remains Evidence.
use super::*;

pub struct AmpPodcastExtractor;

impl AmpPodcastExtractor {
    fn episode_url(value: &str) -> bool {
        let Some(path) = value.strip_prefix("https://ampcode.com/podcast/") else { return false; };
        let number = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()) && s.parse::<u32>().is_ok_and(|n| n > 0);
        if let Some(episode) = path.strip_prefix("episode-") { return number(episode); }
        let Some((season, episode)) = path.strip_prefix("season-").and_then(|s| s.split_once("/episode-")) else { return false; };
        number(season) && number(episode)
    }

    pub fn supports(capture: &VerifiedCapture) -> bool {
        Self::episode_url(&capture.capture.source_url)
            && capture.blobs.first().is_some_and(|b| is_html(b)
                && b.bytes.len() <= MAX_HTML_BYTES
                && blob_text(b).is_ok_and(|html| Document::from(html).select(".transcript").length() > 0))
    }

    /// Admission inspects the ENTIRE main region before extraction crops the
    /// transcript, so ancestor attributes and adjacent gate notices survive.
    pub fn article_html(capture: &VerifiedCapture) -> Result<String> {
        anyhow::ensure!(Self::supports(capture), "invalid_podcast_article");
        let html = blob_text(&capture.blobs[0])?;
        preflight_html_structure(html)?;
        let doc = Document::from(html);
        verify_dom_depth(&doc)?;
        anyhow::ensure!(doc.select("main").length() == 1
            && doc.select(".transcript").length() == 1
            && doc.select("main .transcript").length() == 1
            && doc.select("main h1").length() == 1
            && doc.select("form,input,[contenteditable=true]").length() == 0,
            "invalid_podcast_article");
        let heading = doc.select("main h1");
        let body = doc.select("main .transcript");
        anyhow::ensure!(!heading.text().trim().is_empty() && !body.text().trim().is_empty(), "invalid_podcast_article");
        for node in heading.nodes().iter().chain(body.nodes()) {
            for ancestor in std::iter::once(*node).chain(node.ancestors_it(None)) {
                let style = ancestor.attr("style").unwrap_or_default();
                anyhow::ensure!(ancestor.attr("hidden").is_none()
                    && !ancestor.attr("aria-hidden").is_some_and(|v| v.eq_ignore_ascii_case("true"))
                    && !css_value(&style, "display").is_some_and(|v| v.eq_ignore_ascii_case("none"))
                    && !css_value(&style, "visibility").is_some_and(|v| v.eq_ignore_ascii_case("hidden")),
                    "invalid_podcast_article");
            }
        }
        Ok(format!("<article>{}</article>", doc.select("main").html()))
    }
}

impl Extractor for AmpPodcastExtractor {
    fn id(&self) -> &'static str { "ampcode.podcast" }
    fn version(&self) -> &'static str { "1" }
    fn extract(&self, capture: &VerifiedCapture) -> Result<ExtractedDraft> {
        let html = Self::article_html(capture)?;
        let doc = Document::from(html.as_str());
        let mut sanitizer = Builder::default();
        sanitizer.url_schemes(HashSet::from(["http", "https"]));
        sanitizer.url_relative(UrlRelative::RewriteWithBase(Url::parse(&capture.capture.source_url)?));
        let body = format!("{}{}", doc.select("main h1").html(), doc.select("main .transcript").html());
        let markdown = HtmlToMarkdown::new().convert(&sanitizer.clean(&body).to_string())?;
        Ok(ExtractedDraft {
            item_type: "webpage".into(), title: doc.select("h1").text().trim().to_owned(),
            source_url: capture.capture.source_url.clone(), canonical_url: Some(capture.capture.source_url.clone()),
            content_markdown: canonical_markdown(markdown)?, sensitivity: capture.capture.sensitivity,
            extractor_id: self.id().into(), extractor_version: self.version().into(),
            attachments: Vec::new(),
            ratings: Vec::new(),
        })
    }
}
