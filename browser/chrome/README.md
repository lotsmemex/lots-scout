# Lots Scout（元芳）Chrome extension

Lots Scout turns web pages into drafts. Its Chinese name is 元芳; both names are the same extension, shown by browser language. This directory is a standalone Manifest V3 extension: it has no build step and no dependencies, and `npm test` / `npm run package` work from a copy of this directory alone. On an explicit toolbar click it injects a one-shot extractor into only the active top-level HTTP(S) page, selects one bounded article element, sanitizes that subtree, and posts a bounded `internal`-sensitivity binary `capture-v1` envelope to the authenticated IPv4-loopback intake. Pages without an unambiguous bounded article element fail closed.

## Setup

1. Run `npm test` and `npm run package` in this directory. The deterministic ZIP is written to ignored `dist/lots-scout-chrome-mv3.zip` (ZIP metadata stripped, fixed file order; identical source bytes produce identical archives).
2. In `chrome://extensions`, enable Developer mode and choose **Load unpacked** for this directory. For the packaged ZIP, extract it to an owner-controlled directory first, then load that directory. The checked-in public manifest key keeps the extension ID stable as `dmccdibgheklkgclcddbbhllfdihkppl`; no private signing key is included. Open **Extension options** and confirm the displayed non-secret exact extension origin.
3. Configure the local library service's capture intake for that exact origin, one fixed high loopback port, and an owner-only 64-lowercase-hex secret file. Then save the matching `http://127.0.0.1:PORT/api/v1/captures` URL and secret in **Extension options**.
4. Click the toolbar action on an HTTP(S) article. `OK` means intake accepted it; `!` means capture failed. No automatic/background page capture occurs.
5. Version 0.1.4. **Click the toolbar icon** to sniff the current tab (activeTab, only on that click) and open a small menu; nothing is sent until a click: **收录 1 篇** (this page; an Amp episode becomes a job with the remembered destination, an ordinary page is captured as a snapshot into Inbox), **批量嗅探** ("N items found"; opens the picker: "全选" checks only the recognized items, the folded "其他链接" group has its own "全选此组", "全不选" clears both, already-sent items are never re-checked; the button reads "<destination> · 收录 N 条"), and **纳入数据库路径**, collapsed to the selected one of three radios: **Inbox** (default; `destination_mode:"inbox"`), **当前 Mac 目录** (read from `POST /api/v1/active-group` on open and focus, greyed with the reason when null/read-only/invalid/not advertised; snapshotted as `selected_group` + that `group_id`), **自选目录** ("选择…" opens the `POST /api/v1/groups` tree: any writable library root or folder at any depth, read-only greyed; a remembered ID no longer listed is cleared with a notice) plus the 10 most recently used folders (only `group_id` + path at the time are stored; shown only after checking against the current list: gone hidden, read-only greyed, renamed shown by current path). The choice is remembered in `chrome.storage.local` (`destChoice`, `destCustom`, `destHistory`) and shared by the popup, the picker and the right-click "批量嗅探本页链接" page; an unusable choice holds the submit with a reason and never falls back to Inbox. Gates: current folder needs `url-jobs-active-group-v1`, chosen folder `url-jobs-group-picker-v1`, both `url-jobs-destination-v1`. After a submit, progress opens in Chrome's **side panel** (`sidePanel` permission, `side_panel.default_path: progress.html`), or in a full tab where the side panel is unavailable; the menu keeps a "查看进度" link. Progress scrolls as one page with filters (全部/进行中/失败/需处理/完成), "清理已完成" and "删除失败项" (local list only, delete asks first), and per-item and bulk "重试失败" (only failed jobs whose receipt allowed retry; unknown and unconfirmed jobs are never removed or rewritten; `podcast_retry` reads "Mac 处理这一集时出错，正在排查；请先不要重试" and its retry is de-emphasized). Amp episodes always use `destination_mode` (`inbox`, or `selected_group` + `target_group_id`; never removal IDs) with `generation_policy:"none"`, `quality_check:"off"`, no comments, and require `url-jobs-v1`, `url-jobs-no-generation-v1`, `url-jobs-enrich-v1`, `url-jobs-destination-v1` (+ `url-jobs-active-group-v1` for the current folder); otherwise nothing is sent. Ordinary pages keep the plain URL job and can only go to Inbox. The folder is snapshotted into each job at submit and replayed verbatim; 1.3.x jobs (target/remove, no destination_mode) keep reconciling with their original payload. Jobs run in the service worker, so they continue after the popup closes; reopening the popup shows this page's progress. A first-send `400 invalid_request` / `409 podcast_duplicate_conflict` means only that this request was not accepted and created no task; after an unknown outcome any rejection becomes "needs you" (same key and payload, no polling, explicit "check again" only). Only finished jobs can be removed from the local list. Capabilities are re-probed on focus/visibility and, after a failure, with backoff. No folder IDs ship with the extension. Wire constants live in `destination.js`.

## Structured webpage snapshots (local implementation; requires updated intake)

The 0.1.4 legacy behavior above remains for old servers. An intake advertising
`web-snapshot-v1` enables **single-page snapshots** into the selected writable
folder at any depth. It preserves bounded prose/articleBody containers, heading
levels and source TOC mappings, tables, code and raw publication-date evidence.
Native videos become a poster, caption and clickable original-page location;
video bytes are never downloaded. A date without a timezone stays date-only.

After the capture click, public raster images are fetched without credentials,
redirects or referrers: at most 32 images, 2 MiB each, 20 MiB total and 5 seconds
per image. Failed images retain source links and an explicit missing count.
The exact binary request is persisted in extension-owned IndexedDB before POST.
Unknown outcomes keep that request for the next explicit click, rather than
recapturing changed bytes. Conflicts never overwrite existing content.
Structured snapshots do not request comments or AI quality checks; the popup
discloses this when those defaults are enabled. Legacy/site-specific paths keep
their original options and protocol. Reload the unpacked extension after changes;
this source change does not install/restart the Mac daemon or desktop app.

Sniffed candidates retain citation / Learn more / Related posts occurrences,
merge fragment/tracking variants and leave offsite links unchecked. **Generic
URL-job batches still use the legacy Inbox destination**; structured snapshot
filing alone does not imply rendered-browser acquisition (the explicit path below
is separate) or complete virtualized table capture. ARIA grids export only loaded
rows with a warning.

### Explicit reference batches (0.1.4 source, not installed by this change)

On a page with citation evidence, **批量嗅探** defaults to **正文引用与 Learn more**;
Related posts remain separate. Duplicate URLs retain all bounded occurrences and
fragments as provenance. Offsite references start unchecked; **全选** selects this
scope only. Select a writable destination, then **打开并抓取已选链接**. The click
freezes at most 200 URLs, their destination and the probed intake identity; it
requests optional access only to those HTTPS origins. Denial queues nothing.
No newly discovered links are added. Old URL-job / podcast batches are unchanged.

**Navigation is not snapshot reading.** Chrome first navigates a new, visible tab
normally and may follow redirects and request subresources. It may use its normal
browser session; the extension never reads/exports cookies, logs in, clicks or
recursively discovers links. This is **not a DNS/private-network firewall**.
The URL filter rejects IP literals, local/special hostnames, credentials,
non-HTTPS and nondefault ports, not DNS results. The pre-click notice discloses
this boundary. A changed final URL is not read or admitted: the comparison uses
URL parsing (scheme/host case normalized) and removes one trailing pathname
slash; path case, query, fragment (including empty `?` / `#` separators) and
encoding remain significant. The extractor
checks the URL synchronously before DOM access, and subsequent content reads are
pinned to the checked document ID. URL-change failures are visible, not retried.

Visits run one at a time and normally close their own tab. Only queue entries
not yet visiting can be cancelled; an active visit cannot be cancelled. Worker
interruption stops that entry for explicit checking instead of silently opening
it again; Chrome may leave its visible tab behind. Close the leftover tab before
checking an interrupted visit. A persisted snapshot is reused without revisiting.
Immutable binary bytes and original request ID are persisted before sending;
unknown outcomes never auto-resend. **再次核对** replays the same bytes/ID to the
same intake. Changed intake, missing bytes or conflicts stop without recapture
or silent Inbox fallback. Missing images retain source links. No AI/model calls.

Snapshot intake consumes the submitted HTML and verified image bytes; it does
not re-fetch the source page or fill missing images. Separate daemon URL/resource
fetches retain their DNS/connection-IP `address_not_public` policy; browser URL
filtering must not be described as that server-side protection.

**Permissions:** required permissions and loopback `host_permissions` are
unchanged; only `optional_host_permissions: ["https://*/*"]` is new. Reloading
the unpacked extension should not require new mandatory site access or disable
it for expanded required permissions. On the first capture click Chrome may ask
to “read and change your data” on the selected sites; already granted sites may
not prompt again. The extension asks for exact selected origins, not all HTTPS
sites. Wording varies by Chrome/language; native permission-dialog appearance
has not been validated here. This change was tested only with synthetic pages:
no real reference page was captured or written to a library.

The library backend that receives these captures also offers a network-free
command line for the same extraction and admission code (inspect, extract,
discover and collect a saved snapshot, with a dry-run mode that writes nothing).
It belongs to the backend, not to this extension; see the backend's own README.

## Comments and pacing

With comments enabled (settings default, comments-v1 intake), the toolbar capture first scrolls the current tab toward its comment section in uneven steps with short pauses (bounded to about 5 seconds, no clicks), restores the reader's scroll position, then extracts the already-loaded comment section with the same sanitizer as the article, as a separate bounded part (≤2 MiB) appended after the article bytes. Comments inside cross-origin frames are reported as `in_frame`, never captured; `none_found` only describes this snapshot. Legacy URL jobs are fetched by the Mac queue, which paces requests per site and honours Retry-After; challenges and login walls come back as `needs_user` with an "open in browser" action for a manual one-click snapshot. No fingerprint spoofing, CAPTCHA solving, proxy rotation or cookie export. Explicit browser-reference batches use the separate visible navigation contract above.

## Security boundary

Required permissions remain `activeTab`, `contextMenus`, `scripting`, `sidePanel`, `storage`, and exact loopback HTTP access; optional selected-site HTTPS access is described above. A context-menu click grants `activeTab` for that tab, used only to read link hrefs inside the user's selection. The page-side extractor never receives endpoint credentials. Before serialization the clone drops scripts, styles, embedded browsing/plugin content, and every form/control (including password and file inputs), then strips event handlers and `srcdoc`. It reads only title, canonical URL, a small allowlist of inert metadata, and at most 8 MiB of UTF-8 DOM HTML. Candidate work fails closed above 64 articles, 20,000 nodes per candidate, 50,000 nodes/100,000 attributes/8 MiB text aggregate, or 16 MiB aggregate serialization. It does not read cookies, browser history/profile data, form values or local files. It never requests all-site optional access at runtime; ordinary browser navigation/subresources are not a network sandbox.

Endpoint and secret remain in privileged `chrome.storage.local` and service-worker memory; the settings page never writes the stored secret back into its DOM. Batch job records keep only queue references (key, URL, options, job/item/revision IDs, states, reason, retry time). They are sent only as the intake URL and dedicated intake header, never to the page, query string, Cookie/Authorization, logs, or receipts. Fetch omits credentials and referrer, disables cache, and rejects redirects. Nonces and external capture IDs use fresh 256-bit browser cryptographic randomness.

## Next-browser boundary

This package is Chrome MV3 only. Firefox/Safari packaging, store signing/review, full installed-extension CORS/PNA/service-worker acceptance, authenticated/private pages, PDF/OCR, and automatic capture are intentionally out of scope. No private signing key is included.

## Wire names

The capture protocol this extension speaks (`chrome_capture_v1`) is defined by the library backend, and the extension follows it by version. Its wire names use the `memex` prefix: the `application/vnd.memex.capture-v1` body type, the `X-Memex-Intake-Secret` and `X-Memex-Intake-Nonce` headers, the `memex:web-structure` snapshot meta and `data-memex-snapshot` attribute, the `memex.loopback-intake` adapter id and the `preferred_translator` source-profile field. UI language is kept in `memex.lang` and pending snapshots in the `memex-snapshots-v1` IndexedDB store.

## License

Apache-2.0. See `LICENSE`.
