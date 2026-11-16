//! Local MCP server (stdio) and CLI that read public WeChat articles and X posts into Markdown.
//!
//! It runs on the user's own machine and network: WeChat answers requests from data-centre
//! IPs with a verification page, but serves the public article to an ordinary local request.
//! It sends no cookies, logs in nowhere, uses no proxy and never solves or bypasses a
//! verification page: when WeChat asks for one, the result says `verify_required`.
//!
//! X posts, X Articles and replies come from the public FxTwitter API (api.fxtwitter.com), with
//! no X login, cookies or API key.
//!
//!   lots-scout-mcp                            serve MCP over stdio
//!   lots-scout-mcp read <url>                 print one WeChat article as Markdown
//!   lots-scout-mcp x <url> [--replies <n>]    print one X post with its replies as Markdown

use anyhow::{Context, Result};
use lots_scout_extract::{x, WeixinArticleExtractor};
use lots_scout_types::{
    BlobDescriptor, CaptureEnvelope, Sensitivity, SourceProfile, VerifiedBlob, VerifiedCapture,
    SCHEMA_VERSION,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::{BufRead, Read, Write};
use std::sync::OnceLock;
use std::time::Duration;

const MAX_HTML_BYTES: u64 = 8 * 1024 * 1024;
const USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 \
(KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36";
const TOOL: &str = "read_wechat_article";
const X_TOOL: &str = "read_x_post";
const DEFAULT_X_REPLIES: usize = 50;
const MAX_X_REPLIES: usize = 500;
const MAX_X_PAGES: usize = 20;

/// Why an article could not be read. `code` is stable for agents to branch on.
#[derive(Debug, PartialEq)]
struct Failure {
    code: &'static str,
    message: String,
}

fn fail(code: &'static str, message: impl Into<String>) -> Failure {
    Failure { code, message: message.into() }
}

#[derive(Debug)]
struct Article {
    url: String,
    title: String,
    account: Option<String>,
    published: Option<String>,
    markdown: String,
}

impl Article {
    fn render(&self, max_chars: Option<usize>) -> String {
        let mut meta = Vec::new();
        if let Some(account) = &self.account {
            meta.push(format!("公众号：{account}"));
        }
        if let Some(published) = &self.published {
            meta.push(format!("发布时间：{published}"));
        }
        meta.push(format!("原文：{}", self.url));
        let mut body = self.markdown.trim().to_string();
        if let Some(limit) = max_chars {
            if body.chars().count() > limit {
                body = body.chars().take(limit).collect::<String>() + "\n\n…（已截断）";
            }
        }
        format!("# {}\n\n> {}\n\n{}\n", self.title, meta.join(" ｜ "), body)
    }
}

fn client() -> Result<&'static reqwest::blocking::Client, Failure> {
    static CLIENT: OnceLock<Result<reqwest::blocking::Client, String>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::blocking::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(20))
                .user_agent(USER_AGENT)
                .build()
                .map_err(|e| e.to_string())
        })
        .as_ref()
        .map_err(|e| fail("network", e.clone()))
}

fn fetch(url: &str) -> Result<String, Failure> {
    let response = client()?
        .get(url)
        .header("Accept", "text/html,application/xhtml+xml")
        .header("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8")
        .send()
        .map_err(|e| fail("network", format!("请求失败：{e}")))?;
    let status = response.status();
    if status.is_redirection() {
        let location = response
            .headers()
            .get("location")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        return Err(if location.contains("captcha") || location.contains("verify") {
            fail("verify_required", "微信要求先完成验证")
        } else {
            fail("unavailable", format!("文章跳转到了别处（HTTP {status}）"))
        });
    }
    if matches!(status.as_u16(), 404 | 410) {
        return Err(fail("unavailable", format!("文章不存在（HTTP {status}）")));
    }
    if !status.is_success() {
        return Err(fail("network", format!("HTTP {status}")));
    }
    let mut bytes = Vec::new();
    response
        .take(MAX_HTML_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| fail("network", format!("读取响应失败：{e}")))?;
    if bytes.len() as u64 > MAX_HTML_BYTES {
        return Err(fail("too_large", "页面超过 8 MiB"));
    }
    String::from_utf8(bytes).map_err(|_| fail("extract_failed", "页面不是 UTF-8"))
}

/// The value of `var <name> = ...` in WeChat's inline script, unquoted and HTML-decoded.
/// Only `<script>` element text is searched, so article body text cannot supply it.
fn script_var(html: &str, name: &str) -> Option<String> {
    let needle = format!("var {name} = ");
    let mut scripts = html;
    let script = loop {
        let open = scripts.find("<script")?;
        let body = &scripts[open..];
        let body = &body[body.find('>')? + 1..];
        let end = body.find("</script>").unwrap_or(body.len());
        if let Some(found) = body[..end].find(&needle) {
            break &body[found + needle.len()..end];
        }
        scripts = &body[end..];
    };
    let rest = script.trim_start();
    let rest = rest.strip_prefix("htmlDecode(").unwrap_or(rest);
    let quote = rest.chars().next().filter(|c| *c == '"' || *c == '\'')?;
    let value = rest[1..].split(quote).next()?.trim();
    // `&amp;` last, so `&amp;lt;` decodes once to `&lt;`, not to `<`.
    let value = value
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&");
    (!value.is_empty() && value.len() <= 256).then_some(value)
}

fn published_at(html: &str) -> Option<String> {
    let seconds: i64 = script_var(html, "ct")?.parse().ok()?;
    let offset = chrono::FixedOffset::east_opt(8 * 3600)?;
    let time = chrono::DateTime::from_timestamp(seconds, 0)?.with_timezone(&offset);
    Some(time.format("%Y-%m-%d %H:%M（UTC+8）").to_string())
}

/// Classifies a fetched page and, for an article, cleans it with the WeChat extractor.
fn parse(url: &str, html: String, now: &str) -> Result<Article, Failure> {
    if !html.contains("id=\"js_content\"") {
        return Err(
            if ["wappoc_appmsgcaptcha", "环境异常", "完成验证"].iter().any(|m| html.contains(m)) {
                fail("verify_required", "微信返回了验证页")
            } else if ["已被发布者删除", "此内容因违规无法查看", "该内容已被", "内容已过期"]
                .iter()
                .any(|m| html.contains(m))
            {
                fail("unavailable", "文章已删除、违规或过期")
            } else {
                fail("extract_failed", "页面里没有公众号正文")
            },
        );
    }
    let account = script_var(&html, "nickname");
    let published = published_at(&html);
    let capture = capture(url, html.into_bytes(), now);
    let draft = WeixinArticleExtractor
        .extract_with_remote_images(&capture)
        .map_err(|e| fail("extract_failed", format!("正文清洗失败：{e:#}")))?;
    Ok(Article { url: url.to_string(), title: draft.title, account, published, markdown: draft.content_markdown })
}

fn capture(url: &str, bytes: Vec<u8>, now: &str) -> VerifiedCapture {
    let sha256 = format!("{:x}", Sha256::digest(&bytes));
    let artifact = BlobDescriptor {
        schema_version: SCHEMA_VERSION,
        locator: "artifacts/0".into(),
        media_type: "text/html".into(),
        byte_size: bytes.len() as u64,
        sha256: sha256.clone(),
        source_url: None,
    };
    VerifiedCapture {
        source: SourceProfile {
            schema_version: SCHEMA_VERSION,
            source_id: "lots-scout-mcp".into(),
            name: "WeChat article reader".into(),
            source_kind: "web".into(),
            canonical_uris: vec![],
            evidence_roles: vec![],
            default_sensitivity: Sensitivity::Public,
            preferred_extractor: Some("weixin.article".into()),
        },
        capture: CaptureEnvelope {
            schema_version: SCHEMA_VERSION,
            adapter_id: "lots-scout-mcp".into(),
            adapter_version: env!("CARGO_PKG_VERSION").into(),
            external_capture_id: format!("sha256:{sha256}"),
            source_id: "lots-scout-mcp".into(),
            captured_at: now.into(),
            capture_method: "local_http".into(),
            sensitivity: Sensitivity::Public,
            route_summary: None,
            title: None,
            source_url: url.into(),
            canonical_url: None,
            artifacts: vec![artifact.clone()],
        },
        blobs: vec![VerifiedBlob {
            descriptor: artifact,
            blob_id: format!("sha256:{sha256}"),
            source_backend_ref: None,
            bytes,
        }],
    }
}

/// Short links only (`https://mp.weixin.qq.com/s/<token>`); surrounding text is ignored.
fn article_url(input: &str) -> Option<String> {
    let start = input.find("https://mp.weixin.qq.com/s/")?;
    let url: String = input[start..]
        .chars()
        .take_while(|c| !c.is_whitespace() && !"\"'<>)）】，。".contains(*c))
        .collect();
    let url = url.split(['?', '#']).next()?.trim_end_matches('/').to_string();
    WeixinArticleExtractor::supports_url(&url).then_some(url)
}

fn read_article(input: &str) -> Result<Article, Failure> {
    let url = article_url(input).ok_or_else(|| {
        fail("unsupported_url", "只支持公众号文章短链接 https://mp.weixin.qq.com/s/<编号>")
    })?;
    let html = fetch(&url)?;
    parse(&url, html, &chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string())
}

fn fetch_json(url: &str) -> Result<String, Failure> {
    let response = client()?
        .get(url)
        .header("Accept", "application/json")
        .send()
        .map_err(|e| fail("network", format!("请求失败：{e}")))?;
    let status = response.status();
    // FxTwitter answers 404 and 401 with a JSON body whose `code` says why; let the parser read it.
    if !status.is_success() && !matches!(status.as_u16(), 401 | 403 | 404) {
        return Err(fail("network", format!("HTTP {status}")));
    }
    let mut bytes = Vec::new();
    response
        .take(x::MAX_X_JSON_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| fail("network", format!("读取失败：{e}")))?;
    String::from_utf8(bytes).map_err(|_| fail("network", "响应不是 UTF-8"))
}

fn x_failure(e: anyhow::Error) -> Failure {
    match e.to_string().as_str() {
        "x_post_unavailable" => fail("unavailable", "帖子不存在或已删除"),
        "x_post_private" => fail("unavailable", "帖子受保护，需要登录才能看"),
        other => fail("extract_failed", format!("解析失败：{other}")),
    }
}

/// One X post with up to `max_replies` replies, following the reply cursor page by page.
fn read_x(input: &str, max_replies: usize) -> Result<(x::XConversation, String), Failure> {
    let id = x::x_status_id(input).ok_or_else(|| {
        fail("unsupported_url", "只支持 X 帖子链接 https://x.com/<用户>/status/<编号>")
    })?;
    let first = x::parse_x_conversation(&fetch_json(&x::x_conversation_url(&id, None))?).map_err(x_failure)?;
    let mut replies = first.replies.clone();
    let mut cursor = first.next_cursor.clone();
    for _ in 1..MAX_X_PAGES {
        let Some(c) = cursor.take().filter(|_| replies.len() < max_replies) else { break };
        // A later page that fails keeps the replies already read.
        let Ok(page) = fetch_json(&x::x_conversation_url(&id, Some(&c))).map_err(|_| ()).and_then(|b| x::parse_x_conversation(&b).map_err(|_| ())) else { break };
        if page.replies.is_empty() {
            break;
        }
        replies.extend(page.replies);
        cursor = page.next_cursor;
    }
    replies.truncate(max_replies);
    let markdown = x::render_x_markdown(&first, &replies);
    Ok((first, markdown))
}

fn x_tool_result(args: &Value) -> Value {
    let input = args.get("url").and_then(Value::as_str).unwrap_or("");
    let max_replies = args
        .get("max_replies")
        .and_then(Value::as_u64)
        .map_or(DEFAULT_X_REPLIES, |n| (n as usize).min(MAX_X_REPLIES));
    match read_x(input, max_replies) {
        Ok((c, markdown)) => json!({
            "content": [{ "type": "text", "text": markdown }],
            "structuredContent": { "status": "ok", "url": c.status.url, "title": x::x_title(&c.status),
                "author": c.status.author_handle, "published": c.status.created_at,
                "is_article": c.status.article.is_some() },
            "isError": false
        }),
        Err(f) => json!({
            "content": [{ "type": "text", "text": format!("{}：{}", f.code, f.message) }],
            "structuredContent": { "status": f.code, "message": f.message },
            "isError": true
        }),
    }
}

const VERIFY_HINT: &str = "请用户在自己的 Chrome 里打开这篇文章并完成验证，然后用元芳（Lots Scout）收录，\
或稍后再试。本工具不会绕过验证。";

fn tool_result(args: &Value) -> Value {
    let input = args.get("url").and_then(Value::as_str).unwrap_or("");
    // The schema advertises a minimum of 200; smaller requests are raised to it.
    let max_chars = args.get("max_chars").and_then(Value::as_u64).map(|n| (n as usize).max(200));
    match read_article(input) {
        Ok(article) => json!({
            "content": [{ "type": "text", "text": article.render(max_chars) }],
            "structuredContent": { "status": "ok", "url": article.url, "title": article.title,
                "account": article.account, "published": article.published },
            "isError": false
        }),
        Err(f) => {
            let hint = if f.code == "verify_required" { format!("\n{VERIFY_HINT}") } else { String::new() };
            json!({
                "content": [{ "type": "text", "text": format!("{}：{}{hint}", f.code, f.message) }],
                "structuredContent": { "status": f.code, "message": f.message },
                "isError": true
            })
        }
    }
}

fn tools() -> Value {
    json!([{
        "name": X_TOOL,
        "title": "读取 X 帖子与回复",
        "description": "Read a public X (Twitter) post by link, including a long-form X Article body, \
the author's own follow-up thread and replies, as Markdown. Uses the public FxTwitter API; no X login, \
cookies or API key, so protected posts are unavailable.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "url": { "type": "string", "description": "Post link (x.com or twitter.com /status/<id>), or text containing one" },
                "max_replies": { "type": "integer", "minimum": 0, "maximum": 500, "description": "Replies to include (default 50)" }
            },
            "required": ["url"]
        }
    }, {
        "name": TOOL,
        "title": "读取微信公众号文章",
        "description": "Read a public WeChat Official Account article (https://mp.weixin.qq.com/s/<id>) \
from this machine's own network and return clean Markdown with title, account and publish time. \
No login, cookies or verification bypass: if WeChat shows a verification page the status is \
verify_required, and the user must open the article in their own browser.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "url": { "type": "string", "description": "Article short link, or text containing one" },
                "max_chars": { "type": "integer", "minimum": 200, "description": "Truncate the body to this many characters" }
            },
            "required": ["url"]
        }
    }])
}

fn handle(request: &Value) -> Option<Value> {
    let id = request.get("id")?.clone();
    let method = request.get("method").and_then(Value::as_str).unwrap_or("");
    let result = match method {
        "initialize" => json!({
            "protocolVersion": request.pointer("/params/protocolVersion").and_then(Value::as_str).unwrap_or("2025-06-18"),
            "capabilities": { "tools": {} },
            "serverInfo": { "name": "lots-scout-mcp", "version": env!("CARGO_PKG_VERSION") }
        }),
        "ping" => json!({}),
        "tools/list" => json!({ "tools": tools() }),
        "tools/call" => {
            let args = request.pointer("/params/arguments").unwrap_or(&Value::Null);
            match request.pointer("/params/name").and_then(Value::as_str) {
                Some(TOOL) => tool_result(args),
                Some(X_TOOL) => x_tool_result(args),
                _ => return Some(json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32602, "message": "unknown tool" } })),
            }
        }
        _ => return Some(json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": "method not found" } })),
    };
    Some(json!({ "jsonrpc": "2.0", "id": id, "result": result }))
}

fn serve() -> Result<()> {
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout().lock();
    for line in stdin.lock().lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let reply = match serde_json::from_str::<Value>(&line) {
            Ok(request) => handle(&request),
            Err(_) => Some(json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32700, "message": "parse error" } })),
        };
        if let Some(reply) = reply {
            writeln!(stdout, "{reply}")?;
            stdout.flush()?;
        }
    }
    Ok(())
}

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.as_slice() {
        [] => serve(),
        [cmd, url] if cmd == "read" => match read_article(url) {
            Ok(article) => {
                print!("{}", article.render(None));
                Ok(())
            }
            Err(f) => {
                eprintln!("{}：{}", f.code, f.message);
                std::process::exit(if f.code == "verify_required" { 3 } else { 1 });
            }
        },
        [cmd, url, rest @ ..] if cmd == "x" => {
            let max_replies = match rest {
                [] => DEFAULT_X_REPLIES,
                [flag, n] if flag == "--replies" => n.parse::<usize>().context("--replies takes a number")?.min(MAX_X_REPLIES),
                _ => anyhow::bail!("usage: lots-scout-mcp x <url> [--replies <n>]"),
            };
            match read_x(url, max_replies) {
                Ok((_, markdown)) => {
                    print!("{markdown}");
                    Ok(())
                }
                Err(f) => {
                    eprintln!("{}：{}", f.code, f.message);
                    std::process::exit(1);
                }
            }
        }
        _ => Err(anyhow::anyhow!("usage: lots-scout-mcp [read <url> | x <url> [--replies <n>]]")).context("invalid arguments"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const AT: &str = "2026-11-15T00:00:00Z";

    fn page(body: &str) -> String {
        format!(r#"<html><head><title>t</title></head><body>
<div id="qr_dialog" style="display:none">扫码 <button>关注</button></div>
<h1 class="rich_media_title" id="activity-name">标题甲</h1>
<script>var nickname = htmlDecode("智源&amp;研究院");
var ct = "1654852560";</script>
<div class="rich_media_content" id="js_content">{body}</div></body></html>"#)
    }

    #[test]
    fn urls_are_taken_from_text_and_only_short_links_pass() {
        assert_eq!(
            article_url("看看这篇 https://mp.weixin.qq.com/s/j8q018Lck1TWHO3NxQDiJQ?scene=1 写得不错").as_deref(),
            Some("https://mp.weixin.qq.com/s/j8q018Lck1TWHO3NxQDiJQ")
        );
        assert_eq!(article_url("https://mp.weixin.qq.com/s?__biz=MzA&mid=1"), None);
        assert_eq!(article_url("http://mp.weixin.qq.com/s/abc"), None);
    }

    #[test]
    fn an_article_becomes_markdown_with_account_and_time() {
        let body = "<p>".to_string() + &"大模型时代的生态建设。".repeat(30) + "</p>";
        let a = parse("https://mp.weixin.qq.com/s/abc", page(&body), AT).unwrap();
        assert_eq!(a.account.as_deref(), Some("智源&研究院"));
        assert_eq!(a.published.as_deref(), Some("2022-06-10 17:16（UTC+8）"));
        let md = a.render(None);
        assert!(md.contains("大模型时代的生态建设"));
        assert!(!md.contains("扫码") && !md.contains("关注"));
        assert!(a.render(Some(200)).ends_with("…（已截断）\n"));
    }

    #[test]
    fn script_vars_come_only_from_scripts_and_decode_once() {
        let html = r#"<p>var ct = "1"</p><script>var nickname = htmlDecode("a&amp;lt;b");</script>"#;
        assert_eq!(script_var(html, "ct"), None);
        assert_eq!(script_var(html, "nickname").as_deref(), Some("a&lt;b"));
    }

    #[test]
    fn verification_and_deleted_pages_are_reported_not_cleaned() {
        let verify = "<html><body>当前环境异常，完成验证后即可继续访问。<a href=\"/mp/wappoc_appmsgcaptcha\">去验证</a></body></html>";
        assert_eq!(parse("https://mp.weixin.qq.com/s/abc", verify.into(), AT).unwrap_err().code, "verify_required");
        let deleted = "<html><body>该内容已被发布者删除</body></html>";
        assert_eq!(parse("https://mp.weixin.qq.com/s/abc", deleted.into(), AT).unwrap_err().code, "unavailable");
    }

    #[test]
    fn mcp_lists_both_tools_and_rejects_unknown_ones() {
        let list = handle(&json!({"jsonrpc":"2.0","id":1,"method":"tools/list"})).unwrap();
        let names: Vec<&str> = list["result"]["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap()).collect();
        assert_eq!(names, [X_TOOL, TOOL]);
        let x_unsupported = handle(&json!({"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":X_TOOL,"arguments":{"url":"https://x.com/i/article/1"}}})).unwrap();
        assert_eq!(x_unsupported["result"]["structuredContent"]["status"], "unsupported_url");
        let bad = handle(&json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"x","arguments":{}}})).unwrap();
        assert_eq!(bad["error"]["code"], -32602);
        assert!(handle(&json!({"jsonrpc":"2.0","method":"notifications/initialized"})).is_none());
        let unsupported = handle(&json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":TOOL,"arguments":{"url":"https://example.com/"}}})).unwrap();
        assert_eq!(unsupported["result"]["structuredContent"]["status"], "unsupported_url");
    }
}
