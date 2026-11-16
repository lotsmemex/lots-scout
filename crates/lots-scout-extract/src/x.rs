//! X (Twitter) posts, long-form X Articles and their replies, read from the public FxTwitter
//! API (`api.fxtwitter.com`, the open-source FixTweet service). No login, cookies or X API key.
//!
//! These are pure functions: the caller does the HTTP request (`x_conversation_url`), passes the
//! response body to `parse_x_conversation`, follows `next_cursor` for more replies if it wants
//! them, and renders the result with `render_x_markdown`.

use anyhow::{bail, Context, Result};
use serde_json::Value;
use std::collections::HashMap;
use url::Url;

pub const FXTWITTER_API: &str = "https://api.fxtwitter.com";
/// Largest API response accepted.
pub const MAX_X_JSON_BYTES: usize = 8 * 1024 * 1024;
const MAX_TEXT_BYTES: usize = 256 * 1024;
const MAX_REPLIES_PER_PAGE: usize = 200;
const MAX_ARTICLE_BLOCKS: usize = 4096;
const HOSTS: [&str; 9] = [
    "x.com", "www.x.com", "mobile.x.com", "twitter.com", "www.twitter.com", "mobile.twitter.com",
    "fxtwitter.com", "vxtwitter.com", "fixupx.com",
];

/// The numeric post ID in an X link (`x.com/<user>/status/<id>`, `x.com/i/status/<id>`,
/// `x.com/<user>/article/<id>`, also twitter.com and fx/vx mirrors), or in text containing one.
/// `x.com/i/article/<id>` is not accepted: that ID belongs to the article, not to the post.
pub fn x_status_id(input: &str) -> Option<String> {
    for (start, _) in input.match_indices("https://").chain(input.match_indices("http://")) {
        let link: String = input[start..]
            .chars()
            .take_while(|c| !c.is_whitespace() && !"\"'<>)）】，。".contains(*c))
            .collect();
        if let Some(id) = status_id_of(&link) {
            return Some(id);
        }
    }
    None
}

fn status_id_of(link: &str) -> Option<String> {
    let url = Url::parse(link).ok()?;
    if !matches!(url.scheme(), "https" | "http") || !url.username().is_empty() || url.password().is_some() {
        return None;
    }
    if !HOSTS.contains(&url.host_str()?.to_ascii_lowercase().as_str()) {
        return None;
    }
    let segments: Vec<&str> = url.path_segments()?.filter(|s| !s.is_empty()).collect();
    let id = match segments.as_slice() {
        ["i", "status", id, ..] | ["i", "web", "status", id, ..] => id,
        [user, "status" | "statuses", id, ..] if *user != "i" => id,
        [user, "article", id, ..] if *user != "i" => id,
        _ => return None,
    };
    (!id.is_empty() && id.len() <= 20 && id.bytes().all(|b| b.is_ascii_digit())).then(|| id.to_string())
}

/// The API address for one post with its thread and replies; `cursor` asks for the next page.
pub fn x_conversation_url(status_id: &str, cursor: Option<&str>) -> String {
    let mut url = Url::parse(FXTWITTER_API).expect("constant URL");
    url.set_path(&format!("/2/conversation/{status_id}"));
    if let Some(cursor) = cursor {
        url.query_pairs_mut().append_pair("cursor", cursor);
    }
    url.to_string()
}

#[derive(Debug, Clone, PartialEq)]
pub struct XMedia {
    /// `photo`, `video` or `gif`.
    pub kind: String,
    pub url: String,
    pub thumbnail: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct XArticle {
    pub title: String,
    pub cover: Option<String>,
    /// The article body as Markdown, without its title.
    pub markdown: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct XPost {
    pub id: String,
    pub url: String,
    pub author_handle: String,
    pub author_name: String,
    /// RFC3339 UTC.
    pub created_at: Option<String>,
    pub text: String,
    pub likes: u64,
    pub reposts: u64,
    pub replies: u64,
    pub views: Option<u64>,
    pub replying_to_status: Option<String>,
    pub media: Vec<XMedia>,
    pub quote: Option<Box<XPost>>,
    pub article: Option<XArticle>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct XConversation {
    pub status: XPost,
    /// The author's own follow-up posts, oldest first, without `status`.
    pub thread: Vec<XPost>,
    pub replies: Vec<XPost>,
    /// Pass to `x_conversation_url` for the next page of replies.
    pub next_cursor: Option<String>,
}

/// Parses one `/2/conversation/<id>` response.
pub fn parse_x_conversation(json: &str) -> Result<XConversation> {
    anyhow::ensure!(json.len() <= MAX_X_JSON_BYTES, "x_response_too_large");
    let root: Value = serde_json::from_str(json).context("x_response_invalid")?;
    match root.get("code").and_then(Value::as_u64) {
        Some(200) | None => {}
        Some(404) => bail!("x_post_unavailable"),
        Some(401 | 403) => bail!("x_post_private"),
        Some(_) => bail!("x_response_error"),
    }
    let status = post(root.get("status").context("x_post_unavailable")?, 0)?;
    let thread = items(&root, "thread")
        .filter_map(|v| post(v, 0).ok())
        .filter(|p| p.id != status.id)
        .collect();
    let replies = items(&root, "replies")
        .take(MAX_REPLIES_PER_PAGE)
        .filter_map(|v| post(v, 0).ok())
        .collect();
    let next_cursor = root
        .pointer("/cursor/bottom")
        .and_then(Value::as_str)
        .filter(|c| !c.is_empty() && c.len() <= 1024)
        .map(str::to_owned);
    Ok(XConversation { status, thread, replies, next_cursor })
}

fn items<'a>(root: &'a Value, key: &str) -> impl Iterator<Item = &'a Value> {
    root.get(key).and_then(Value::as_array).into_iter().flatten()
}

fn text_of(v: &Value, key: &str) -> String {
    let s = v.get(key).and_then(Value::as_str).unwrap_or_default();
    let mut end = s.len().min(MAX_TEXT_BYTES);
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    s[..end].to_owned()
}

fn count(v: &Value, key: &str) -> u64 {
    v.get(key).and_then(Value::as_u64).unwrap_or(0)
}

fn post(v: &Value, depth: usize) -> Result<XPost> {
    let id = text_of(v, "id");
    anyhow::ensure!(!id.is_empty() && id.bytes().all(|b| b.is_ascii_digit()), "x_post_invalid");
    let author = v.get("author").unwrap_or(&Value::Null);
    let handle = text_of(author, "screen_name");
    let created_at = v
        .get("created_timestamp")
        .and_then(Value::as_i64)
        .and_then(|s| chrono::DateTime::from_timestamp(s, 0))
        .map(|t| t.format("%Y-%m-%dT%H:%M:%SZ").to_string());
    let quote = match v.get("quote") {
        Some(q) if q.is_object() && depth == 0 => post(q, 1).ok().map(Box::new),
        _ => None,
    };
    Ok(XPost {
        url: format!("https://x.com/{}/status/{id}", if handle.is_empty() { "i" } else { &handle }),
        id,
        author_name: text_of(author, "name"),
        author_handle: handle,
        created_at,
        text: text_of(v, "text"),
        likes: count(v, "likes"),
        reposts: count(v, "reposts"),
        replies: count(v, "replies"),
        views: v.get("views").and_then(Value::as_u64),
        replying_to_status: v.get("replying_to_status").and_then(Value::as_str).map(str::to_owned),
        media: media(v.get("media").unwrap_or(&Value::Null)),
        quote,
        article: v.get("article").filter(|a| a.is_object()).map(article),
    })
}

fn media(m: &Value) -> Vec<XMedia> {
    let all: Vec<&Value> = match m.get("all").and_then(Value::as_array) {
        Some(all) => all.iter().collect(),
        None => items(m, "photos").chain(items(m, "videos")).collect(),
    };
    all.into_iter()
        .take(16)
        .filter_map(|item| {
            let url = item.get("url").and_then(Value::as_str).filter(|u| u.starts_with("https://"))?;
            let kind = match item.get("type").and_then(Value::as_str) {
                Some("video") => "video",
                Some("gif") => "gif",
                _ => "photo",
            };
            Some(XMedia {
                kind: kind.into(),
                url: url.into(),
                thumbnail: item
                    .get("thumbnail_url")
                    .and_then(Value::as_str)
                    .filter(|u| u.starts_with("https://"))
                    .map(str::to_owned),
            })
        })
        .collect()
}

/// One inline span of a Draft.js block: bold, italic and link apply to the whole run.
#[derive(Clone, Default, PartialEq)]
struct Style {
    bold: bool,
    italic: bool,
    link: Option<String>,
}

fn article(a: &Value) -> XArticle {
    // Media and entities are looked up by ID; `entityMap` is an array of {key, value} here, an
    // object keyed by entity key in plain Draft.js.
    let mut media_urls: HashMap<String, (String, Option<String>)> = HashMap::new();
    for m in items(a, "media_entities") {
        let Some(id) = m.get("media_id").and_then(Value::as_str) else { continue };
        let info = m.get("media_info").unwrap_or(&Value::Null);
        let image = info
            .get("original_img_url")
            .or_else(|| info.pointer("/preview_image/original_img_url"))
            .and_then(Value::as_str)
            .map(str::to_owned);
        let video = items(info, "variants")
            .filter(|v| v.get("content_type").and_then(Value::as_str) == Some("video/mp4"))
            .max_by_key(|v| v.get("bit_rate").and_then(Value::as_u64).unwrap_or(0))
            .and_then(|v| v.get("url").and_then(Value::as_str))
            .map(str::to_owned);
        match (video, image) {
            (Some(video), image) => media_urls.insert(id.into(), (video, image)),
            (None, Some(image)) => media_urls.insert(id.into(), (image, None)),
            (None, None) => None,
        };
    }
    let content = a.get("content").unwrap_or(&Value::Null);
    let entities: HashMap<String, &Value> = match content.get("entityMap") {
        Some(Value::Array(list)) => list
            .iter()
            .filter_map(|e| Some((key_string(e.get("key")?)?, e.get("value")?)))
            .collect(),
        Some(Value::Object(map)) => map.iter().map(|(k, v)| (k.clone(), v)).collect(),
        _ => HashMap::new(),
    };
    let mut out: Vec<String> = Vec::new();
    let mut previous_list = false;
    for block in items(content, "blocks").take(MAX_ARTICLE_BLOCKS) {
        let kind = block.get("type").and_then(Value::as_str).unwrap_or("unstyled");
        let text = text_of(block, "text");
        let line = match kind {
            "atomic" => atomic(block, &entities, &media_urls),
            _ => {
                let inline = inline_markdown(&text, block, &entities);
                if inline.trim().is_empty() {
                    None
                } else {
                    let depth = block.get("depth").and_then(Value::as_u64).unwrap_or(0).min(4) as usize;
                    Some(match kind {
                        "header-one" | "header-two" => format!("## {}", inline.trim()),
                        "header-three" | "header-four" | "header-five" | "header-six" => {
                            format!("### {}", inline.trim())
                        }
                        "unordered-list-item" => format!("{}- {}", "  ".repeat(depth), inline.trim()),
                        "ordered-list-item" => format!("{}1. {}", "  ".repeat(depth), inline.trim()),
                        "blockquote" => format!("> {}", inline.trim()),
                        "code-block" => format!("```\n{text}\n```"),
                        _ => inline.trim().to_owned(),
                    })
                }
            }
        };
        let Some(line) = line else { continue };
        let is_list = matches!(kind, "unordered-list-item" | "ordered-list-item");
        if is_list && previous_list {
            if let Some(last) = out.last_mut() {
                last.push('\n');
                last.push_str(&line);
            }
        } else {
            out.push(line);
        }
        previous_list = is_list;
    }
    XArticle {
        title: text_of(a, "title").trim().to_owned(),
        cover: a
            .pointer("/cover_media/media_info/original_img_url")
            .and_then(Value::as_str)
            .map(str::to_owned),
        markdown: out.join("\n\n"),
    }
}

fn key_string(v: &Value) -> Option<String> {
    match v {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

fn atomic(
    block: &Value,
    entities: &HashMap<String, &Value>,
    media_urls: &HashMap<String, (String, Option<String>)>,
) -> Option<String> {
    let key = key_string(block.pointer("/entityRanges/0/key")?)?;
    let entity = entities.get(&key)?;
    let data = entity.get("data").unwrap_or(&Value::Null);
    let caption = data.get("caption").and_then(Value::as_str).unwrap_or("").trim().replace(['[', ']'], "");
    match entity.get("type").and_then(Value::as_str)? {
        "MEDIA" => {
            let lines: Vec<String> = items(data, "mediaItems")
                .filter_map(|m| media_urls.get(m.get("mediaId").and_then(Value::as_str)?))
                .map(|(url, poster)| match poster {
                    Some(poster) => format!("[![{caption}]({poster})]({url})"),
                    None => format!("![{caption}]({url})"),
                })
                .collect();
            if lines.is_empty() {
                return None;
            }
            let mut md = lines.join("\n\n");
            if !caption.is_empty() {
                md.push_str(&format!("\n\n*{caption}*"));
            }
            Some(md)
        }
        "TWEET" => {
            let id = data.get("tweetId").and_then(Value::as_str)?;
            id.bytes().all(|b| b.is_ascii_digit()).then(|| format!("> https://x.com/i/status/{id}"))
        }
        "DIVIDER" => Some("---".into()),
        _ => None,
    }
}

/// Applies Draft.js inline styles and links. Offsets count UTF-16 code units, as in JavaScript.
fn inline_markdown(text: &str, block: &Value, entities: &HashMap<String, &Value>) -> String {
    let units: Vec<u16> = text.encode_utf16().collect();
    let mut styles = vec![Style::default(); units.len()];
    let span = |r: &Value| -> Option<(usize, usize)> {
        let offset = r.get("offset")?.as_u64()? as usize;
        let length = r.get("length")?.as_u64()? as usize;
        Some((offset.min(units.len()), offset.saturating_add(length).min(units.len())))
    };
    for r in items(block, "inlineStyleRanges") {
        let Some((a, b)) = span(r) else { continue };
        let style = r.get("style").and_then(Value::as_str).unwrap_or("");
        for s in &mut styles[a..b] {
            match style {
                "Bold" | "BOLD" => s.bold = true,
                "Italic" | "ITALIC" => s.italic = true,
                _ => {}
            }
        }
    }
    for r in items(block, "entityRanges") {
        let Some((a, b)) = span(r) else { continue };
        let Some(entity) = r.get("key").and_then(key_string).and_then(|k| entities.get(&k)) else { continue };
        if entity.get("type").and_then(Value::as_str) != Some("LINK") {
            continue;
        }
        let Some(url) = entity.pointer("/data/url").and_then(Value::as_str) else { continue };
        if url.starts_with("https://") || url.starts_with("http://") {
            for s in &mut styles[a..b] {
                s.link = Some(url.to_owned());
            }
        }
    }
    let mut out = String::new();
    let mut start = 0;
    while start < units.len() {
        let mut end = start + 1;
        while end < units.len() && styles[end] == styles[start] {
            end += 1;
        }
        out.push_str(&styled(&String::from_utf16_lossy(&units[start..end]), &styles[start]));
        start = end;
    }
    out
}

fn styled(run: &str, style: &Style) -> String {
    let core = run.trim();
    if core.is_empty() || *style == Style::default() {
        return run.to_owned();
    }
    let lead = &run[..run.len() - run.trim_start().len()];
    let trail = &run[run.trim_end().len()..];
    let mut s = core.to_owned();
    if style.italic {
        s = format!("*{s}*");
    }
    if style.bold {
        s = format!("**{s}**");
    }
    if let Some(url) = &style.link {
        s = format!("[{s}]({url})");
    }
    format!("{lead}{s}{trail}")
}

/// A title for the post: the article title, else its first line, else the author.
pub fn x_title(post: &XPost) -> String {
    if let Some(title) = post.article.as_ref().map(|a| a.title.as_str()).filter(|t| !t.is_empty()) {
        return title.to_owned();
    }
    let first = post.text.lines().find(|l| !l.trim().is_empty()).unwrap_or("").trim();
    if first.is_empty() {
        return format!("@{} 的帖子", post.author_handle);
    }
    let short: String = first.chars().take(80).collect();
    if short.len() < first.len() { format!("{short}…") } else { short }
}

fn byline(post: &XPost) -> String {
    let mut parts = vec![if post.author_name.is_empty() {
        format!("@{}", post.author_handle)
    } else {
        format!("{}（@{}）", post.author_name, post.author_handle)
    }];
    if let Some(at) = &post.created_at {
        parts.push(at.replace('T', " ").replace('Z', " UTC"));
    }
    parts.join(" · ")
}

fn post_body(post: &XPost, out: &mut String) {
    if !post.text.trim().is_empty() {
        out.push_str(post.text.trim());
        out.push_str("\n\n");
    }
    for m in &post.media {
        match (m.kind.as_str(), &m.thumbnail) {
            ("photo", _) => out.push_str(&format!("![]({})\n\n", m.url)),
            (_, Some(thumb)) => out.push_str(&format!("[![{}]({thumb})]({})\n\n", m.kind, m.url)),
            (_, None) => out.push_str(&format!("[{}]({})\n\n", m.kind, m.url)),
        }
    }
    if let Some(q) = &post.quote {
        out.push_str(&format!("> 引用 {}：\n>\n", byline(q)));
        for line in q.text.trim().lines() {
            out.push_str(&format!("> {line}\n"));
        }
        out.push_str(&format!(">\n> {}\n\n", q.url));
    }
}

fn stats(post: &XPost) -> String {
    let mut s = format!("{} 赞 · {} 转发 · {} 回复", post.likes, post.reposts, post.replies);
    if let Some(views) = post.views {
        s.push_str(&format!(" · {views} 浏览"));
    }
    s
}

/// The whole conversation as one Markdown document: title, byline, the post (with its article),
/// the author's thread, then the replies given (pass more than `conversation.replies` after
/// following `next_cursor`).
pub fn render_x_markdown(conversation: &XConversation, replies: &[XPost]) -> String {
    let status = &conversation.status;
    let mut out = format!(
        "# {}\n\n> {} ｜ 原帖：{}\n> {}\n\n",
        x_title(status),
        byline(status),
        status.url,
        stats(status)
    );
    post_body(status, &mut out);
    if let Some(article) = &status.article {
        if let Some(cover) = &article.cover {
            out.push_str(&format!("![]({cover})\n\n"));
        }
        if !article.markdown.is_empty() {
            out.push_str(&article.markdown);
            out.push_str("\n\n");
        }
    }
    if !conversation.thread.is_empty() {
        out.push_str("## 作者续帖\n\n");
        for post in &conversation.thread {
            post_body(post, &mut out);
        }
    }
    if !replies.is_empty() {
        out.push_str(&format!("## 回复（{}）\n\n", replies.len()));
        for reply in replies {
            out.push_str(&format!("### {}\n\n", byline(reply)));
            post_body(reply, &mut out);
            out.push_str(&format!("{} ｜ {}\n\n", stats(reply), reply.url));
        }
    }
    format!("{}\n", out.trim_end())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn status_ids_come_from_post_links_only() {
        assert_eq!(x_status_id("看 https://x.com/pcstyle53/status/2122159240882110538?s=46 这条").as_deref(), Some("2122159240882110538"));
        assert_eq!(x_status_id("https://twitter.com/i/web/status/20").as_deref(), Some("20"));
        assert_eq!(x_status_id("https://x.com/u/article/123").as_deref(), Some("123"));
        assert_eq!(x_status_id("https://x.com/i/article/2122027588172263424"), None);
        assert_eq!(x_status_id("https://x.com.evil.example/u/status/1"), None);
        assert_eq!(x_status_id("https://x.com/u/status/12ab"), None);
        assert_eq!(x_status_id("https://user:pw@x.com/u/status/1"), None);
    }

    #[test]
    fn cursors_are_query_encoded() {
        assert_eq!(x_conversation_url("1", None), "https://api.fxtwitter.com/2/conversation/1");
        assert_eq!(x_conversation_url("1", Some("a+b/=")), "https://api.fxtwitter.com/2/conversation/1?cursor=a%2Bb%2F%3D");
    }

    fn author(handle: &str) -> Value {
        json!({ "screen_name": handle, "name": "Name" })
    }

    #[test]
    fn an_article_with_styles_media_lists_and_replies_renders_in_order() {
        let response = json!({
            "code": 200,
            "status": {
                "id": "100", "text": "longer answer: https://x.com/i/article/9", "author": author("alice"),
                "created_timestamp": 1794797165, "likes": 17, "reposts": 1, "replies": 2, "views": 1178,
                "media": {},
                "article": {
                    "title": "What are orbs?",
                    "cover_media": { "media_info": { "original_img_url": "https://pbs.twimg.com/media/cover.jpg" } },
                    "content": {
                        "blocks": [
                            { "type": "header-two", "text": "a computer", "inlineStyleRanges": [], "entityRanges": [] },
                            // "😀" is two UTF-16 units: the bold range starts after it.
                            { "type": "unstyled", "text": "😀 an orb is cool. rest", "inlineStyleRanges": [{ "offset": 3, "length": 15, "style": "Bold" }], "entityRanges": [{ "key": 2, "offset": 19, "length": 4 }] },
                            { "type": "unordered-list-item", "text": "one", "inlineStyleRanges": [], "entityRanges": [] },
                            { "type": "unordered-list-item", "text": "two", "inlineStyleRanges": [], "entityRanges": [] },
                            { "type": "atomic", "text": " ", "inlineStyleRanges": [], "entityRanges": [{ "key": 0, "offset": 0, "length": 1 }] },
                            { "type": "atomic", "text": " ", "inlineStyleRanges": [], "entityRanges": [{ "key": 1, "offset": 0, "length": 1 }] },
                            { "type": "unstyled", "text": "", "inlineStyleRanges": [], "entityRanges": [] }
                        ],
                        "entityMap": [
                            { "key": "0", "value": { "type": "MEDIA", "data": { "caption": "demo", "mediaItems": [{ "mediaId": "7" }] } } },
                            { "key": "1", "value": { "type": "MEDIA", "data": { "mediaItems": [{ "mediaId": "8" }] } } },
                            { "key": "2", "value": { "type": "LINK", "data": { "url": "https://example.com/r" } } }
                        ]
                    },
                    "media_entities": [
                        { "media_id": "7", "media_info": { "__typename": "ApiGif", "preview_image": { "original_img_url": "https://pbs.twimg.com/g.jpg" },
                          "variants": [{ "content_type": "video/mp4", "bit_rate": 0, "url": "https://video.twimg.com/g.mp4" }] } },
                        { "media_id": "8", "media_info": { "__typename": "ApiImage", "original_img_url": "https://pbs.twimg.com/i.png" } }
                    ]
                }
            },
            "thread": [{ "id": "100", "text": "dup", "author": author("alice") }, { "id": "101", "text": "and one more thing", "author": author("alice") }],
            "replies": [
                { "id": "200", "text": "great post", "author": author("bob"), "likes": 3,
                  "media": { "all": [{ "type": "photo", "url": "https://pbs.twimg.com/r.jpg" }] } },
                { "id": "201", "text": "javascript link", "author": author("eve"),
                  "media": { "all": [{ "type": "photo", "url": "javascript:alert(1)" }] } }
            ],
            "cursor": { "bottom": "NEXT" }
        });
        let c = parse_x_conversation(&response.to_string()).unwrap();
        assert_eq!(c.next_cursor.as_deref(), Some("NEXT"));
        assert_eq!(c.thread.len(), 1);
        let article = c.status.article.as_ref().unwrap();
        assert_eq!(
            article.markdown,
            "## a computer\n\n😀 **an orb is cool.** [rest](https://example.com/r)\n\n- one\n- two\n\n\
[![demo](https://pbs.twimg.com/g.jpg)](https://video.twimg.com/g.mp4)\n\n*demo*\n\n![](https://pbs.twimg.com/i.png)"
        );
        let md = render_x_markdown(&c, &c.replies);
        assert!(md.starts_with("# What are orbs?\n\n> Name（@alice） · 2026-11-16 02:46:05 UTC ｜ 原帖：https://x.com/alice/status/100\n> 17 赞 · 1 转发 · 2 回复 · 1178 浏览\n\n"));
        let order = ["longer answer", "cover.jpg", "## a computer", "## 作者续帖", "and one more thing", "## 回复（2）", "### Name（@bob）", "great post", "/r.jpg", "### Name（@eve）"];
        let positions: Vec<usize> = order.iter().map(|s| md.find(s).unwrap_or_else(|| panic!("missing {s}"))).collect();
        assert!(positions.windows(2).all(|w| w[0] < w[1]), "{md}");
        assert!(!md.contains("javascript:") && !md.contains("dup"));
    }

    #[test]
    fn plain_posts_take_their_first_line_as_title_and_errors_have_codes() {
        let c = parse_x_conversation(&json!({ "code": 200, "status": { "id": "5", "text": "hello world\nsecond", "author": author("a"),
            "quote": { "id": "6", "text": "quoted", "author": author("q") } } }).to_string()).unwrap();
        assert_eq!(x_title(&c.status), "hello world");
        assert!(render_x_markdown(&c, &[]).contains("> 引用 Name（@q）：\n>\n> quoted\n>\n> https://x.com/q/status/6"));
        let err = |v: Value| parse_x_conversation(&v.to_string()).unwrap_err().to_string();
        assert_eq!(err(json!({ "code": 404, "message": "NOT_FOUND" })), "x_post_unavailable");
        assert_eq!(err(json!({ "code": 401 })), "x_post_private");
        assert_eq!(parse_x_conversation("<html>").unwrap_err().to_string(), "x_response_invalid");
    }
}
