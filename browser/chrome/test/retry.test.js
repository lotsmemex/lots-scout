// Every way a retry/cancel click used to end silently (no request, or a swallowed error) now leaves a
// recorded outcome. All intakes here are in-process fakes; nothing is sent anywhere.
import test from "node:test";
import assert from "node:assert/strict";
import { postJson } from "../capture.js";
import { act, httpTransport, newJob, persistable, unavailableTransport } from "../jobs.js";
import { actionText } from "../progress-model.js";
import { createRunner } from "../runner.js";

const ENDPOINT = "http://127.0.0.1:3210/api/v1/captures";
const SECRET = "b".repeat(64);
const EPISODE = "https://ampcode.com/podcast/season-02/episode-03";
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
// The 13 jobs in question: failed at commit with podcast_retry, retry allowed by the Mac's last receipt.
const KEY = newJob(EPISODE, {}, 0).request_key;
const failed = (extra = {}) => ({ ...newJob(EPISODE, { generation: "none", destination: { mode: "inbox" } }, 0),
  request_key: KEY, state: "failed", stage: "commit", reason: "podcast_retry", job_id: "job_1", can_retry: true, ...extra });
// A fetch that never answers on its own, only to its abort signal (a hung connection).
const hanging = (log = []) => (url, init) => new Promise((_, reject) => {
  log.push(new URL(url).pathname);
  init.signal?.addEventListener("abort", () => reject(init.signal.reason));
});
const within = (promise, ms, what) => Promise.race([promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`${what}: still pending after ${ms} ms`)), ms))]);
const memory = (jobs) => {
  const store = { batchJobs: structuredClone(jobs) };
  return { store, local: { get: async (k) => ({ [k]: structuredClone(store[k]) }), set: async (o) => Object.assign(store, structuredClone(o)) } };
};

test("postJson errors carry the HTTP status, and never the URL, secret, nonce or body", async () => {
  for (const [status, body, code] of [[409, { schema_version: 1, error: "invalid_state" }, "invalid_state"], [400, { schema_version: 1, error: "invalid_request" }, "invalid_request"],
    [404, null, "unavailable"], [503, { schema_version: 1, error: "warming_up" }, "unknown"]]) {
    const error = await postJson(ENDPOINT, SECRET, "/api/v1/url-jobs/retry", { job_id: "job_1" },
      async () => body ? json(body, status) : new Response("", { status })).catch((e) => e);
    assert.equal(error.code, code);
    assert.equal(error.http_status, status);
    assert.doesNotMatch(JSON.stringify({ ...error, message: error.message }), /127\.0\.0\.1|b{64}|job_1|retry/);
  }
});

test("a hung retry/status request times out as unknown instead of holding the queue", async () => {
  const error = await within(postJson(ENDPOINT, SECRET, "/api/v1/url-jobs/retry", { job_id: "j" }, hanging(), { timeoutMs: 30 }).catch((e) => e), 2000, "postJson");
  assert.deepEqual([error.code, error.timeout, error.http_status], ["unknown", true, null]);

  // A queued job's status read hangs during kick; the user's retry right after must still run and be recorded.
  const queued = { ...failed({ request_key: "chrome_capture_q", state: "queued", job_id: "job_q", can_retry: false, reason: null }) };
  const { store, local } = memory([queued, failed()]);
  const log = [];
  const fetchImpl = (url, init) => new URL(url).pathname.endsWith("/retry")
    ? Promise.resolve(json({ schema_version: 1, job_id: "job_1", state: "queued" })) : hanging(log)(url, init);
  const transport = httpTransport(ENDPOINT, SECRET, fetchImpl, { features: ["url-jobs-v1"] }, { timeoutMs: 40 });
  const runner = createRunner({ local, connect: async () => ({ ok: true, transport }), schedule: () => 0 });
  runner.kick();
  const outcome = await within(runner.act(failed().request_key, "retry"), 2000, "act behind a hung status read");
  assert.equal(outcome.ok, true);
  assert.deepEqual(log, ["/api/v1/url-jobs/status"]);
  const byKey = Object.fromEntries(store.batchJobs.map((j) => [j.request_key, j]));
  assert.equal(byKey[failed().request_key].state, "queued");
  // The timed-out read is unknown; its key and payload are those it had.
  assert.deepEqual([byKey.chrome_capture_q.state, byKey.chrome_capture_q.want], ["unknown", queued.want]);
});

test("not allowed locally (old record without can_retry, or no job id): recorded, nothing sent", async () => {
  const calls = [];
  const transport = { ready: true, retry: async (b) => { calls.push(b); return { job_id: "j", state: "queued" }; } };
  const [old] = persistable([{ ...failed(), can_retry: undefined }]);
  const a = await act(old, "retry", transport, 7);
  assert.deepEqual(a.last_action, { action: "retry", ok: false, code: "not_allowed_locally", http_status: null, at: 7 });
  const b = await act(failed({ job_id: null }), "retry", transport, 8);
  assert.equal(b.last_action.code, "no_job_id");
  assert.deepEqual(calls, []);
  assert.equal(a.request_key, old.request_key);
});

test("Mac unreachable, not set up, or without url-jobs: the runner records why, sends nothing", async () => {
  for (const [conn, code] of [[{ ok: false, reason: "unreachable", transport: unavailableTransport() }, "mac_unreachable"],
    [{ ok: false, reason: "settings", transport: unavailableTransport() }, "settings_required"],
    [{ ok: true, transport: unavailableTransport() }, "feature_missing"], ["throws", "mac_unreachable"]]) {
    const { store, local } = memory([failed()]);
    const runner = createRunner({ local, connect: async () => { if (conn === "throws") throw new Error("x"); return conn; }, schedule: () => 0 });
    const outcome = await runner.act(failed().request_key, "retry");
    assert.deepEqual([outcome.ok, outcome.code], [false, code]);
    const [job] = store.batchJobs;
    assert.equal(job.last_action.code, code);
    assert.deepEqual([job.state, job.request_key, job.want], ["failed", failed().request_key, failed().want]);
  }
});

test("a refused retry is recorded with its HTTP status and code; state, key and payload unchanged", async () => {
  const fetchImpl = async () => json({ schema_version: 1, error: "invalid_state" }, 409);
  const transport = httpTransport(ENDPOINT, SECRET, fetchImpl, { features: ["url-jobs-v1"] });
  const { store, local } = memory([failed()]);
  const runner = createRunner({ local, connect: async () => ({ ok: true, transport }), schedule: () => 0 });
  const outcome = await runner.act(failed().request_key, "retry");
  assert.deepEqual([outcome.ok, outcome.code, outcome.http_status], [false, "invalid_state", 409]);
  const [job] = store.batchJobs;
  assert.deepEqual([job.state, job.can_retry, job.request_key, job.want], ["failed", true, failed().request_key, failed().want]);
  assert.equal(actionText(job), `重试未被 Mac 受理（HTTP 409 · invalid_state）（${new Date(job.last_action.at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })}）`);
  // Bulk retry reports the same per-row outcome.
  const bulk = await runner.retryFailed();
  assert.deepEqual(bulk, { ok: false, count: 1, failed: 1 });
});

test("progress row text for every recorded outcome; an accepted retry that is still failed says so", () => {
  const at = Date.UTC(2026, 10, 9, 2, 0);
  const row = (code, http = null, ok = false, state = "failed") => actionText({ state, last_action: { action: "retry", ok, code, http_status: http, at } });
  assert.match(row("not_allowed_locally"), /^没有发出：本地记录显示这条现在不能重试/);
  assert.match(row("mac_unreachable"), /^没有发出：当时连不上 Mac 收录服务/);
  assert.match(row("timeout"), /^重试请求 15 秒内没有回应，Mac 是否收到未知/);
  assert.match(row("no_response"), /^后台没有回应，重试可能没有发出；请在 chrome:\/\/extensions 重新加载 元芳扩展后再试/);
  assert.match(row("unknown", 503), /^重试未被 Mac 受理（HTTP 503 · unknown）/);
  assert.match(row(null, 200, true), /^Mac 收到了重试，但这条仍是失败/);
  assert.equal(row(null, 200, true, "queued"), "");
  assert.equal(actionText({ state: "failed" }), "");
});

test("全部再次核对: replays only identity-conflict jobs, one by one, with byte-identical bodies; unknown and other refusals untouched", async () => {
  const FEATURES = ["url-jobs-v1", "url-jobs-no-generation-v1", "url-jobs-enrich-v1", "url-jobs-destination-v1"];
  const raw = [];
  let accept = false;
  const fetchImpl = async (url, init) => {
    const route = new URL(url).pathname;
    if (route.endsWith("/enqueue")) {
      raw.push(init.body);
      return accept ? json({ schema_version: 1, job_id: `job_${raw.length}`, state: "queued" })
        : json({ schema_version: 1, error: "request_identity_conflict" }, 409);
    }
    return json({ schema_version: 1, job_id: "x", state: "queued" });
  };
  const transport = httpTransport(ENDPOINT, SECRET, fetchImpl, { features: FEATURES });
  const folder = { generation: "none", destination: { mode: "group", group_id: `group_${"a".repeat(32)}`, path: ["Main", "AmpCode"] } };
  // Two first sends refused with an identity conflict: needs-you, same key and payload.
  const { advance, prepareSend } = await import("../jobs.js");
  const refused = [];
  for (const n of [3, 4]) refused.push(await advance(prepareSend(newJob(`https://ampcode.com/podcast/season-02/episode-0${n}`, folder, 0), transport), transport, 0));
  assert(refused.every((j) => j.state === "unconfirmed" && j.reason === "request_identity_conflict"));
  const firstBodies = [...raw];
  const unknown = { ...newJob("https://ampcode.com/podcast/episode-1", folder, 0), state: "unknown", sends: 1 };
  const denied = { ...newJob("https://ampcode.com/podcast/episode-2", folder, 0), state: "unconfirmed", reason: "permission_denied", sends: 1 };
  const { store, local } = memory(persistable([unknown, ...refused, denied]));
  const before = structuredClone(store.batchJobs);
  // Only the re-check's own connect is up; the follow-up kick finds the Mac away and touches nothing.
  let connects = 0;
  const runner = createRunner({ local, connect: async () => (connects++ === 0 ? { ok: true, transport } : { ok: false, reason: "unreachable", transport: unavailableTransport() }), schedule: () => 0 });
  accept = true;
  raw.length = 0;
  const reply = await runner.recheckConflicts();
  assert.deepEqual(reply, { ok: true, code: null, count: 2, sent: 2, still: 0 });
  assert.deepEqual(raw, firstBodies);
  const byKey = Object.fromEntries(store.batchJobs.map((j) => [j.request_key, j]));
  for (const j of refused) assert.deepEqual([byKey[j.request_key].state, byKey[j.request_key].want], ["queued", j.want]);
  assert.deepEqual(byKey[unknown.request_key], before[0]);
  assert.deepEqual(byKey[denied.request_key], before[3]);
  // Mac away: nothing is sent and the reply says why.
  const away = memory(before);
  const idle = createRunner({ local: away.local, connect: async () => ({ ok: false, reason: "unreachable", transport: unavailableTransport() }), schedule: () => 0 });
  raw.length = 0;
  assert.deepEqual(await idle.recheckConflicts(), { ok: false, code: "mac_unreachable", count: 2, sent: 0, still: 2 });
  assert.deepEqual(raw, []);
  assert.deepEqual(away.store.batchJobs, before);
});

test("saved-URL index: written on success or 'already exists', kept by 清理已完成 / 从列表移除, capped, no body", async () => {
  const { SAVED_MAX, savedIndexAdd } = await import("../saved-index.js");
  const transport = { ready: true, destination: true, podcast: false,
    enqueue: async (b) => ({ schema_version: 1, job_id: `job_${b.url.slice(-1)}`, state: "succeeded", item_id: `item_${b.url.slice(-1)}`,
      enrichment: b.url.endsWith("2") ? { state: "complete", placement: "existing_locations_preserved" } : { state: "complete", placement: "unfiled" } }),
    status: async () => { throw new Error("unexpected"); } };
  const { store, local } = memory([]);
  const runner = createRunner({ local, connect: async () => ({ ok: true, transport }), schedule: () => 0 });
  const want = { generation: "none", destination: { mode: "inbox" } };
  const keys = await runner.submit([1, 2].map((n) => ({ url: `https://ampcode.com/podcast/episode-${n}`, want, page: null, title: "T" })));
  await runner.kick();
  await runner.prune("done");
  await runner.remove(keys[0]);
  assert.deepEqual(store.batchJobs, []);
  assert.deepEqual(store.savedUrls.map((e) => [e.url, e.item_id]).sort(), [["https://ampcode.com/podcast/episode-1", "item_1"], ["https://ampcode.com/podcast/episode-2", "item_2"]]);
  for (const e of store.savedUrls) assert.deepEqual(Object.keys(e).sort(), ["at", "item_id", "url"]);
  // Canonical (no fragment), deduplicated newest first, capped.
  let index = [];
  for (let i = 0; i < SAVED_MAX + 5; i += 1) index = savedIndexAdd(index, [{ url: `https://a.example/p${i}#x`, item_id: null, at: i }]);
  assert.equal(index.length, SAVED_MAX);
  assert.equal(index[0].url, `https://a.example/p${SAVED_MAX + 4}`);
  index = savedIndexAdd(index, [{ url: "https://a.example/p100", item_id: "i", at: 9e9 }]);
  assert.equal(index.filter((e) => e.url === "https://a.example/p100").length, 1);
  assert.equal(index[0].url, "https://a.example/p100");
});
