import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { buildCapture, discoverCapabilities } from "../capture.js";
import { act, advance, httpTransport, newJob, parseLinks, persistable, unavailableTransport } from "../jobs.js";
import { describe } from "../progress-model.js";

const ENDPOINT = "http://127.0.0.1:3210/api/v1/captures";
const SECRET = "a".repeat(64);
const fake = (handler) => {
  const calls = [];
  const record = (name) => async (input) => { calls.push([name, input]); return handler(input, name); };
  return { calls, ready: true, enqueue: record("enqueue"), status: record("status"), retry: record("retry"), cancel: record("cancel") };
};
const fail = (code) => { throw Object.assign(new Error(code), { code }); };

test("link parsing keeps distinct canonical https links and rejects the rest", () => {
  const parsed = parseLinks("https://a.example/x#part\nhttps://a.example/x  http://b.example/\nnot-a-url\nhttps://u:p@c.example/");
  assert.deepEqual(parsed.urls, ["https://a.example/x"]);
  assert.equal(parsed.rejected, 3);
  const many = parseLinks(Array.from({ length: 205 }, (_, i) => `https://e.example/${i}`).join("\n"));
  assert.equal(many.urls.length, 200);
  assert.equal(many.overflow, 5);
});

test("a lost receipt replays the same key and full input instead of minting a new one", async () => {
  let attempt = 0;
  const transport = fake(() => (++attempt === 1 ? fail("unknown") : { job_id: "j1", state: "queued", can_cancel: true }));
  const job = newJob("https://a.example/", { quality: true, comments: true });
  assert.match(job.request_key, /^chrome_capture_[A-Za-z0-9_-]{32}$/);
  const lost = await advance(job, transport);
  assert.equal(lost.state, "unknown");
  const replayed = await advance(lost, transport);
  assert.equal(replayed.state, "queued");
  assert.deepEqual(transport.calls[0][1], transport.calls[1][1]);
  assert.deepEqual(transport.calls[0][1], { request_key: job.request_key, url: "https://a.example/", include_comments: true, quality_check: "configured" });
  await advance(replayed, transport);
  assert.deepEqual(transport.calls[2], ["status", { job_id: "j1" }]);
});

test("rejections stop the job; unavailable sends nothing and says so", async () => {
  const transport = fake(() => fail("request_identity_conflict"));
  const rejected = await advance(newJob("https://a.example/", {}), transport);
  assert.equal(rejected.state, "rejected");
  assert.equal(await advance(rejected, transport), rejected);
  assert.equal(transport.calls.length, 1);
  const closed = await advance(newJob("https://a.example/", {}), unavailableTransport());
  assert.equal(closed.state, "unavailable");
  assert.match(describe(closed).text, /尚未开放/);
});

test("retry and cancel follow the receipt's flags, and a failed action does not guess a state", async () => {
  const transport = fake((input, name) => (name === "cancel" ? fail("unknown") : { job_id: "j", state: "queued" }));
  const waiting = await advance(newJob("https://a.example/", {}), fake(() => ({ job_id: "j", state: "retry_wait", can_retry: false, can_cancel: true, retry_at_ms: Date.UTC(2026, 10, 2, 3, 4) })));
  // Nothing is guessed: the job is the same apart from the recorded outcome of the action.
  const { last_action: notAllowed, ...afterRetry } = await act(waiting, "retry", transport, 5);
  assert.deepEqual(afterRetry, waiting);
  assert.deepEqual(notAllowed, { action: "retry", ok: false, code: "not_allowed_locally", http_status: null, at: 5 });
  const { last_action: lost, ...afterCancel } = await act(waiting, "cancel", transport, 6);
  assert.deepEqual(afterCancel, waiting);
  assert.deepEqual(lost, { action: "cancel", ok: false, code: "unknown", http_status: null, at: 6 });
  assert.deepEqual(transport.calls, [["cancel", { job_id: "j" }]]);
  assert.match(describe(waiting).text, /Mac 计划 .+ 再试/);
});

test("unknown queue states are not success; model failure is never 'corrected'", async () => {
  const odd = await advance(newJob("https://a.example/", {}), fake(() => ({ job_id: "j", state: "teleported" })));
  assert.equal(odd.state, "unknown");
  const done = await advance(newJob("https://a.example/", { quality: true, comments: true }), fake(() => ({
    job_id: "j", state: "succeeded", quality_check: { state: "failed", reason: "provider_error" }, comments: { state: "none_found" }
  })));
  const { tone, text } = describe(done);
  assert.equal(tone, "ok");
  assert.match(text, /模型检查失败（未校正）/);
  assert.match(text, /这次快照里没识别到评论区/);
  const login = await advance(newJob("https://a.example/", {}), fake(() => ({ job_id: "j", state: "needs_user", reason: "interactive_login_required" })));
  assert.match(describe(login).text, /需要登录/);
});

test("only queue references and the display title are persisted", () => {
  const job = { ...newJob("https://a.example/", {}, 0, null, "Item title"), html: "<p>body</p>" };
  const [stored] = persistable([job]);
  assert.deepEqual(Object.keys(stored).sort(), ["can_cancel", "can_retry", "comments", "item_id", "job_id", "quality_check", "reason",
    "request_key", "retry_at_ms", "revision_id", "sends", "stage", "state", "updated_at", "url", "want"].concat(["enrichment", "page", "placement", "title", "last_action"]).sort());
  assert.equal(stored.title, "Item title");
  assert.equal(newJob("https://a.example/", {}, 0, null, "x".repeat(400)).title.length, 300);
});

test("HTTP transport posts the frozen routes; old servers are unavailable, drops are unknown", async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, init, body: JSON.parse(init.body) });
    if (url.endsWith("/capabilities")) return new Response(JSON.stringify({ schema_version: 1, features: ["url-jobs-v1", "comments-v1"] }));
    if (url.endsWith("/status")) return new Response(JSON.stringify({ schema_version: 1, error: "resource_not_found" }), { status: 404 });
    if (url.endsWith("/retry")) throw new TypeError("network");
    if (url.endsWith("/cancel")) return new Response(JSON.stringify({ schema_version: 1, error: "permission_denied" }), { status: 403 });
    return new Response(JSON.stringify({ schema_version: 1, job_id: "j", state: "queued" }));
  };
  assert.deepEqual(await discoverCapabilities(ENDPOINT, SECRET, fetchImpl), { urlJobs: true, comments: true, qualityCheck: false, webSnapshot: false, features: ["url-jobs-v1", "comments-v1"] });
  const transport = httpTransport(ENDPOINT, SECRET, fetchImpl);
  await transport.enqueue({ request_key: "k", url: "https://a.example/", include_comments: false, quality_check: "off" });
  const enqueue = seen[1];
  assert.equal(enqueue.url, "http://127.0.0.1:3210/api/v1/url-jobs/enqueue");
  assert.deepEqual(enqueue.body, { schema_version: 1, request_key: "k", url: "https://a.example/", include_comments: false, quality_check: "off" });
  assert.equal(enqueue.init.headers["X-MemeX-Intake-Secret"], SECRET);
  assert.match(enqueue.init.headers["X-MemeX-Intake-Nonce"], /^[0-9a-f]{64}$/);
  assert.equal(enqueue.init.credentials, "omit");
  assert.equal(enqueue.init.redirect, "error");
  await assert.rejects(transport.status({ job_id: "j" }), { code: "resource_not_found" });
  await assert.rejects(transport.retry({ job_id: "j" }), { code: "unknown" });
  await assert.rejects(transport.cancel({ job_id: "j" }), { code: "permission_denied" });
  const oldServer = async () => new Response("", { status: 404 });
  assert.deepEqual(await discoverCapabilities(ENDPOINT, SECRET, oldServer), { urlJobs: false, comments: false, qualityCheck: false, features: [] });
});

test("capture-v1 comments are a separate hashed part after the article bytes, only when requested", async () => {
  const snapshot = { sourceUrl: "https://example.test/a", canonicalUrl: null, title: "T", html: "<p>正文</p>", metadata: {},
    comments: { state: "captured", html: "<p>评论 🙂</p>" } };
  const plain = await buildCapture(snapshot, new Date("2026-01-01T00:00:00Z"));
  assert.equal("comments" in plain.manifest, false);
  assert.equal("quality_check" in plain.manifest, false);
  const { manifest, body } = await buildCapture(snapshot, new Date("2026-01-01T00:00:00Z"), { comments: true, qualityCheck: "configured" });
  const commentBytes = Buffer.from(snapshot.comments.html);
  assert.deepEqual(manifest.comments, { state: "captured", html: {
    media_type: "text/html", byte_size: commentBytes.byteLength, sha256: createHash("sha256").update(commentBytes).digest("hex") } });
  assert.equal(manifest.quality_check, "configured");
  const bytes = Buffer.from(await body.arrayBuffer());
  const manifestLength = bytes.readUInt32BE(8);
  const article = bytes.subarray(12 + manifestLength, 12 + manifestLength + manifest.html.byte_size);
  assert.equal(article.toString(), snapshot.html);
  assert.equal(bytes.subarray(12 + manifestLength + manifest.html.byte_size).toString(), snapshot.comments.html);
  const none = await buildCapture({ ...snapshot, comments: { state: "in_frame", html: null } }, new Date(), { comments: true });
  assert.deepEqual(none.manifest.comments, { state: "in_frame", html: null });
  assert.equal(none.body.size, 12 + Buffer.byteLength(JSON.stringify(none.manifest)) + none.manifest.html.byte_size);
});

test("a stored job keeps being read back while its model check is still running", async () => {
  const receipts = [
    { job_id: "j", state: "succeeded", quality_check: { state: "running", reason: null } },
    { job_id: "j", state: "succeeded", quality_check: { state: "needs_review", reason: null } }
  ];
  const transport = fake(() => receipts.shift());
  const running = await advance(newJob("https://a.example/", { quality: true }), transport);
  assert.match(describe(running).text, /模型检查中/);
  const settled = await advance(running, transport);
  assert.deepEqual(transport.calls.map(([name]) => name), ["enqueue", "status"]);
  assert.match(describe(settled).text, /有建议待你确认/);
  assert.equal(await advance(settled, transport), settled);
});

test("queued model checks read as waiting, and an uncommitted capture is not called 'model unavailable'", async () => {
  const waiting = await advance(newJob("https://a.example/", { quality: true }), fake(() => ({
    job_id: "j", state: "retry_wait", quality_check: { state: "pending", reason: "awaiting_capture" } })));
  assert.match(describe(waiting).text, /模型检查：等收录完成/);
  assert.doesNotMatch(describe(waiting).text, /不可用/);
  const cancelled = await advance(newJob("https://a.example/", { quality: true }), fake(() => ({
    job_id: "j", state: "cancelled", quality_check: { state: "unavailable", reason: "capture_not_committed" } })));
  assert.match(describe(cancelled).text, /未入库，未检查/);
  assert.doesNotMatch(describe(cancelled).text, /不可用/);
});
