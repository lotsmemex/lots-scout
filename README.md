# Lots Scout

English | [简体中文](README.zh-CN.md)

Lots Scout turns web pages into drafts: web page in, Markdown draft out. It does not store
anything and knows nothing about how a library keeps its items, so it can be used on its own.
Its Chinese name is 元芳.

| Path | What it is |
| --- | --- |
| `browser/chrome/` | The Chrome extension (Manifest V3). No build step, no dependencies. |
| `crates/lots-scout-types/` | Capture input and draft output types. Depends only on `serde`. |
| `crates/lots-scout-extract/` | Extractors: generic web page, WeChat article, Linkresearcher, Amp podcast, comment extraction; page ratings and pure helpers for rating and title lookups. |
| `crates/lots-scout-mcp/` | Local MCP server and CLI that read public WeChat articles and X posts into Markdown. |
| `sources/` | One manifest and one prose description of the rules per source. |
| `vendor/dom_smoothie/` | dom_smoothie 0.18.0 (MIT), vendored to make equal-score candidate ordering deterministic. |

## Install the Chrome extension

The extension is not in the Chrome Web Store yet. Chrome only installs it from an unpacked folder:

1. Download `lots-scout-chrome-mv3.zip` from the
   [latest release](https://github.com/lotsmemex/lots-scout/releases/latest) and unzip it into a
   folder you will keep (Chrome loads the extension from that folder every time it starts).
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose the unzipped folder.
4. Open the extension's **Options** and enter the address and secret of the capture intake of the
   library service on this computer. Without it, the extension can sniff links but not send them.

To update, unzip the new release over the same folder and click the reload button on the
extension's card in `chrome://extensions`.

## Read WeChat articles and X posts from your AI agent (MCP)

`lots-scout-mcp` is a small local MCP server with two tools:

- `read_wechat_article`: give it a public WeChat Official Account link (`https://mp.weixin.qq.com/s/...`) and it returns clean Markdown with the title, account name and publish time.
- `read_x_post`: give it an X post link (`https://x.com/<user>/status/<id>`) and it returns the post, the full body of an X Article, the author's own follow-up thread and up to `max_replies` replies (default 50, at most 500) as Markdown. It reads the public [FxTwitter](https://github.com/FixTweet/FxTwitter) API: no X login, cookies or API key, so protected posts are not available, and it depends on that free service staying up.

It runs on your own Mac and network. WeChat shows cloud servers a verification page, but serves the public article to an ordinary local request. It logs in nowhere, sends no cookies, uses no proxy and never solves or bypasses a verification page: when WeChat asks for one, the result is `verify_required`, and you open the article in your own browser.

The Chrome extension cannot host it (extensions cannot open local ports or be started by agents), so install it once:

```sh
mkdir -p ~/.local/bin
curl -L https://github.com/lotsmemex/lots-scout/releases/latest/download/lots-scout-mcp-macos-arm64.tar.gz | tar -xz -C ~/.local/bin
```

Prebuilt for Apple Silicon Macs. On other systems, build it: `cargo install --locked --git https://github.com/lotsmemex/lots-scout lots-scout-mcp`.

Then add it to your agent:

- Amp: `amp mcp add wechat-reader -- ~/.local/bin/lots-scout-mcp`
- Claude Code: `claude mcp add --scope user wechat-reader -- ~/.local/bin/lots-scout-mcp`
- Cursor and others: a stdio server whose command is `~/.local/bin/lots-scout-mcp`.

It also works from a terminal: `lots-scout-mcp read <link>` for WeChat, `lots-scout-mcp x <link> [--replies <n>]` for X.

## Build and test

```sh
cargo test --workspace
cd browser/chrome && npm test && npm run package   # writes dist/lots-scout-chrome-mv3.zip
```

## Using the crates

```toml
[dependencies]
lots-scout-extract = { git = "https://github.com/lotsmemex/lots-scout", tag = "v0.2.7" }

# Cargo does not pass patches on to dependents; repeat this one in your workspace.
[patch.crates-io]
dom_smoothie = { git = "https://github.com/lotsmemex/lots-scout", tag = "v0.2.7" }
```

`lots_scout_extract::extract(&capture)` picks the extractor that recognizes a verified
capture and returns an `ExtractedDraft`.

## Wire names

The capture protocol between the extension and a library service (`chrome_capture_v1`) is
defined by the library service, [Lots MemeX](https://github.com/lotsmemex/lotsmemex). Its wire
names use the `memex` prefix: the `application/vnd.memex.capture-v1` body type, the `X-Memex-Intake-Secret` and `X-Memex-Intake-Nonce` headers, the `memex:web-structure` snapshot meta and `data-memex-snapshot` attribute, the `memex.loopback-intake` adapter id and the `preferred_extractor` source-profile field. The extension also keeps its UI language in `memex.lang`
and pending snapshots in the `memex-snapshots-v1` IndexedDB store.

## License

Apache-2.0, see `LICENSE`. `vendor/dom_smoothie` keeps its own MIT license.
