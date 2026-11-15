# weixin.article v3

## Identity

- id: `weixin.article`
- version: `3`
- family: WeChat Official Account public article
- input: one checksum-verified UTF-8 HTML artifact plus every referenced captured image artifact;
  the article source is an exact `https://mp.weixin.qq.com/s/...` URL
- output: `ExtractedDraft`; Store remains the sole Item/Evidence/receipt owner

## Extract steps

1. Require the exact HTTPS origin, default port and one `/s/<token>` path whose token contains only
   ASCII letters, digits, hyphen or underscore. Reject credentials, fragments, encoded separators,
   dot segments, alternate hosts, profile/history routes and lookalike domains.
2. Keep the complete verified HTML artifact as Evidence. The extractor has no fetch permission.
3. Bound bytes and total start tags before DOM construction. Because real WeChat shells contain
   browser-normalized malformed HTML, check depth on the normalized DOM without relaxing the
   generic extractor's conservative malformed-HTML preflight.
4. Require exactly one non-empty `#js_content`; missing content classifies challenge/error pages as
   extraction failures before snapshot CAS or Store write.
5. Prefer capture-supplied title, then `#activity-name`, OpenGraph title and source URL.
6. Prefer non-empty lazy image `data-src`, resolve it against the article URL and require an exact
   captured image occurrence. Rewrite it to the deterministic item-relative
   `attachments/sha256-<digest>.<ext>` path and emit a `DraftAttachmentRef::Captured` containing the
   verified blob occurrence index and blob id, never an extractor-selected filesystem path.
7. Convert body H1 to H2 so the Store-rendered item title remains the only H1. Promote a short,
   block-wide `一、...`/numeric section marker to H2 and `（一）...`/multi-level numeric marker to
   H3. Promotion requires at least 85% block coverage and at most 64 non-whitespace characters.
8. Preserve semantic `strong`/`b`, CSS `font-weight` >= 600 and exact red CSS values as Markdown
   emphasis. Remove emphasis from headings and from decorative candidates over 80 non-whitespace
   characters that cover at least 85% of their nearest text block. Collapse nested emphasis.
9. Sanitize to HTTP(S)-only content and convert deterministically to Markdown.

Output variants: `3` is the base; `3-comments-v1` appends a separately extracted comment section.

## Guardrails

- No Cookie, Authorization, browser profile, login session, CAPTCHA solver, proxy or network access.
- The extractor cannot download images. A source adapter may supply only preflighted PNG, JPEG,
  GIF or WebP bytes from the exact WeChat image allowlist; intake verifies canonical base64, declared
  size, SHA-256 and magic bytes before extraction.
- Every safe article image must have exactly one matching captured source URL and every supplied
  captured image must be used. Missing, ambiguous, duplicate or unused image occurrences fail closed.
- No MCP response becomes canonical data. MCP/public HTTP/browser connectors are replaceable source
  adapters that must provide verified HTML/image bytes to the extractor.
- Do not infer copyright permission from public readability. Rights remain explicit metadata and
  sensitivity remains independent.
- Reject multiple HTML artifacts, missing/duplicate body containers, unsafe URL schemes, active
  content, over-limit input and normalized DOM depth over 256.
- Store alone assigns Evidence ids and canonical attachment paths. Missing attachment projections may
  be repaired from the identical verified replay; an existing mismatched projection is never replaced.
