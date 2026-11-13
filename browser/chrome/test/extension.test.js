import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { buildCapture, SECRET_PATTERN, validateEndpoint } from "../capture.js";
import { collectImageEvidence } from "../image-capture.js";
const read = (name) => readFileSync(new URL(`../${name}`, import.meta.url), "utf8");

test("manifest has only the required narrow permissions", () => {
  const manifest = JSON.parse(read("manifest.json"));
  assert.deepEqual(manifest.permissions, ["activeTab", "contextMenus", "scripting", "sidePanel", "storage"]);
  assert.deepEqual(manifest.host_permissions, ["http://127.0.0.1/*"]);
  assert.deepEqual(manifest.optional_host_permissions, ["https://*/*"]);
  assert.equal(JSON.stringify(manifest).match(/cookies|tabs|history|webRequest|<all_urls>/i), null);
  const digest = createHash("sha256").update(Buffer.from(manifest.key, "base64")).digest().subarray(0, 16);
  const id = [...digest].map((byte) =>
    String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15))).join("");
  assert.equal(id, "dmccdibgheklkgclcddbbhllfdihkppl");
});

test("manifest text resolves in every locale and names the extension Lots Scout / 元芳", () => {
  const manifest = JSON.parse(read("manifest.json"));
  const placeholders = [...JSON.stringify(manifest).matchAll(/__MSG_(\w+)__/g)].map((m) => m[1]);
  assert.ok(placeholders.includes("extName") && placeholders.includes("extDescription"));
  const names = {};
  for (const locale of [manifest.default_locale, "zh_CN", "zh_TW"]) {
    const messages = JSON.parse(read(`_locales/${locale}/messages.json`));
    for (const key of placeholders) assert.ok(messages[key]?.message, `${locale} lacks ${key}`);
    assert.equal(JSON.stringify(messages).match(/memex/i), null);
    names[locale] = messages.extName.message;
  }
  assert.deepEqual(names, { en: "Lots Scout", zh_CN: "元芳", zh_TW: "元芳" });
});

test("extractor bounds one article and removes active and form-bearing elements", () => {
  const source = read("extractor.js");
  for (const tag of ["script", "style", "noscript", "iframe", "object", "embed", "input", "textarea", "select", "button", "form"])
    assert.match(source, new RegExp(`PROHIBITED = \\"[^\\"]*${tag}`));
  assert.match(source, /querySelectorAll\("article,\[role='article'\]"\)/);
  assert.match(source, /MAX_ARTICLE_CANDIDATES = 64/);
  assert.match(source, /MIN_ARTICLE_TEXT = 200/);
  assert.match(source, /MAX_CANDIDATE_NODES = 20_000/);
  assert.match(source, /MAX_TOTAL_NODES = 50_000/);
  assert.match(source, /MAX_TOTAL_ATTRIBUTES = 100_000/);
  assert.match(source, /MAX_TOTAL_TEXT_CODE_UNITS = 8 \* 1024 \* 1024/);
  assert.match(source, /MAX_TOTAL_SERIALIZED_BYTES = 16 \* 1024 \* 1024/);
  assert.match(source, /candidate\.closest\(PROHIBITED\)/);
  assert.match(source, /best\.score < runnerUpScore \* 2/);
  assert.match(source, /createHTMLDocument\(""\)/);
  assert.doesNotMatch(source, /document\.documentElement\.cloneNode/);
  assert.doesNotMatch(source, /cloneNode\(true\)/);
  assert.match(source, /source\.cloneNode\(false\)/);
  assert.match(source, /!source\.matches\(PROHIBITED\)/);
  assert.match(source, /htmlBytes <= MAX_HTML_BYTES \? html : null/);
  assert.doesNotMatch(source, /html\.slice/);
  assert.doesNotMatch(source, /\.value\b|files\b|\bcookie\b/i);
});

test("settings validation is exact", () => {
  assert(validateEndpoint("http://127.0.0.1:3210/api/v1/captures"));
  for (const bad of ["http://localhost:3210/api/v1/captures", "https://127.0.0.1/api/v1/captures", "http://127.0.0.1/api/v1/captures", "http://127.0.0.1:1023/api/v1/captures", "http://127.0.0.1/x", "http://127.0.0.1/api/v1/captures?q=1"])
    assert(!validateEndpoint(bad));
  assert(SECRET_PATTERN.test("a".repeat(64)));
  assert(!SECRET_PATTERN.test("A".repeat(64)));
});

test("options displays the exact Origin header class without a URL path", () => {
  assert.match(read("options.js"), /`chrome-extension:\/\/\$\{chrome\.runtime\.id\}`/);
  assert.doesNotMatch(read("options.js"), /runtime\.id\}\//);
});

test("binary capture declares exact UTF-8 size and SHA-256", async () => {
  const snapshot = { sourceUrl: "https://example.test/a", canonicalUrl: null, title: "T", html: "<p>你好</p>", metadata: {} };
  const { manifest, body } = await buildCapture(snapshot, new Date("2026-01-01T00:00:00Z"));
  assert.equal(manifest.html.byte_size, new TextEncoder().encode(snapshot.html).byteLength);
  assert.match(manifest.html.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(manifest.metadata, {});
  assert.equal(manifest.sensitivity, "internal");
  assert.equal(body.type, "application/vnd.memex.capture-v1");
  assert.deepEqual([...new Uint8Array(await body.slice(0, 8).arrayBuffer())], [...Buffer.from("MEMEX\0\0\x01", "latin1")]);
  assert.equal(body.size, 12 + new TextEncoder().encode(JSON.stringify(manifest)).byteLength + manifest.html.byte_size);
  await assert.rejects(() => buildCapture({ ...snapshot, html: "x".repeat(8 * 1024 * 1024 + 1) }));
});

test("author metadata includes the strict intake role", async () => {
  const snapshot = { sourceUrl: "https://example.test/a", canonicalUrl: null, title: "T", html: "<p>Article</p>", metadata: { creators: "Author One" } };
  const { manifest } = await buildCapture(snapshot, new Date("2026-01-01T00:00:00Z"));
  assert.deepEqual(manifest.metadata.creators, [{ display_name: "Author One", role: "author" }]);
});

test("request contract omits ambient credentials and code never logs secrets", () => {
  const capture = read("capture.js");
  assert.match(capture, /credentials:\s*"omit"/);
  assert.match(capture, /cache:\s*"no-store"/);
  assert.match(capture, /redirect:\s*"error"/);
  assert.match(capture, /referrerPolicy:\s*"no-referrer"/);
  assert.doesNotMatch(["background.js", "options.js", "batch.js", "jobs.js", "reveal.js", "popup.js", "panel.js", "progress.js", "progress-model.js", "saved-index.js", "runner.js", "sniff.js", "destination.js"].map(read).join("") + capture, /console\.|Authorization|Cookie/);
});

test("image evidence retains public URL aliases, bounds bytes and never requests private addresses", async () => {
  const original = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push(String(url));
    assert.equal(options.credentials, "omit");
    assert.equal(options.redirect, "error");
    return new Response(String(url).endsWith("/large") ? new Uint8Array(2 * 1024 * 1024 + 1) : new Uint8Array([137, 80, 78, 71]), { headers: { "content-type": "image/png" } });
  };
  try {
    const result = await collectImageEvidence(["https://example.test/a", "https://example.test/a?alias=1", "https://example.test/a",
      "https://example.test/large", "https://172.16.0.1/x", "https://0.0.0.0/x", "https://printer.localhost/x", "https://[::1]/x"]);
    assert.deepEqual(result.images.map((i) => i.source_url), ["https://example.test/a", "https://example.test/a?alias=1"]);
    assert.deepEqual(requests, ["https://example.test/a", "https://example.test/a?alias=1", "https://example.test/large"]);
    assert.equal(result.missing, 5);
  } finally { globalThis.fetch = original; }
});
