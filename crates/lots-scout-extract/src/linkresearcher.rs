//! Pure extraction of the public article representation. Acquisition belongs to
//! the source adapter; this module never makes requests or reads local files.
use super::*;
use serde::Deserialize;

pub struct LinkresearcherArticleExtractor;

fn article_id(value: &str, prefix: &str) -> Option<String> {
    let url = Url::parse(value).ok()?;
    if url.scheme() != "https"
        || url.host_str() != Some("www.linkresearcher.com")
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return None;
    }
    let id = url.path().strip_prefix(prefix)?;
    (id.len() == 36
        && id.bytes().enumerate().all(|(i, b)| {
            if matches!(i, 8 | 13 | 18 | 23) {
                b == b'-'
            } else {
                b.is_ascii_digit() || (b'a'..=b'f').contains(&b)
            }
        }))
    .then(|| id.to_owned())
}

#[derive(Deserialize)]
struct Article {
    id: String,
    title: String,
    #[serde(default)]
    content: Option<String>,
    #[serde(default, rename = "wholeHtmlContent")]
    whole_html_content: Option<String>,
}

impl LinkresearcherArticleExtractor {
    /// A deterministic public endpoint, without login, cookies or signatures.
    pub fn api_url(article_url: &str) -> Option<String> {
        article_id(article_url, "/theses/")
            .map(|id| format!("https://www.linkresearcher.com/api/theses/{id}"))
    }

    pub fn is_api_url(value: &str) -> bool {
        article_id(value, "/api/theses/").is_some()
    }

    pub fn supports(capture: &VerifiedCapture) -> bool {
        Self::api_url(&capture.capture.source_url).is_some()
            && capture.blobs.first().is_some_and(|blob| {
                base_media_type(&blob.descriptor.media_type) == "application/json"
            })
    }

    fn article(capture: &VerifiedCapture) -> Result<Article> {
        let id = article_id(&capture.capture.source_url, "/theses/")
            .context("unsupported Linkresearcher article URL")?;
        let blob = capture.blobs.first().context("missing article response")?;
        if !Self::supports(capture)
            || capture.blobs.len() != 1
            || blob.bytes.len() > MAX_HTML_BYTES
            || blob.descriptor.source_url != Self::api_url(&capture.capture.source_url)
        {
            bail!("invalid Linkresearcher article representation")
        }
        let article: Article = serde_json::from_slice(&blob.bytes)
            .context("invalid Linkresearcher article response")?;
        if article.id != id || article.title.trim().is_empty() || article.title.len() > 4096 {
            bail!("Linkresearcher article identity or title mismatch")
        }
        Ok(article)
    }

    /// Used by admission too. These are fields displayed by the site's public
    /// article component, not its abstract, recommendation list or comments.
    pub fn article_html(capture: &VerifiedCapture) -> Result<String> {
        Self::body_html(&Self::article(capture)?)
    }

    fn body_html(article: &Article) -> Result<String> {
        let body = non_empty(article.whole_html_content.as_deref())
            .or_else(|| non_empty(article.content.as_deref()))
            .context("Linkresearcher response contains no article body")?;
        preflight_html_structure(body)?;
        Ok(format!("<article>{body}</article>"))
    }
}

impl Extractor for LinkresearcherArticleExtractor {
    fn id(&self) -> &'static str {
        "linkresearcher.article"
    }
    fn version(&self) -> &'static str {
        "1"
    }
    fn extract(&self, capture: &VerifiedCapture) -> Result<ExtractedDraft> {
        let article = Self::article(capture)?;
        let html = Self::body_html(&article)?;
        let document = Document::from(html.as_str());
        verify_dom_depth(&document)?;
        comments::remove_comments(&document);
        // Some published bilingual bodies retain inert editor decorations. Strip
        // only the exact leaf controls, never an enclosing content container.
        let mut editor_decorations_removed = false;
        for node in document.select("span.custom-entry-btn[contenteditable=false],span.custom-delete-btn[contenteditable=false]").nodes() {
            if !node.children_it(false).any(|child| child.is_element())
                && matches!(node.text().trim(), "↵" | "X")
            {
                node.remove_from_parent();
                editor_decorations_removed = true;
            }
        }
        let mut sanitizer = Builder::default();
        sanitizer.url_schemes(HashSet::from(["http", "https"]));
        sanitizer.url_relative(UrlRelative::RewriteWithBase(Url::parse(
            &capture.capture.source_url,
        )?));
        let safe_html = sanitizer.clean(&document.html()).to_string();
        let markdown = HtmlToMarkdown::new().convert(&safe_html)?;
        Ok(ExtractedDraft {
            item_type: "webpage".into(),
            title: article.title.trim().to_owned(),
            source_url: capture.capture.source_url.clone(),
            canonical_url: Some(capture.capture.source_url.clone()),
            content_markdown: canonical_markdown(markdown)?,
            sensitivity: capture.capture.sensitivity,
            extractor_id: self.id().into(),
            extractor_version: if editor_decorations_removed {
                "1-editor-cleanup-v1"
            } else {
                self.version()
            }
            .into(),
            attachments: Vec::new(),
            ratings: Vec::new(),
        })
    }
}
