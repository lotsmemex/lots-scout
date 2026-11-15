# Lots Scout（元芳）Chrome extension

Lots Scout turns web pages into drafts and hands them to the library service running on this computer. Its Chinese name is 元芳; both names are the same extension, shown by browser language. This directory is a standalone Manifest V3 extension with no build step and no dependencies: `npm test` and `npm run package` work from a copy of this directory alone.

## Setup

1. Run `npm test` and `npm run package` in this directory. The deterministic ZIP is written to ignored `dist/lots-scout-chrome-mv3.zip` (ZIP metadata stripped, fixed file order; identical source bytes produce identical archives).
2. In `chrome://extensions`, enable Developer mode and choose **Load unpacked** for this directory, or for a folder you extracted the ZIP into. The checked-in public manifest key keeps the extension ID stable as `dmccdibgheklkgclcddbbhllfdihkppl`; no private signing key is included.
3. Configure the library service's capture intake for that extension origin, one fixed high loopback port, and an owner-only 64-lowercase-hex secret. Then enter the matching `http://127.0.0.1:PORT/api/v1/captures` address and the secret in **Extension options**.

## Use

**Click the toolbar icon** to sniff the current tab (`activeTab`, only on that click) and open a small menu. Nothing is sent until you choose:

- **收录 1 篇** captures this page. An Amp podcast episode becomes a job; an ordinary page is captured as a snapshot.
- **批量嗅探** shows the links found on the page in a picker. "全选" checks only the recognized items; the folded "其他链接" group has its own "全选此组"; already-sent items are never re-checked.
- **纳入数据库路径** picks the destination: **Inbox** (default), **当前 Mac 目录** (the folder open on the Mac), or **自选目录** (any writable folder, plus the 10 most recently used). An unusable choice holds the submit with a reason and never falls back to Inbox. The choice is remembered in `chrome.storage.local` and shared by the popup, the picker and the right-click "批量嗅探本页链接" page.

After a submit, progress opens in Chrome's side panel, or in a tab where the side panel is unavailable. It has filters (全部/进行中/失败/需处理/完成), "清理已完成", "删除失败项" (local list only, asks first), and per-item and bulk "重试失败" (only for failures the Mac marked retryable). Jobs run in the service worker, so they continue after the popup closes. A job whose outcome is unknown is never resent automatically; it waits for an explicit "再次核对", which replays the same bytes and request ID.

Each feature is enabled only when the Mac advertises the matching capability; otherwise nothing is sent. Capabilities are re-probed on focus and, after a failure, with backoff. Wire constants live in `destination.js`.

## Webpage snapshots

When the intake advertises `web-snapshot-v1`, single-page captures keep bounded article containers, heading levels and table-of-contents mappings, tables, code and raw publication-date evidence. Native videos become a poster, caption and link to the original page; video bytes are never downloaded. A date without a timezone stays date-only. WeChat articles (`mp.weixin.qq.com`) use the article capture instead of the snapshot.

After the click, public raster images are fetched without credentials, redirects or referrers: at most 32 images, 2 MiB each, 20 MiB total and 5 seconds per image. Failed images keep their source links and an explicit missing count. The exact binary request is stored in extension-owned IndexedDB before it is sent, so an unknown outcome is retried with the same bytes rather than a new capture. Conflicts never overwrite existing content.

### Reference batches

On a page with citations, **批量嗅探** defaults to **正文引用与 Learn more**; related posts stay separate and offsite links start unchecked. **打开并抓取已选链接** freezes at most 200 URLs, their destination and the intake identity, and asks for optional access only to those HTTPS origins. Denial queues nothing.

Each link opens in a new, visible tab with Chrome's normal session. The extension never reads or exports cookies, logs in, clicks, or follows links recursively. The URL filter rejects IP literals, local hostnames, credentials, non-HTTPS URLs and nondefault ports; it is a URL filter, not a DNS or private-network firewall. A page whose final URL differs from the requested one is not read. Visits run one at a time and close their own tab; an entry interrupted by the service worker stops for an explicit check instead of being reopened.

## Comments

With comments enabled, a capture first scrolls the tab toward its comment section in short steps (about 5 seconds at most, no clicks), restores the scroll position, and extracts the loaded comments as a separate part of at most 2 MiB. Comments inside cross-origin frames are reported as `in_frame` and not captured. Login walls and challenges come back as `needs_user` with an "open in browser" action. No fingerprint spoofing, CAPTCHA solving, proxy rotation or cookie export.

## Security boundary

Required permissions are `activeTab`, `contextMenus`, `scripting`, `sidePanel`, `storage`, and loopback HTTP access; the optional per-site HTTPS access is used only by reference batches. The right-click menu grants `activeTab` for that tab, used only to read the page's links. The page-side extractor never receives endpoint credentials. Before serialization the clone drops scripts, styles, embedded content and every form control, then strips event handlers and `srcdoc`. It reads only the title, canonical URL, a small allowlist of inert metadata, and at most 8 MiB of DOM HTML, and fails closed above fixed node, attribute and size limits. It does not read cookies, history, form values or local files.

The endpoint and secret stay in `chrome.storage.local` and service-worker memory; the options page never writes the stored secret back into its DOM. The OMDb key entered in options is sent once to the local service, which keeps it in the macOS Keychain; the extension does not store it. The secret is sent only in the dedicated intake header, never in the page, query string, cookies, logs or receipts. Requests omit credentials and referrer, disable cache and reject redirects. Nonces and capture IDs use fresh 256-bit randomness.

## Scope

Chrome MV3 only. Firefox/Safari packaging, store signing, authenticated or private pages, PDF/OCR and automatic capture are out of scope.

## Wire names

The capture protocol this extension speaks (`chrome_capture_v1`) is defined by the library backend, and the extension follows it by version. Its wire names use the `memex` prefix: the `application/vnd.memex.capture-v1` body type, the `X-MemeX-Intake-Secret` and `X-MemeX-Intake-Nonce` headers, the `memex:web-structure` snapshot meta and `data-memex-snapshot` attribute, the `memex.loopback-intake` adapter id and the `preferred_extractor` source-profile field. UI language is kept in `memex.lang` and pending snapshots in the `memex-snapshots-v1` IndexedDB store.

## License

Apache-2.0. See `LICENSE`.
