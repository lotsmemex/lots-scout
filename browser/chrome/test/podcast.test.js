import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { discoverCapabilities } from "../capture.js";
import { ACTIVE_GROUP_ROUTE, resolveActiveGroup } from "../destination.js";
import { advance, httpTransport, loadActive, newJob, parseLinks, persistable, planFor, prepareSend, removeFinished, willEnqueue } from "../jobs.js";
import { describe, isPodcastEpisode, isTerminal } from "../progress-model.js";

const ENDPOINT = "http://127.0.0.1:3210/api/v1/captures";
const SECRET = "b".repeat(64);
const DEST = ["url-jobs-v1", "url-jobs-no-generation-v1", "url-jobs-enrich-v1", "url-jobs-destination-v1"];
const ALL = [...DEST, "url-jobs-active-group-v1"];
const LEGACY = ["url-jobs-v1", "url-jobs-no-generation-v1", "url-jobs-enrich-v1", "url-jobs-group-picker-v1"];
const EPISODE = "https://ampcode.com/podcast/season-02/episode-07";
// Synthetic folder IDs only.
const G_A = `group_${"a".repeat(32)}`, G_B = `group_${"b".repeat(32)}`, G_C = `group_${"c".repeat(32)}`;
const INBOX = { generation: "none", destination: { mode: "inbox" } };
const IN_A = { generation: "none", destination: { mode: "group", group_id: G_A, path: ["Main", "AmpCode"] } };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

// A synthetic intake. Like the real queue, a replayed request_key returns its original job.
function intake(features, { dropFirstReceipt = false, rejectWith = [], active = null } = {}) {
  const enqueues = []; const jobsByKey = new Map(); let dropped = false; const activeCalls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    if (url.endsWith("/capabilities")) return features ? json({ schema_version: 1, features }) : new Response("", { status: 404 });
    if (url.endsWith(ACTIVE_GROUP_ROUTE)) { activeCalls.push(body); return json({ schema_version: 1, ...active }); }
    if (url.endsWith("/url-jobs/enqueue")) {
      enqueues.push(body);
      const reject = rejectWith.shift();
      if (reject) return json({ schema_version: 1, error: reject }, { invalid_request: 400, permission_denied: 403 }[reject] || 409);
      if (!jobsByKey.has(body.request_key)) jobsByKey.set(body.request_key, `job_${jobsByKey.size + 1}`);
      if (dropFirstReceipt && !dropped) { dropped = true; throw new TypeError("connection reset"); }
      return json({ schema_version: 1, job_id: jobsByKey.get(body.request_key), state: "queued", can_cancel: true });
    }
    if (url.endsWith("/url-jobs/status")) return json({ schema_version: 1, job_id: body.job_id, state: "succeeded", item_id: "itm",
      enrichment: { state: "partial", cover: "unavailable", metadata_conflicts: [], archived: false } });
    return new Response("", { status: 404 });
  };
  return { fetchImpl, enqueues, jobsByKey, activeCalls };
}
const connect = async (server) => {
  const capabilities = await discoverCapabilities(ENDPOINT, SECRET, server.fetchImpl);
  return { capabilities, transport: httpTransport(ENDPOINT, SECRET, server.fetchImpl, capabilities) };
};
const sendOnce = async (job, transport) => advance(prepareSend(job, transport), transport);

test("only Amp podcast episode links are podcast episodes", () => {
  const { urls } = parseLinks(`${EPISODE}\nhttps://ampcode.com/podcast/episode-1\nhttps://ampcode.com/podcast/\nhttps://ampcode.com/podcast.rss
https://ampcode.com/news/x\nhttps://evil.example/podcast/episode-1\nhttps://ampcode.com/podcast/episode-2?x=1\nhttps://ampcode.com.evil.example/podcast/episode-3`);
  assert.deepEqual(urls.filter(isPodcastEpisode), [EPISODE, "https://ampcode.com/podcast/episode-1"]);
});

test("inbox mode: destination_mode inbox, no target and no removal fields", async () => {
  const server = intake(ALL);
  const { capabilities, transport } = await connect(server);
  const plan = planFor(EPISODE, { choice: "inbox", capabilities });
  assert.deepEqual(plan, { ok: true, want: INBOX });
  const job = newJob(EPISODE, plan.want);
  await sendOnce(job, transport);
  assert.deepEqual(server.enqueues, [{ schema_version: 1, request_key: job.request_key, url: EPISODE,
    include_comments: false, quality_check: "off", generation_policy: "none", destination_mode: "inbox" }]);
  assert.equal(server.activeCalls.length, 0);
});

test("selected_group: exact target only (no removal IDs), deep folders allowed, path is display-only", async () => {
  const deep = { group_id: G_C, path: ["Main", "AmpCode", "Season 2"], root_group_id: G_B, writable: true, updated_at: "2026-11-08T00:00:00Z" };
  const server = intake(ALL, { active: deep });
  const { capabilities, transport } = await connect(server);
  const active = await loadActive(transport, capabilities);
  assert.deepEqual(server.activeCalls, [{ schema_version: 1 }]);
  assert.deepEqual(active, { state: "ok", group_id: G_C, path: ["Main", "AmpCode", "Season 2"] });
  const plan = planFor(EPISODE, { choice: "current", capabilities, active });
  const job = newJob(EPISODE, plan.want);
  await sendOnce(job, transport);
  assert.deepEqual(server.enqueues, [{ schema_version: 1, request_key: job.request_key, url: EPISODE,
    include_comments: false, quality_check: "off", generation_policy: "none", destination_mode: "selected_group", target_group_id: G_C }]);
  // A writable library root is a legal target too.
  assert.equal(resolveActiveGroup({ group_id: G_B, path: ["Main"], root_group_id: G_B, writable: true, updated_at: null }).state, "ok");
});

test("unusable current folder (none, read-only, invalid) or missing features: 0 requests, nothing falls back to Inbox", async () => {
  for (const [active, reason] of [[{ group_id: null, path: [], root_group_id: null, writable: false, updated_at: null }, "none"],
    [{ group_id: G_A, path: ["Archive", "Old"], root_group_id: G_B, writable: false, updated_at: null }, "readonly"],
    [{ group_id: G_A, path: [], root_group_id: null, writable: true, updated_at: null }, "invalid"]]) {
    const server = intake(ALL, { active });
    const { capabilities, transport } = await connect(server);
    const resolved = await loadActive(transport, capabilities);
    assert.equal(resolved.reason, reason);
    assert.deepEqual(planFor(EPISODE, { choice: "current", capabilities, active: resolved }), { ok: false, reason: "active" });
    assert.deepEqual(server.enqueues, []);
  }
  // Without url-jobs-active-group-v1 the current folder is not even read.
  const noActive = intake(DEST, { active: { group_id: G_A, path: ["Main", "AmpCode"], writable: true } });
  const c1 = await connect(noActive);
  assert.deepEqual(await loadActive(c1.transport, c1.capabilities), { state: "closed", missing: ["url-jobs-active-group-v1"] });
  assert.deepEqual(noActive.activeCalls, []);
  assert.equal(planFor(EPISODE, { choice: "current", capabilities: c1.capabilities, active: null }).reason, "missing");
  // Ordinary pages are never filed into a folder by this flow.
  assert.equal(planFor("https://ampcode.com/news/x", { choice: "current", capabilities: c1.capabilities, active: { state: "ok" } }).reason, "article_needs_inbox");
});

test("without url-jobs-destination-v1 a podcast batch sends nothing, even an already created job", async () => {
  for (const features of [LEGACY, ["url-jobs-v1", "url-jobs-no-generation-v1", "url-jobs-enrich-v1", "url-jobs-active-group-v1"], null]) {
    const server = intake(features);
    const { capabilities, transport } = await connect(server);
    const plan = planFor(EPISODE, { choice: "inbox", capabilities });
    assert.equal(plan.ok, false);
    assert(plan.missing.includes("url-jobs-destination-v1"));
    const job = newJob(EPISODE, INBOX);
    assert.equal(willEnqueue(job, transport), false);
    assert.equal(await advance(job, transport), job);
    assert.deepEqual(server.enqueues, []);
  }
});

test("the folder is a snapshot: switching the Mac's current folder after submit does not change an old job's replay", async () => {
  const server = intake(ALL, { dropFirstReceipt: true, active: { group_id: G_A, path: ["Main", "AmpCode"], writable: true } });
  const { capabilities, transport } = await connect(server);
  const first = newJob(EPISODE, planFor(EPISODE, { choice: "current", capabilities, active: await loadActive(transport, capabilities) }).want);
  const lost = await sendOnce(first, transport);
  assert.equal(lost.state, "unknown");
  // The user picks another folder on your Mac; a page reopen reloads the persisted job.
  const switched = intake(ALL, { active: { group_id: G_C, path: ["Work"], writable: true } });
  const now = await loadActive((await connect(switched)).transport, capabilities);
  const [reloaded] = persistable([lost]);
  await sendOnce(reloaded, transport);
  const second = newJob(EPISODE, planFor(EPISODE, { choice: "current", capabilities, active: now }).want);
  await sendOnce(second, transport);
  assert.deepEqual(server.enqueues.map((b) => [b.request_key, b.target_group_id]), [[first.request_key, G_A], [first.request_key, G_A], [second.request_key, G_C]]);
  assert.deepEqual(server.enqueues[1], server.enqueues[0]);
  assert.deepEqual(reloaded.want.destination, { mode: "group", group_id: G_A, path: ["Main", "AmpCode"] });
});

test("1.3.x jobs (target/remove, no destination_mode) replay their original payload byte for byte", async () => {
  const server = intake(LEGACY, { dropFirstReceipt: true });
  const { transport } = await connect(server);
  const stored = { ...newJob(EPISODE, { generation: "none", target_group_id: G_A, remove_from_group_ids: [G_B] }), state: "unknown", sends: 1 };
  delete stored.page; delete stored.placement; delete stored.enrichment;
  const [reloaded] = persistable([stored]);
  await sendOnce(reloaded, transport);
  await sendOnce({ ...reloaded, sends: 2 }, transport);
  const expected = JSON.stringify({ schema_version: 1, request_key: stored.request_key, url: EPISODE, include_comments: false, quality_check: "off",
    generation_policy: "none", target_group_id: G_A, remove_from_group_ids: [G_B] });
  assert.deepEqual(server.enqueues.map((b) => JSON.stringify(b)), [expected, expected]);
});

test("receipts: partial enrichment is not called complete; 'already exists' is not rendered without a contract field", async () => {
  const server = intake(ALL);
  const { transport } = await connect(server);
  const queued = await sendOnce(newJob(EPISODE, INBOX), transport);
  const done = await advance(queued, transport);
  assert.equal(done.enrichment, "partial");
  assert.equal(describe(done).text, "已入库，部分信息未能补全（封面或元数据）");
  assert.doesNotMatch(describe(done).text, /已存在/);
});

test("enrichment.placement renders this job's outcome; unknown values render nothing", async () => {
  const done = (placement, state = "complete") => advance({ ...newJob(EPISODE, INBOX), state: "queued", job_id: "j" },
    { status: async () => ({ schema_version: 1, job_id: "j", state: "succeeded", enrichment: { state, archived: false, ...(placement === undefined ? {} : { placement }) } }) });
  assert.equal(describe(await done("existing_locations_preserved")).text, "已存在，位置未变");
  assert.equal(describe(await done("selected_group")).text, "已放入所选文件夹");
  assert.equal(describe(await done("unfiled")).text, "已收进 Inbox");
  for (const odd of ["moved_somewhere", 7, null, undefined]) {
    const job = await done(odd);
    assert.equal(job.placement, null);
    assert.equal(describe(job).text, "完成：Mac 已按节目收录或补全");
  }
  const partial = await done("unfiled", "partial");
  assert.equal(describe(partial).text, "已收进 Inbox · 部分信息未能补全（封面或元数据）");
  // Persisted and read back; never phrased as the item's current location.
  const [stored] = persistable([await done("existing_locations_preserved")]);
  assert.equal(describe(stored).text, "已存在，位置未变");
  for (const p of ["existing_locations_preserved", "selected_group", "unfiled"]) assert.doesNotMatch(describe(await done(p)).text, /当前|现在在|目前/);
  // A non-podcast job never shows a placement.
  const plain = await advance({ ...newJob("https://a.example/x", {}), state: "queued", job_id: "j" },
    { status: async () => ({ schema_version: 1, job_id: "j", state: "succeeded", enrichment: { state: "complete", placement: "unfiled" } }) });
  assert.equal(describe(plain).text, "已存入资料库");
});

test("first-send 400/409 only mean this request was not accepted; terminal and removable", async () => {
  const server = intake(ALL, { rejectWith: ["invalid_request", "podcast_duplicate_conflict"] });
  const { transport } = await connect(server);
  const bad = await sendOnce(newJob(EPISODE, IN_A), transport);
  assert.deepEqual([bad.state, describe(bad).tone], ["rejected", "error"]);
  assert.equal(describe(bad).text, "提交失败 · 这次请求未被受理（目标或移出文件夹无效），没有新建任务；请重新选择后再提交");
  const dup = await sendOnce(newJob(EPISODE, INBOX), transport);
  assert.deepEqual([dup.state, describe(dup).tone], ["blocked", "warn"]);
  assert.equal(describe(dup).text, "需处理 · 这次请求未被受理（库里有重复副本），没有新建任务；请在 Mac 端处理重复项");
  for (const job of [bad, dup]) assert.doesNotMatch(describe(job).text, /未收录|不在库里|从未/);
  assert(isTerminal(bad) && isTerminal(dup));
  assert.equal(server.enqueues.length, 2);
});

test("any rejection after an unknown outcome: needs-you, same key and payload, no automatic resend; re-check replays verbatim", async () => {
  for (const code of ["invalid_request", "podcast_duplicate_conflict", "request_identity_conflict", "permission_denied"]) {
    const server = intake(ALL, { dropFirstReceipt: true, rejectWith: [null, code] });
    const { transport } = await connect(server);
    const job = newJob(EPISODE, IN_A);
    const lost = await sendOnce(job, transport);
    const [reloaded] = persistable([lost]);
    const refused = await sendOnce(reloaded, transport);
    assert.equal(refused.state, "unconfirmed");
    assert.equal(isTerminal(refused), false);
    assert.match(describe(refused).text, /^需处理 · Mac 现在拒绝这条请求（.+），但无法确认之前是否已受理；请在 Mac 端核对$/);
    assert.deepEqual([refused.request_key, refused.want], [job.request_key, job.want]);
    assert.deepEqual(removeFinished([refused], refused.request_key), [refused]);
    const rechecked = await sendOnce(refused, transport);
    assert.equal(rechecked.state, "queued");
    assert.equal(new Set(server.enqueues.map((b) => JSON.stringify(b))).size, 1);
    assert.equal(server.enqueues.length, 3);
  }
});

test("safe first send: identity/auth/not-found refusals never read as 'not accepted'", async () => {
  for (const code of ["request_identity_conflict", "permission_denied", "resource_not_found"]) {
    const server = intake(ALL, { rejectWith: [code] });
    const { transport } = await connect(server);
    const refused = await sendOnce(newJob(EPISODE, INBOX), transport);
    assert.equal(refused.state, "unconfirmed");
    assert.doesNotMatch(describe(refused).text, /未被受理|没有新建|提交失败|未发送/);
  }
});

test("a pending job whose first send may have left is not treated as a first send", async () => {
  const server = intake(ALL, { rejectWith: ["invalid_request"] });
  const { transport } = await connect(server);
  const [reloaded] = persistable([prepareSend(newJob(EPISODE, INBOX), transport)]);
  assert.equal(reloaded.sends, 1);
  assert.equal((await sendOnce(reloaded, transport)).state, "unconfirmed");
});

test("the extension ships no folder IDs", () => {
  for (const file of ["background.js", "batch.js", "batch.html", "popup.js", "popup.html", "progress.html", "progress.js", "progress-model.js", "saved-index.js", "panel.js", "runner.js", "sniff.js", "destination.js", "jobs.js", "i18n.js", "capture.js", "options.js"]) {
    assert.doesNotMatch(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"), /group_[A-Za-z0-9]{8}/, file);
  }
});

test("podcast_retry reads as a plain explanation, not a code, and says the job can be retried", () => {
  const job = { ...newJob(EPISODE, INBOX), state: "failed", job_id: "j1", reason: "podcast_retry", can_retry: true };
  const { tone, text } = describe(job);
  assert.equal(tone, "error");
  assert.equal(text, "抓取失败 · Mac 处理这一集时出错，可以重试");
  assert.doesNotMatch(text, /podcast_retry|不要重试|后端/);
});
