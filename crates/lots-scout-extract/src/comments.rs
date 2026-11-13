use super::{
    preflight_html_structure, verify_dom_depth, Builder, Document, HashSet, Result, MAX_HTML_BYTES,
};
use anyhow::bail;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CommentsState {
    Captured,
    NoneFound,
    InFrame,
    TooLarge,
}

pub struct ExtractedComments {
    pub state: CommentsState,
    pub html: Option<String>,
}

const COMMENT_CONTAINERS: &str =
    "#comments,[itemprop=comment],.comment-list,.comments-list,#js_cmt_area";

/// Remove only the extractor's DOM view; raw capture bytes remain untouched.
pub(crate) fn remove_comments(document: &Document) -> bool {
    let selected = document.select(COMMENT_CONTAINERS);
    let removed = selected.length() > 0;
    for node in selected.nodes() {
        node.remove_from_parent();
    }
    removed
}

/// Only the supplied snapshot is inspected. No frame loads, scripts or network.
pub fn extract_comments(html: &str, max_bytes: usize) -> Result<ExtractedComments> {
    if html.len() > MAX_HTML_BYTES {
        bail!("HTML artifact exceeds extraction size limit");
    }
    preflight_html_structure(html)?;
    let document = Document::from(html);
    verify_dom_depth(&document)?;
    let frame = document
        .select("#comments iframe, [itemprop=comment] iframe, #disqus_thread, iframe[src*=disqus]")
        .length()
        > 0;
    for node in document.select("script,style,form,input,select,textarea,button,iframe,object,embed,template,[contenteditable]").nodes() {
        node.remove_from_parent();
    }
    let selected = document.select(COMMENT_CONTAINERS);
    let ids: HashSet<_> = selected.nodes().iter().map(|node| node.id).collect();
    let mut parts = String::new();
    for node in selected.nodes() {
        let mut parent = node.parent();
        let mut nested = false;
        while let Some(ancestor) = parent {
            if ids.contains(&ancestor.id) {
                nested = true;
                break;
            }
            parent = ancestor.parent();
        }
        if nested || node.text().trim().is_empty() {
            continue;
        }
        let part = node.html();
        if parts.len().saturating_add(part.len()) > max_bytes {
            return Ok(ExtractedComments {
                state: CommentsState::TooLarge,
                html: None,
            });
        }
        parts.push_str(&part);
    }
    if parts.is_empty() {
        return Ok(ExtractedComments {
            state: if frame {
                CommentsState::InFrame
            } else {
                CommentsState::NoneFound
            },
            html: None,
        });
    }
    let mut sanitizer = Builder::default();
    sanitizer.url_schemes(HashSet::from(["http", "https"]));
    let safe = sanitizer.clean(&parts).to_string();
    if safe.len() > max_bytes {
        return Ok(ExtractedComments {
            state: CommentsState::TooLarge,
            html: None,
        });
    }
    Ok(ExtractedComments {
        state: CommentsState::Captured,
        html: Some(safe),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn snapshot_comments_are_bounded_inert_deduplicated_and_do_not_fetch_frames() {
        let result = extract_comments("<article>Article</article><div id=comments><div itemprop=comment onclick='act()'>独立🙂</div><script>secret</script><form>login input</form></div>", 1024).unwrap();
        assert_eq!(result.state, CommentsState::Captured);
        let html = result.html.unwrap();
        assert_eq!(html.matches("独立🙂").count(), 1);
        for absent in ["Article", "script", "onclick", "secret", "login input"] {
            assert!(!html.contains(absent));
        }
        assert_eq!(
            extract_comments(
                "<div id=comments><iframe src='https://disqus.invalid'></iframe></div>",
                1024
            )
            .unwrap()
            .state,
            CommentsState::InFrame
        );
        assert_eq!(
            extract_comments("<article>Only article</article>", 1024)
                .unwrap()
                .state,
            CommentsState::NoneFound
        );
        assert_eq!(
            extract_comments("<div id=comments>界🙂</div>", 4)
                .unwrap()
                .state,
            CommentsState::TooLarge
        );
    }
}
