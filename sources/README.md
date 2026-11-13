# Sources

Each source here describes how one kind of web page is turned into a Markdown draft. All rules
here are written for this project.

## Directory shape

```text
sources/
  generic-webpage/          generic.webpage
  weixin-article/           weixin.article
  linkresearcher-article/   linkresearcher.article
  ampcode-podcast/          ampcode.podcast
    manifest.yaml   # id, recognize rules, extraction order, output versions
    rules.md        # the same rules in prose
```

The code in `crates/lots-scout-extract` is the implementation. The manifests are documentation and
are not read at runtime; `crates/lots-scout-extract/tests/manifests.rs` fails when a manifest's id,
version or output variants drift from the code, or when an extractor has no manifest.

`provenance.output_variants` lists every `extractor_version` the code can write, for example
`2-comments-v1` when the generic extractor removed a comment section.

## Selection order

`lots_scout_extract::extract` picks the first extractor that recognizes the capture:

1. `linkresearcher.article`
2. `ampcode.podcast`
3. `weixin.article` (by URL)
4. `generic.webpage`

## Boundary

- Input is a checksum-verified `VerifiedCapture`; output is an `ExtractedDraft`. The library that
  stores drafts assigns stable IDs, adds bibliographic metadata and writes canonical files.
- Extractors do not own a live browser, login state, anti-bot handling or external API calls.
  Fetching is a replaceable source-adapter responsibility.
- `linkresearcher.article` consumes the verified public API JSON representation; its source adapter
  keeps the article URL and records the API URL on raw evidence.

## Future rules

Rules learned for a family of similar pages should be data files holding only URL patterns and page
structure, never page text.
