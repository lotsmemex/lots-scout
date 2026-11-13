# linkresearcher.article v1

Consumes a checksum-verified public API JSON response. The source adapter, not
this extractor, obtains `/api/theses/<id>` for an exact HTTPS public article URL.
The adapter does not send cookies or signatures and does not follow API redirects.

Require matching article ID and API acquisition URL, a nonempty title and one
primary response no larger than 8 MiB. Use nonempty `wholeHtmlContent`, otherwise
`content`, matching the public page's article fields. Do not fall back to an
abstract, related article, comment list or remote original-source URL.

Admission checks this body before extraction. Bound HTML structure, remove known
comment containers from the derived DOM, sanitize active content and unsafe URLs,
then convert to Markdown. The complete original JSON remains raw Evidence. Keep
the public article URL as item/canonical identity and the API URL on the blob.
Image links remain remote references; neither extraction nor capture downloads
them here. No file access, network access, login state, model or Store writes occur
inside the extractor. Unknown templates can fail closed; full site coverage is
not claimed by one successful public sample.

Known inert editor decorations are removed only from leaf spans with the exact
`custom-entry-btn` / `custom-delete-btn` class, `contenteditable=false`, and text
`↵` or `X`. Actual removal records extractor version `1-editor-cleanup-v1`;
otherwise the earlier `1` output/version is preserved.
