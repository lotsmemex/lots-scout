# 元芳（Lots Scout）

[English](README.md) | 简体中文

元芳把网页变成草稿：网页进，Markdown 草稿出。它不负责存储，也不关心资料库怎么保存条目，可以单独使用。英文名是 Lots Scout，和元芳是同一个扩展，按浏览器语言显示。

| 路径 | 内容 |
| --- | --- |
| `browser/chrome/` | Chrome 扩展（Manifest V3），无需构建，没有依赖 |
| `crates/lots-scout-types/` | 抓取输入与草稿输出的数据格式，只依赖 `serde` |
| `crates/lots-scout-extract/` | 正文提取：通用网页、微信公众号文章、领研、Amp 播客，以及评论抽取；页面评分，以及查询评分和译名用的纯函数 |
| `crates/lots-scout-mcp/` | 本机 MCP 服务和命令行，把公开的微信公众号文章读成 Markdown |
| `sources/` | 每个信源一份清单和一份规则说明 |
| `vendor/dom_smoothie/` | dom_smoothie 0.18.0（MIT），内置一份是为了让同分候选的排序固定 |

## 安装 Chrome 扩展

扩展暂未上架 Chrome 应用商店，需要以“加载已解压的扩展程序”的方式安装：

1. 从[最新版本](https://github.com/lotsmemex/lots-scout/releases/latest)下载 `lots-scout-chrome-mv3.zip`，解压到一个之后不会删除的文件夹（Chrome 每次启动都从这个文件夹加载扩展）。
2. 在 Chrome 地址栏打开 `chrome://extensions`，打开右上角的“开发者模式”。
3. 点“加载已解压的扩展程序”，选择刚才解压出的文件夹。
4. 打开扩展的“选项”，填写本机资料库服务的收录地址和密钥。不填也能嗅探链接，但无法发送收录。

更新时，把新版本解压覆盖到同一个文件夹，再在 `chrome://extensions` 里点扩展卡片上的刷新按钮。

## 让 AI Agent 读公众号文章（MCP）

`lots-scout-mcp` 是一个本机 MCP 小服务，只有一个工具 `read_wechat_article`：给它公众号文章链接（`https://mp.weixin.qq.com/s/...`），返回整理好的 Markdown，带标题、公众号名和发布时间。

它在你自己的 Mac 上、用你自己的网络读取。微信会给云端服务器弹验证页，但对普通的本机请求直接给出公开文章。它不登录、不带 cookie、不用代理，也不破解或绕过验证：微信要求验证时，结果是 `verify_required`，请你在自己的浏览器里打开这篇文章。

Chrome 扩展装不下它（扩展不能开本机端口，也不能被 Agent 启动），所以需要单独装一次：

```sh
mkdir -p ~/.local/bin
curl -L https://github.com/lotsmemex/lots-scout/releases/latest/download/lots-scout-mcp-macos-arm64.tar.gz | tar -xz -C ~/.local/bin
```

预编译版本适用于 Apple 芯片的 Mac。其他系统请自行编译：`cargo install --locked --git https://github.com/lotsmemex/lots-scout lots-scout-mcp`。

然后加到你用的 Agent 里：

- Amp：`amp mcp add wechat-reader -- ~/.local/bin/lots-scout-mcp`
- Claude Code：`claude mcp add --scope user wechat-reader -- ~/.local/bin/lots-scout-mcp`
- Cursor 等：添加一个 stdio 服务，命令为 `~/.local/bin/lots-scout-mcp`。

在终端里也能用：`lots-scout-mcp read <链接>`。

## 构建与测试

```sh
cargo test --workspace
cd browser/chrome && npm test && npm run package   # 生成 dist/lots-scout-chrome-mv3.zip
```

## 在 Rust 项目中使用

```toml
[dependencies]
lots-scout-extract = { git = "https://github.com/lotsmemex/lots-scout", tag = "v0.2.6" }

# Cargo 不会把 patch 传给下游，需要在你的 workspace 里再写一次。
[patch.crates-io]
dom_smoothie = { git = "https://github.com/lotsmemex/lots-scout", tag = "v0.2.6" }
```

`lots_scout_extract::extract(&capture)` 会挑出能识别这份已校验抓取的提取器，返回一份 `ExtractedDraft`。

## 接口名

扩展与资料库服务之间的抓取协议（`chrome_capture_v1`）由资料库服务 [Lots MemeX](https://github.com/lotsmemex/lotsmemex) 定义，接口名统一使用 `memex` 前缀：`application/vnd.memex.capture-v1` 请求体类型，`X-Memex-Intake-Secret`、`X-Memex-Intake-Nonce` 请求头，`memex:web-structure` 快照元信息和 `data-memex-snapshot` 属性，`memex.loopback-intake` 适配器标识，以及来源配置字段 `preferred_extractor`。扩展的界面语言保存在 `memex.lang`，待发送的快照保存在 IndexedDB 存储 `memex-snapshots-v1`。

## 许可证

Apache-2.0，见 `LICENSE`。`vendor/dom_smoothie` 保留其自身的 MIT 许可证。
