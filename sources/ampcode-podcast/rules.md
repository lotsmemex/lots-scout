# ampcode.podcast

Turns one public Amp podcast episode page into a Markdown draft.

## Recognize

- URL is `https://ampcode.com/podcast/episode-<n>` or
  `https://ampcode.com/podcast/season-<n>/episode-<n>`, where `<n>` is a positive decimal number.
- The first captured artifact is HTML and contains a `.transcript` element.

## Admit

The whole `main` region is checked before anything is cropped, so a gate notice or a hidden
ancestor next to the transcript is not silently dropped:

- exactly one `main`, one `main h1` and one `main .transcript`;
- no `form`, `input` or `[contenteditable=true]`;
- neither the heading nor the transcript, nor any of their ancestors, is `hidden`,
  `aria-hidden="true"`, `display:none` or `visibility:hidden`;
- heading and transcript text are not empty.

Anything else fails with `invalid_podcast_article`.

## Emit

- Title from `main h1`; body from `main`, converted to Markdown.
- No attachments. The raw HTML stays with the capture as evidence.
- `extractor_version` is always `1`.
