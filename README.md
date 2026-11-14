# Lots Scout

English | [简体中文](README.zh-CN.md)

Lots Scout turns web pages into drafts: web page in, Markdown draft out. It does not store
anything and knows nothing about how a library keeps its items, so it can be used on its own.
Its Chinese name is 元芳.

| Path | What it is |
| --- | --- |
| `browser/chrome/` | The Chrome extension (Manifest V3). No build step, no dependencies. |
| `crates/lots-scout-types/` | Capture input and draft output types. Depends only on `serde`. |
| `crates/lots-scout-extract/` | Extractors: generic web page, WeChat article, Linkresearcher, Amp podcast, comment extraction. |
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

## Build and test

```sh
cargo test --workspace
cd browser/chrome && npm test && npm run package   # writes dist/lots-scout-chrome-mv3.zip
```

## Using the crates

```toml
[dependencies]
lots-scout-extract = { git = "https://github.com/lotsmemex/lots-scout", tag = "v0.2.3" }

# Cargo does not pass patches on to dependents; repeat this one in your workspace.
[patch.crates-io]
dom_smoothie = { git = "https://github.com/lotsmemex/lots-scout", tag = "v0.2.3" }
```

`lots_scout_extract::extract(&capture)` picks the extractor that recognizes a verified
capture and returns an `ExtractedDraft`.

## Wire names

The capture protocol between the extension and a library service (`chrome_capture_v1`) is
defined by the library service, [Lots MemeX](https://github.com/lotsmemex/lotsmemex). Its wire
names use the `memex` prefix: the `application/vnd.memex.capture-v1` body type, the `X-Memex-Intake-Secret` and `X-Memex-Intake-Nonce` headers, the `memex:web-structure` snapshot meta and `data-memex-snapshot` attribute, the `memex.loopback-intake` adapter id and the `preferred_translator` source-profile field. The extension also keeps its UI language in `memex.lang`
and pending snapshots in the `memex-snapshots-v1` IndexedDB store.

## License

Apache-2.0, see `LICENSE`. `vendor/dom_smoothie` keeps its own MIT license.
