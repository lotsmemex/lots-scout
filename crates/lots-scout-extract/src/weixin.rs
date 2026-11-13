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
        if html.len() > MAX_HTML_BYTES {
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
            let url = base.join(raw.trim())?.to_string();
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
            if let Some(raw) = node.attr("content").filter(|v| !v.trim().is_empty()) {
                covers.insert(base.join(raw.trim())?.to_string());
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
}
