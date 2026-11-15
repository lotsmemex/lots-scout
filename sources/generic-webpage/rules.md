# generic.webpage v2

## Identity

- id: `generic.webpage`
- version: `2`
- family: generic webpage/article fallback
- input: checksum-verified `VerifiedCapture`
- output: `ExtractedDraft`; the store assigns stable IDs and evidence links and renders the item file

## Recognize

Use when no site-specific extractor is available and the CaptureEnvelope has one verified
UTF-8 HTML artifact or at least one verified UTF-8 text artifact. Multiple HTML artifacts are
ambiguous and fail closed.

## Extract steps

1. **Title**
   - Prefer the non-empty capture title.
   - Fall back to the extracted article title.
   - Fallback to source URL.
2. **URL**
   - Prefer canonical URL.
   - Fallback to source URL.
3. **Body**
   - For one `text/html` or `application/xhtml+xml` artifact, run a streaming element preflight,
     deterministic Readability extraction, allowlist sanitization, pure HTML→Markdown conversion
     and canonical trailing-newline output.
   - Resolve retained relative links/images against an absolute credential-free HTTP(S)
     `capture.source_url`; retain only HTTP(S) destinations and do not fetch them.
   - Without HTML, join verified UTF-8 text artifacts in envelope order for backward compatibility.
4. **Ratings**
   - Only for Douban book/movie subject pages, Goodreads book pages and IMDb title main pages: read the rating the
     page shows, its scale and the number of raters into `ratings`, timed by `captured_at`.
   - Douban: RDFa `v:average` / `v:best` / `v:votes`, then JSON-LD `aggregateRating`;
     Goodreads and IMDb: JSON-LD `aggregateRating` (scale 5 and 10 when absent). Unrated pages give none.
5. **Sensitivity**
   - Store takes the stricter value of SourceProfile and CaptureEnvelope.

Output variants: `2` is the base; `2-comments-v1` appends a separately extracted comment section;
`3-web-structure-v1` is the structured path for `1-web-snapshot-v1` browser snapshots (headings,
tables, code, figures and references).

## Emit Markdown

The extractor emits only `content_markdown`: canonical Markdown with one trailing newline and no
front matter. The store adds the item front matter (`item_id`, `revision_id`, title) when it writes
the item.

## Guardrails

- Do not launch browser.
- Do not read cookies/tokens.
- Do not access network, download images/attachments or write the store.
- Ingest rejects HTML over 8 MiB before allocation and uses a bounded file-handle read; extractor
  rejects over 100000 start tags or 256 explicit nesting levels before DOM construction and keeps
  the DOM element limit as defense in depth.
- Reject multiple HTML artifacts and empty/unreadable extraction before owner write.
- Remove active content and disallow unsafe URL schemes before Markdown conversion.
- Do not fabricate missing title/date/author; leave null or mark fallback.
- Do not accept unverified bytes or assign Item identity.
