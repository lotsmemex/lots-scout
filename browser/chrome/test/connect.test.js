import test from "node:test";
import assert from "node:assert/strict";
import { createProbe, newJob, planFor } from "../jobs.js";
import { connectIntake, createRunner } from "../runner.js";

// Synthetic loopback settings; every request goes to the injected fetch, never to the network.
const SETTINGS = { endpoint: "http://127.0.0.1:3210/api/v1/captures", intakeSecret: "b".repeat(64) };
const settings = { get: async () => ({ ...SETTINGS }) };
const EPISODE = "https://ampcode.com/podcast/season-02/episode-07";
const ALL = ["url-jobs-v1", "url-jobs-no-generation-v1", "url-jobs-enrich-v1", "url-jobs-destination-v1", "url-jobs-active-group-v1"];
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const refused = async () => { throw new TypeError("fetch failed: ECONNREFUSED"); };
const hangs = (_url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)));
const answers = (features) => async () => json({ schema_version: 1, features });

test("connect: refused, timed out, 5xx and warming are 'unreachable'; a 200 or 4xx answer is reachable", async () => {
  const unreachable = { refused, hangs, "503 warming": async () => json({ schema_version: 1, error: "warming_up" }, 503),
    "502": async () => new Response("", { status: 502 }), "500": async () => json({ schema_version: 1, error: "store_failed" }, 500) };
  for (const [name, fetchImpl] of Object.entries(unreachable)) {
    const result = await connectIntake(settings, fetchImpl, { timeoutMs: 20 });
    assert.deepEqual([result.ok, result.reason, result.transport.ready], [false, "unreachable", false], name);
  }
  // Answered, but a feature is missing: reachable; the missing part is held per item and not polled.
  const partial = await connectIntake(settings, answers(["url-jobs-v1"]));
  assert.equal(partial.ok, true);
  assert.deepEqual(planFor(EPISODE, { choice: "inbox", capabilities: partial.capabilities }),
    { ok: false, reason: "missing", missing: ["url-jobs-no-generation-v1", "url-jobs-enrich-v1", "url-jobs-destination-v1"] });
  // An old server without the route (404) answered too: everything is missing, nothing is retried.
  const old = await connectIntake(settings, async () => new Response("", { status: 404 }));
  assert.deepEqual([old.ok, old.capabilities.features, old.transport.ready], [true, [], false]);
  assert.equal((await connectIntake({ get: async () => ({}) }, refused)).reason, "settings");
});

test("probe: 'unreachable' retries with backoff; a missing feature is not retried, only re-read on demand", async () => {
  const timers = [];
  const schedule = (fn, ms) => { timers.push([fn, ms]); return timers.length; };
  let fetchImpl = refused;
  const seen = [];
  const probe = createProbe(() => connectIntake(settings, (...a) => fetchImpl(...a), { timeoutMs: 20 }), (r) => { seen.push(r); },
    { schedule, cancel: () => {}, base: 1000, max: 8000 });
  await probe.run();
  assert.deepEqual(timers.map(([, ms]) => ms), [1000]);
  fetchImpl = answers(["url-jobs-v1"]); // up now, but without the podcast features
  await timers[0][0]();
  assert.equal(seen.at(-1).ok, true);
  assert.equal(timers.length, 1); // permanent: no automatic retry
  fetchImpl = answers(ALL);
  await probe.run(); // the page regained focus
  assert.equal(planFor(EPISODE, { choice: "inbox", capabilities: seen.at(-1).capabilities }).ok, true);
});

test("probe: after the Mac finishes starting up, the scheduled retry alone unlocks submitting", async () => {
  const timers = [];
  let fetchImpl = refused;
  const gate = [];
  // What the panel derives from each probe result: may the checked episode be submitted now?
  const probe = createProbe(() => connectIntake(settings, (...a) => fetchImpl(...a), { timeoutMs: 20 }),
    (r) => { gate.push(r.ok && planFor(EPISODE, { choice: "inbox", capabilities: r.capabilities }).ok); },
    { schedule: (fn, ms) => { timers.push([fn, ms]); return timers.length; }, cancel: () => {}, base: 1000, max: 8000 });
  await probe.run();
  fetchImpl = async () => json({ schema_version: 1, error: "warming_up" }, 503);
  await timers[0][0]();
  fetchImpl = answers(ALL);
  await timers[1][0]();
  assert.deepEqual(gate, [false, false, true]);
  assert.deepEqual(timers.map(([, ms]) => ms), [1000, 2000]);
});

test("runner: while the Mac is unreachable an unknown job keeps its state, key and payload, and is not failed", async () => {
  const store = { ...SETTINGS };
  const local = { get: async (keys) => Object.fromEntries([keys].flat().map((k) => [k, structuredClone(store[k])])),
    set: async (o) => Object.assign(store, structuredClone(o)) };
  const unknown = { ...newJob(EPISODE, { generation: "none", destination: { mode: "inbox" } }), state: "unknown", sends: 1 };
  const article = newJob("https://blog.example/a", { quality: false, comments: false });
  store.batchJobs = [unknown, article];
  const before = structuredClone(store.batchJobs);
  const requests = [];
  let fetchImpl = async (url) => { requests.push(url); throw new TypeError("ECONNREFUSED"); };
  const later = [];
  const runner = createRunner({ local, connect: () => connectIntake(local, (...a) => fetchImpl(...a), { timeoutMs: 20 }),
    schedule: (fn, ms) => { later.push(ms); return later.length; } });
  await runner.kick();
  assert.deepEqual(store.batchJobs, before);
  assert.deepEqual(requests.map((u) => new URL(u).pathname), ["/api/v1/capabilities"]); // no enqueue, no status
  assert.deepEqual(later, [15000]);
  // Up, but answering 503 on the replay itself: still unknown, same key and payload.
  const enqueued = [];
  fetchImpl = async (url, init) => {
    if (url.endsWith("/capabilities")) return json({ schema_version: 1, features: ALL });
    enqueued.push(JSON.parse(init.body));
    return json({ schema_version: 1, error: "warming_up" }, 503);
  };
  await runner.kick();
  const [job] = store.batchJobs;
  assert.deepEqual([job.state, job.request_key, job.want], ["unknown", unknown.request_key, unknown.want]);
  assert.equal(enqueued.find((b) => b.url === EPISODE).request_key, unknown.request_key);
  assert(store.batchJobs.every((j) => !["failed", "rejected", "unavailable", "unconfirmed"].includes(j.state)));
});
