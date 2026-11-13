# generic.webpage v2

## Identity

- id: `generic.webpage`
- version: `2`
- family: generic webpage/article fallback
- input: checksum-verified `VerifiedCapture`
- output: `ItemDraft`；stable ID、EvidenceLink 与 Markdown 由 store 生成

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
4. **Sensitivity**
   - Store takes the stricter value of SourceProfile and CaptureEnvelope.

## Emit Markdown

```markdown
---
item_id: <item_id>
revision_id: <revision_id>
title: <escaped-title>
---

# <title>

<content_markdown>

```

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
