use super::*;

/// Exact references from the admitted article; no script execution or navigation fallback.
pub struct WeixinAssets {
    pub images: Vec<String>,
    pub cover_url: Option<String>,
}

impl WeixinArticleExtractor {
    /// The public verification shell is not an article and cannot be approved
    /// as a generic preview. Merely mentioning verification in an article is not a wall.
    pub fn is_verification_page(html: &str) -> bool {
        if html.len() > MAX_HTML_BYTES || preflight_html_elements(html).is_err() {
            return false;
        }
        let document = Document::from(html);
        let text = document.select("body").text();
        document.select("#js_content").length() == 0
            && document.select("#js_verify").length() > 0
            && (text.contains("环境异常") || text.contains("请完成验证"))
    }

    pub fn assets(source_url: &str, html: &str) -> Result<WeixinAssets> {
        anyhow::ensure!(Self::supports_url(source_url), "unsupported_weixin_url");
        anyhow::ensure!(html.len() <= MAX_HTML_BYTES, "HTML artifact exceeds extraction size limit");
        preflight_html_elements(html)?;
        let document = Document::from(html);
        verify_dom_depth(&document)?;
        comments::remove_comments(&document);
        let body = document.select("#js_content");
        anyhow::ensure!(
            body.length() == 1 && !body.text().trim().is_empty(),
            "weixin_body_missing"
        );
        let base = Url::parse(source_url)?;
        let mut images = Vec::new();
        for node in body.select("img").nodes() {
            let raw = node
                .attr("data-src")
                .filter(|v| !v.trim().is_empty())
                .or_else(|| node.attr("src").filter(|v| !v.trim().is_empty()))
                .context("weixin_image_missing")?;
            // Only credential-free http(s) references can become assets.
            let Some(url) = web::web_url(&base, &raw) else { continue };
            if !images.contains(&url) {
                images.push(url);
            }
            anyhow::ensure!(images.len() <= 96, "weixin_image_limit");
        }
        let mut covers = BTreeSet::new();
        for node in document
            .select("meta[property='og:image'], meta[name='og:image']")
            .nodes()
        {
            if let Some(url) = node
                .attr("content")
                .filter(|v| !v.trim().is_empty())
                .and_then(|raw| web::web_url(&base, &raw))
            {
                covers.insert(url);
            }
        }
        anyhow::ensure!(covers.len() <= 1, "weixin_cover_ambiguous");
        let cover_url = covers
            .into_iter()
            .next()
            .or_else(|| images.first().cloned());
        Ok(WeixinAssets { images, cover_url })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn article_assets_exclude_navigation_and_bind_unique_cover() {
        let html = "<meta property='og:image' content='https://mmbiz.qpic.cn/mmbiz_jpg/cover/0?wx_fmt=jpeg'>\
          <nav><img src='https://other.invalid/navigation.png'></nav><div id='js_content'>\
          <p>Question and answer</p><img src='placeholder' data-src='https://mmbiz.qpic.cn/mmbiz_png/body/0'>\
          <img data-src='https://mmbiz.qpic.cn/mmbiz_png/body/0'></div>";
        let assets =
            WeixinArticleExtractor::assets("https://mp.weixin.qq.com/s/synthetic", html).unwrap();
        assert_eq!(assets.images, ["https://mmbiz.qpic.cn/mmbiz_png/body/0"]);
        assert_eq!(
            assets.cover_url.as_deref(),
            Some("https://mmbiz.qpic.cn/mmbiz_jpg/cover/0?wx_fmt=jpeg")
        );
        assert!(WeixinArticleExtractor::assets("https://mp.weixin.qq.com/s/synthetic",
            &format!("{html}<meta property='og:image' content='https://mmbiz.qpic.cn/mmbiz_jpg/other/0'>")).is_err());
        assert!(WeixinArticleExtractor::assets(
            "https://mp.weixin.qq.com/s/synthetic",
            "<nav>no article</nav>"
        )
        .is_err());
    }

    #[test]
    fn assets_keep_only_credential_free_web_images_and_bound_input() {
        let html = "<div id='js_content'><p>Body</p><img src='javascript:alert(1)'>\
          <img src='https://user:pw@mmbiz.qpic.cn/secret/0'><img src='/mmbiz_png/ok/0'></div>";
        let assets = WeixinArticleExtractor::assets("https://mp.weixin.qq.com/s/synthetic", html).unwrap();
        assert_eq!(assets.images, ["https://mp.weixin.qq.com/mmbiz_png/ok/0"]);
        let huge = "x".repeat(MAX_HTML_BYTES + 1);
        assert!(WeixinArticleExtractor::assets("https://mp.weixin.qq.com/s/synthetic", &huge).is_err());
        assert!(!WeixinArticleExtractor::is_verification_page(&"<i>".repeat(MAX_HTML_ELEMENTS + 1)));
    }
}
