//! Bounded, network-free webpage structure and Markdown shared by capture and CLI.
use super::*;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebHeading {
    pub level: u8,
    pub id: Option<String>,
    pub text: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebMedia {
    pub url: String,
    pub poster: Option<String>,
    pub caption: String,
    pub source_url: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebTable {
    pub rows: usize,
    pub columns: usize,
    pub partial: bool,
    pub complex: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebOccurrence {
    pub href: String,
    pub text: String,
    pub role: String,
    pub heading: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebReference {
    pub url: String,
    pub occurrences: Vec<WebOccurrence>,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct WebMetadata {
    pub authors: Vec<String>,
    pub published_raw: Option<String>,
    pub modified_raw: Option<String>,
    pub section: Option<String>,
    pub site_name: Option<String>,
}
#[derive(Debug, Clone, Serialize)]
pub struct WebExtraction {
    pub schema_version: u32,
    pub source_url: String,
    pub title: String,
    pub metadata: WebMetadata,
    pub headings: Vec<WebHeading>,
    pub media: Vec<WebMedia>,
    pub tables: Vec<WebTable>,
    pub references: Vec<WebReference>,
    /// Inert snapshot evidence, not an instruction or an override of parsed body structure.
    pub snapshot_structure: Option<serde_json::Value>,
    pub markdown: String,
    /// Safe static fallback for complex tables; never contains site scripts.
    pub html: String,
}

fn clean(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(4096).collect()
}
fn escape(value: &str) -> String {
    value.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

/// Images are already verified bytes, never fetched here. Only images present
/// in the sanitized article can be installed as reader attachments.
pub(crate) fn localize_images(html: &str, source_url: &str, blobs: &[VerifiedBlob]) -> Result<(String, Vec<DraftAttachmentRef>)> {
    let base = Url::parse(source_url)?;
    let document = Document::from(html);
    let mut images = BTreeMap::new();
    for (index, blob) in blobs.iter().enumerate().filter(|(_, b)| b.descriptor.media_type.starts_with("image/")) {
        let url = blob.descriptor.source_url.as_deref().and_then(|s| web_url(&base, s)).context("captured_image_source_missing")?;
        let path = captured_attachment_relative_path(&blob.blob_id, &blob.descriptor.media_type).context("unsupported_captured_image")?;
        anyhow::ensure!(images.insert(url, (index, blob, path)).is_none(), "duplicate_captured_image_source");
    }
    let mut used = BTreeSet::new();
    let mut installed = BTreeSet::new();
    let mut attachments = Vec::new();
    for node in document.select("img[src]").nodes() {
        let Some(url) = node.attr("src").and_then(|s| web_url(&base, &s)) else { continue; };
        if let Some((index, blob, path)) = images.get(&url) {
            node.set_attr("src", path);
            used.insert(url);
            if installed.insert(&blob.blob_id) {
                attachments.push(DraftAttachmentRef::Captured { blob_index: *index as u32, blob_id: blob.blob_id.clone(), title: node.attr("alt").map(|v| clean(&v)).filter(|s| !s.is_empty()) });
            }
        }
    }
    anyhow::ensure!(used.len() == images.len(), "capture_contains_unused_images");
    let markdown = canonical_markdown(HtmlToMarkdown::new().convert(&document.html())?)?;
    Ok((markdown, attachments))
}

fn web_url(base: &Url, value: &str) -> Option<String> {
    let url = base.join(value.trim()).ok()?;
    (value.len() <= 4096 && matches!(url.scheme(), "http" | "https") && url.host_str().is_some()
        && url.username().is_empty() && url.password().is_none()).then(|| url.to_string())
}

/// Candidate identity only: retain semantic queries, scheme, host and path distinctions.
pub fn web_page_identity(value: &str) -> Result<String> {
    let mut url = Url::parse(value)?;
    anyhow::ensure!(matches!(url.scheme(), "http" | "https") && url.host_str().is_some()
        && url.username().is_empty() && url.password().is_none(), "invalid_web_url");
    url.set_fragment(None);
    let pairs: Vec<_> = url.query_pairs().filter(|(key, _)| {
        let key = key.to_ascii_lowercase();
        !key.starts_with("utm_") && !matches!(key.as_str(), "fbclid" | "gclid" | "msclkid")
    }).map(|(key, value)| (key.into_owned(), value.into_owned())).collect();
    if pairs.is_empty() { url.set_query(None); }
    else { url.query_pairs_mut().clear().extend_pairs(pairs); }
    Ok(url.to_string())
}

fn metadata(document: &Document, base: &Url) -> WebMetadata {
    let meta = |selector: &str| document.select(selector).attr("content").map(|v| clean(&v)).filter(|s| !s.is_empty());
    let mut result = WebMetadata {
        authors: document.select("meta[name='author'],meta[name='citation_author']").nodes().iter()
            .filter_map(|n| n.attr("content")).map(|s| clean(&s)).filter(|s| !s.is_empty()).take(32).collect(),
        published_raw: meta("meta[property='article:published_time'],meta[itemprop='datePublished']"),
        modified_raw: meta("meta[property='article:modified_time']"),
        section: meta("meta[property='article:section']"),
        site_name: meta("meta[property='og:site_name']"),
    };
    let mut articles = Vec::new();
    for node in document.select("script[type='application/ld+json']").nodes().iter().take(16) {
        let raw = node.text();
        if raw.len() > 256 * 1024 { continue; }
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) {
            let mut pending = vec![value];
            let mut visited = 0;
            while let Some(node) = pending.pop() {
                visited += 1;
                if visited > 64 { break; }
                if let Some(nodes) = node.as_array() { pending.extend(nodes.iter().take(64).cloned()); continue; }
                if let Some(nodes) = node["@graph"].as_array() { pending.extend(nodes.iter().take(64).cloned()); }
                let kind = node["@type"].as_str().unwrap_or("");
                if matches!(kind, "Article" | "BlogPosting" | "NewsArticle" | "TechArticle" | "PodcastEpisode") { articles.push(node); }
            }
        }
    }
    let page = web_page_identity(base.as_str()).ok();
    let bound = articles.iter().find(|node| [node["url"].as_str(), node["mainEntityOfPage"].as_str(), node["mainEntityOfPage"]["@id"].as_str(), node["@id"].as_str()]
        .into_iter().flatten().any(|value| web_url(base, value).and_then(|url| web_page_identity(&url).ok()) == page))
        .or_else(|| (articles.len() == 1 && articles[0]["url"].is_null() && articles[0]["mainEntityOfPage"].is_null()).then(|| &articles[0]));
    if let Some(node) = bound {
        for (field, key) in [(&mut result.published_raw, "datePublished"), (&mut result.modified_raw, "dateModified"), (&mut result.section, "articleSection")] {
            if field.is_none() { *field = node[key].as_str().map(clean); }
        }
        let authors: Vec<_> = node["author"].as_array().cloned().unwrap_or_else(|| vec![node["author"].clone()]);
        for author in authors.into_iter().take(32) {
            if let Some(name) = author.as_str().or_else(|| author["name"].as_str()).map(clean).filter(|s| !s.is_empty()) {
                if !result.authors.contains(&name) { result.authors.push(name); }
            }
        }
    }
    result
}

/// Reads supplied HTML only. No fetching, JavaScript, expansion, pagination or credential access.
pub fn extract_webpage(source_url: &str, html: &str) -> Result<WebExtraction> {
    anyhow::ensure!(html.len() <= MAX_HTML_BYTES, "webpage_size_limit");
    let base = Url::parse(source_url)?;
    anyhow::ensure!(web_url(&base, source_url).is_some(), "invalid_web_url");
    preflight_html_structure(html)?;
    let document = Document::from(html);
    verify_dom_depth(&document)?;
    let metadata = metadata(&document, &base);
    let snapshot_structure = document.select("meta[name='memex:web-structure']").attr("content")
        .filter(|value| value.len() <= 256 * 1024)
        .and_then(|value| serde_json::from_str::<serde_json::Value>(&value).ok())
        .filter(|value| value["schema_version"] == 1);
    comments::remove_comments(&document);
    for node in document.select("script,style,noscript,form,input,textarea,select,button,iframe,object,embed,[contenteditable]").nodes() { node.remove_from_parent(); }
    let mut candidates = Vec::new();
    for selector in ["article,[role=article]", "[itemprop=articleBody],.prose,.entry-content,.post-content", "main,[role=main]"] {
        let selected = document.select(selector);
        let ids: HashSet<_> = selected.nodes().iter().map(|n| n.id).collect();
        candidates = selected.nodes().iter().filter(|n| !n.ancestors_it(None).any(|p| ids.contains(&p.id))).copied().collect();
        if !candidates.is_empty() { break; }
    }
    anyhow::ensure!(!candidates.is_empty() && candidates.len() <= 64, "article_not_found");
    candidates.sort_by_key(|n| std::cmp::Reverse(n.text().trim().len()));
    let root = candidates[0];
    let score = root.text().trim().len();
    anyhow::ensure!(score >= 100 && candidates.get(1).is_none_or(|n| score >= n.text().trim().len().saturating_mul(2)), "article_not_found");
    let body = Document::from(root.html().as_ref());
    let title = document.select("meta[property='og:title']").attr("content").map(|v| clean(&v))
        .or_else(|| non_empty(Some(document.select("h1").text().as_ref())).map(str::to_owned))
        .unwrap_or_else(|| clean(document.select("title").text().as_ref()));
    let headings = body.select("h1,h2,h3,h4,h5,h6").nodes().iter().take(512).map(|n| WebHeading {
        level: n.node_name().and_then(|s| s.chars().nth(1)).and_then(|c| c.to_digit(10)).unwrap_or(2) as u8,
        id: n.attr("id").map(|v| clean(&v)).filter(|s| !s.is_empty()), text: clean(&n.text()),
    }).collect();
    let tables = body.select("table,[role=grid]").nodes().iter().take(64).map(|node| {
        let table = Document::from(node.html().as_ref());
        let rows = table.select("tr,[role=row]");
        let columns = rows.nodes().iter().map(|r| dom_query::Selection::from(*r).select("th,td,[role=gridcell],[role=columnheader],[role=rowheader]").length()).max().unwrap_or(0);
        WebTable { rows: rows.length(), columns, partial: node.attr("role").is_some_and(|v| v.as_ref() == "grid") || node.attr("aria-rowcount").and_then(|v| v.parse::<usize>().ok()).is_some_and(|n| n > rows.length()),
            complex: table.select("[rowspan]:not([rowspan='1']),[colspan]:not([colspan='1'])").length() > 0 }
    }).collect();
    // ARIA grids are only a snapshot of the rows already rendered. Never run
    // site controls or imply virtualized/offscreen data was captured.
    for grid in body.select("[role=grid]").nodes().iter().take(64) {
        let selected = dom_query::Selection::from(*grid);
        let mut table = String::from("<p>Table snapshot: visible loaded rows only; interactive or virtualized data may be incomplete.</p><table>");
        for row in selected.select("[role=row]").nodes() {
            table.push_str("<tr>");
            for cell in dom_query::Selection::from(*row).select("[role=gridcell],[role=columnheader],[role=rowheader]").nodes() {
                let tag = if cell.attr("role").is_some_and(|role| role.as_ref() == "gridcell") { "td" } else { "th" };
                table.push_str(&format!("<{tag}>{}</{tag}>", cell.inner_html()));
            }
            table.push_str("</tr>");
        }
        table.push_str("</table>");
        grid.replace_with_html(table);
    }
    let mut references: Vec<WebReference> = Vec::new();
    let mut heading = None;
    let mut learn_more = false;
    for (doc, related) in [(&body, false), (&document, true)] {
        for node in doc.select(if related { "#feed a[href],.related-posts a[href],[aria-label='Related posts'] a[href]" } else { "h1,h2,h3,h4,h5,h6,a[href]" }).nodes().iter().take(5000) {
            if node.node_name().is_some_and(|name| name.as_ref() != "a") {
                let text = clean(&node.text());
                learn_more = text.to_lowercase().starts_with("learn more");
                heading = Some(text); continue;
            }
            let Some(href) = node.attr("href").and_then(|v| web_url(&base, &v)) else { continue; };
            let identity = web_page_identity(&href)?;
            if identity == web_page_identity(source_url)? { continue; }
            let occurrence = WebOccurrence { href, text: clean(&node.text()), role: if related { "related" } else if learn_more { "learn_more" } else { "citation" }.into(), heading: if related { None } else { heading.clone() } };
            if let Some(reference) = references.iter_mut().find(|r| r.url == identity) { reference.occurrences.push(occurrence); }
            else if references.len() < 600 { references.push(WebReference { url: identity, occurrences: vec![occurrence] }); }
        }
    }
    let mut media = Vec::new();
    for video in body.select("video").nodes().iter().take(16) {
        let video_doc = Document::from(video.html().as_ref());
        let Some(url) = video.attr("src").or_else(|| video_doc.select("source[src]").attr("src")).and_then(|v| web_url(&base, &v)) else { continue; };
        let figure = video.ancestors_it(None).find(|n| n.node_name().is_some_and(|name| name.as_ref() == "figure"));
        let caption = figure.map(|f| Document::from(f.html().as_ref()).select("figcaption").text().to_string())
            .filter(|s| !s.trim().is_empty()).or_else(|| video.attr("aria-label").map(|v| v.to_string())).unwrap_or_else(|| "Video".into());
        let poster = video.attr("poster").and_then(|v| web_url(&base, &v));
        let mut target = base.clone();
        if let Some(id) = video.attr("id").or_else(|| figure.and_then(|f| f.attr("id"))) { target.set_fragment(Some(&id)); }
        let image = poster.as_ref().map(|p| format!("<img src=\"{}\" alt=\"{}\">", escape(p), escape(&caption))).unwrap_or_default();
        video.replace_with_html(format!("<p><a href=\"{}\">{}Video: {}</a></p>", escape(target.as_str()), image, escape(&caption)));
        media.push(WebMedia { url, poster, caption: clean(&caption), source_url: target.to_string() });
    }
    // Syntax highlighters often emit <pre><span> instead of <pre><code>.
    // Normalize text, not rendered whitespace, before Markdown conversion.
    for pre in body.select("pre").nodes() {
        let selected = dom_query::Selection::from(*pre);
        let class = selected.select("code[class]").attr("class");
        let mut language = class.as_deref().and_then(|classes| classes.split_whitespace().find_map(|c| c.strip_prefix("language-"))).map(str::to_owned);
        if language.is_none() {
            if let Some(container) = pre.ancestors_it(None).find(|n| n.has_class("art-code")) {
                language = Some(Document::from(container.html().as_ref()).select(".lang").text().trim().to_ascii_lowercase());
            }
        }
        let language = language.filter(|s| !s.is_empty() && s.len() <= 32 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b"_+.-".contains(&b)));
        let class = language.map(|s| format!(" class=\"language-{}\"", escape(&s))).unwrap_or_default();
        pre.replace_with_html(format!("<pre><code{class}>{}</code></pre>", escape(&pre.text())));
    }
    for header in body.select(".art-code > .ch").nodes() { header.remove_from_parent(); }
    let mut sanitizer = Builder::default();
    sanitizer.url_schemes(HashSet::from(["http", "https"]));
    sanitizer.add_tag_attributes("code", &["class"]);
    sanitizer.url_relative(UrlRelative::RewriteWithBase(base));
    let safe_html = sanitizer.clean(&body.html()).to_string();
    let markdown = canonical_markdown(HtmlToMarkdown::new().convert(&safe_html)?)?;
    Ok(WebExtraction { schema_version: 1, source_url: source_url.into(), title, metadata, headings, media, tables, references, snapshot_structure, markdown, html: safe_html })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn prose_keeps_media_structure_and_reference_occurrences_without_inventing_timezones() {
        let html = format!(r##"<meta property="article:published_time" content="2026-11-09"><meta property="article:modified_time" content="2026-11-10T04:00:00-08:00">
          <h1>Build models</h1><div class="prose"><h2 id="models">Models</h2><p>{}</p>
          <a href="https://other.test/agent?mode=fast&utm_source=blog#loop">Inline</a>
          <figure id="demo"><video src="/demo.mp4" poster="/demo.jpg"></video><figcaption>Demo A</figcaption></figure>
          <table><tr><th>A</th><th>B</th><th>C</th></tr><tr><td>1</td><td>2</td><td>3</td></tr></table>
          <h3>Learn more</h3><a href="https://other.test/agent?mode=fast#cost">Learn</a>
          <p>Use <code>run()</code>.</p><pre><code>  x = 1;\n  y = 2;</code></pre></div>
          <div id="feed"><a href="/related">Related</a></div><footer>FOOTER_SENTINEL</footer>"##, "Readable prose. ".repeat(20));
        let result = extract_webpage("https://example.test/article", &html).unwrap();
        assert_eq!(result.metadata.published_raw.as_deref(), Some("2026-11-09"));
        assert_eq!(result.headings[0].id.as_deref(), Some("models"));
        assert_eq!((result.tables[0].rows, result.tables[0].columns), (2, 3));
        assert_eq!(result.media[0].poster.as_deref(), Some("https://example.test/demo.jpg"));
        assert_eq!(result.references[0].url, "https://other.test/agent?mode=fast");
        assert_eq!(result.references[0].occurrences.len(), 2);
        assert_eq!(result.references[0].occurrences[1].role, "learn_more");
        assert_eq!(result.references[1].occurrences[0].role, "related");
        assert!(result.markdown.contains("demo.jpg"));
        assert!(result.markdown.contains("`run()`"));
        assert!(!result.markdown.contains("FOOTER_SENTINEL"));
        assert!(!result.html.contains("<video"));
        assert_ne!(web_page_identity("https://www.example.test/A/?a=1").unwrap(), web_page_identity("http://example.test/A?a=1").unwrap());
    }

    #[test]
    fn virtualized_grid_captures_only_rendered_cells_with_an_explicit_partial_warning() {
        let html = format!(r#"<article><h2>Visible data</h2><p>{}</p>
          <div role="grid" aria-rowcount="1000"><div role="row"><span role="columnheader">Model</span><span role="columnheader">Cost</span></div>
          <div role="row"><span role="gridcell"><a href="/opus">Opus</a></span><span role="gridcell"><code>7.25</code></span></div></div>
          <script>HIDDEN_DATA</script><button>Next page</button></article>"#, "Readable context. ".repeat(20));
        let result = extract_webpage("https://example.test/article", &html).unwrap();
        assert_eq!((result.tables[0].rows, result.tables[0].columns), (2, 2));
        assert!(result.tables[0].partial);
        assert!(result.markdown.contains("visible loaded rows only"));
        assert!(result.markdown.contains("[Opus](https://example.test/opus)"));
        assert!(result.markdown.contains("`7.25`"));
        assert!(!result.html.contains("HIDDEN_DATA"));
        assert!(!result.html.contains("Next page"));
    }

    #[test]
    fn highlighted_pre_without_code_preserves_fence_language_and_indentation() {
        let html = format!("<article><p>{}</p><div class=\"art-code\"><div class=\"ch\">CODE<span class=\"lang\">Markdown</span></div><pre><span>  first\n</span><span>    second</span></pre></div></article>", "Readable context. ".repeat(20));
        let result = extract_webpage("https://example.test/article", &html).unwrap();
        assert!(result.markdown.contains("```markdown\n  first\n    second\n```"), "{}", result.markdown);
        assert!(!result.markdown.contains("CODEMarkdown"));
    }
}
