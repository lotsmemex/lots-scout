import test from "node:test";
import assert from "node:assert/strict";
import { discoverCapabilities } from "../capture.js";
import { groupTree, MAX_HISTORY, pushHistory, reconcileHistory, resolveCustom } from "../destination.js";
import { advance, httpTransport, loadActive, loadGroups, newJob, persistable, planFor, prepareSend } from "../jobs.js";
import { jobCategory, jobLabel, pruneJobs, retryableKeys } from "../progress-model.js";
import { openProgress } from "../progress.js";
import { createRunner } from "../runner.js";

const ENDPOINT = "http://127.0.0.1:3210/api/v1/captures";
const SECRET = "b".repeat(64);
const BASE = ["url-jobs-v1", "url-jobs-no-generation-v1", "url-jobs-enrich-v1", "url-jobs-destination-v1"];
const ALL = [...BASE, "url-jobs-active-group-v1", "url-jobs-group-picker-v1"];
const EPISODE = "https://ampcode.com/podcast/season-02/episode-07";
// Synthetic folder IDs only.
const id = (c) => `group_${c.repeat(32)}`;
const [MAIN, AMP, S2, DEEP, RO, ZOT, PAPERS] = ["m", "a", "s", "d", "r", "z", "p"].map(id);
const NODES = [
  { group_id: MAIN, name: "Main", kind: "user", parent_id: null, root_group_id: MAIN, writable: true },
  { group_id: AMP, name: "AmpCode", kind: "collection", parent_id: MAIN, root_group_id: MAIN, writable: true },
  { group_id: S2, name: "Season 2", kind: "collection", parent_id: AMP, root_group_id: MAIN, writable: true },
  { group_id: DEEP, name: "Deep notes", kind: "collection", parent_id: S2, root_group_id: MAIN, writable: true },
  { group_id: RO, name: "Archive", kind: "collection", parent_id: MAIN, root_group_id: MAIN, writable: false },
  { group_id: ZOT, name: "Shared", kind: "zotero_group", parent_id: null, root_group_id: ZOT, writable: false },
  { group_id: PAPERS, name: "Papers", kind: "collection", parent_id: ZOT, root_group_id: ZOT, writable: false }
];
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

// A synthetic intake recording every request (route + raw body).
function intake(features, { active = { group_id: AMP, path: ["Main", "AmpCode"], root_group_id: MAIN, writable: true, updated_at: null }, nodes = NODES, dropFirst = false } = {}) {
  const calls = []; const jobs = new Map(); let dropped = false;
  const fetchImpl = async (url, init) => {
    const route = new URL(url).pathname;
    calls.push([route, init.body]);
    if (route === "/api/v1/capabilities") return json({ schema_version: 1, features });
    if (route === "/api/v1/active-group") return json({ schema_version: 1, ...active });
    if (route === "/api/v1/groups") return json({ schema_version: 1, groups_version: "x", nodes });
    if (route === "/api/v1/url-jobs/enqueue") {
      const body = JSON.parse(init.body);
      if (!jobs.has(body.request_key)) jobs.set(body.request_key, `job_${jobs.size + 1}`);
      if (dropFirst && !dropped) { dropped = true; throw new TypeError("connection reset"); }
      return json({ schema_version: 1, job_id: jobs.get(body.request_key), state: "queued" });
    }
    return new Response("", { status: 404 });
  };
  const sent = (route) => calls.filter(([r]) => r === route).map(([, body]) => body);
  return { fetchImpl, calls, sent };
}
const connect = async (server) => {
  const capabilities = await discoverCapabilities(ENDPOINT, SECRET, server.fetchImpl);
  return { capabilities, transport: httpTransport(ENDPOINT, SECRET, server.fetchImpl, capabilities) };
};
const targets = async ({ capabilities, transport }, custom) => {
  const groups = await loadGroups(transport, capabilities);
  return { active: await loadActive(transport, capabilities), groups, custom: resolveCustom(custom, groups) };
};

test("three destinations: exact enqueue bodies (inbox has no target; folders send selected_group + that ID only)", async () => {
  const server = intake(ALL);
  const conn = await connect(server);
  const { active, custom } = await targets(conn, { group_id: DEEP, path: ["stale name"] });
  for (const choice of ["inbox", "current", "custom"]) {
    const plan = planFor(EPISODE, { choice, capabilities: conn.capabilities, active, custom });
    assert.equal(plan.ok, true, choice);
    const job = newJob(EPISODE, plan.want);
    await advance(prepareSend(job, conn.transport), conn.transport);
  }
  const bodies = server.sent("/api/v1/url-jobs/enqueue").map((raw) => { const { request_key, ...rest } = JSON.parse(raw); return rest; });
  const common = { schema_version: 1, url: EPISODE, include_comments: false, quality_check: "off", generation_policy: "none" };
  assert.deepEqual(bodies, [
    { ...common, destination_mode: "inbox" },
    { ...common, destination_mode: "selected_group", target_group_id: AMP },
    { ...common, destination_mode: "selected_group", target_group_id: DEEP }
  ]);
  // The display path is a snapshot of the current names, never sent.
  assert.deepEqual(custom.path, ["Main", "AmpCode", "Season 2", "Deep notes"]);
  for (const raw of server.sent("/api/v1/url-jobs/enqueue")) assert.doesNotMatch(raw, /path|remove_from|Main/);
  // Both reads are exactly {schema_version:1}.
  assert.deepEqual([...server.sent("/api/v1/active-group"), ...server.sent("/api/v1/groups")], ['{"schema_version":1}', '{"schema_version":1}']);
});

test("gates: current needs active-group-v1, custom needs group-picker-v1, both need destination-v1; nothing is read without them", async () => {
  const noPicker = intake(BASE.concat("url-jobs-active-group-v1"));
  const c1 = await connect(noPicker);
  const t1 = await targets(c1, { group_id: DEEP, path: ["x"] });
  assert.deepEqual(t1.groups, { state: "closed", missing: ["url-jobs-group-picker-v1"] });
  assert.deepEqual(planFor(EPISODE, { choice: "custom", capabilities: c1.capabilities, custom: t1.custom }), { ok: false, reason: "missing", missing: ["url-jobs-group-picker-v1"] });
  assert.deepEqual(noPicker.sent("/api/v1/groups"), []);
  const noActive = intake(BASE.concat("url-jobs-group-picker-v1"));
  const c2 = await connect(noActive);
  const t2 = await targets(c2, null);
  assert.equal(planFor(EPISODE, { choice: "current", capabilities: c2.capabilities, active: t2.active }).reason, "missing");
  assert.deepEqual(noActive.sent("/api/v1/active-group"), []);
  const noDest = intake(ALL.filter((f) => f !== "url-jobs-destination-v1"));
  const c3 = await connect(noDest);
  await targets(c3, null);
  for (const choice of ["inbox", "current", "custom"]) assert.equal(planFor(EPISODE, { choice, capabilities: c3.capabilities }).reason, "missing");
  assert.deepEqual([...noDest.sent("/api/v1/active-group"), ...noDest.sent("/api/v1/groups")], []);
  // The Mac's current folder is null: held with a reason, never sent to Inbox instead.
  const none = intake(ALL, { active: { group_id: null, path: [], root_group_id: null, writable: false, updated_at: null } });
  const c4 = await connect(none);
  const t4 = await targets(c4, null);
  assert.deepEqual(planFor(EPISODE, { choice: "current", capabilities: c4.capabilities, active: t4.active }), { ok: false, reason: "active" });
  assert.deepEqual(none.sent("/api/v1/url-jobs/enqueue"), []);
});

test("folder tree: writable roots and folders at any depth are selectable, read-only ones are not", () => {
  const nodes = groupTree({ nodes: NODES });
  assert.deepEqual([...nodes.values()].map((n) => [n.path.join("/"), n.depth, n.writable]), [
    ["Main", 0, true], ["Main/AmpCode", 1, true], ["Main/AmpCode/Season 2", 2, true], ["Main/AmpCode/Season 2/Deep notes", 3, true],
    ["Main/Archive", 1, false], ["Shared", 0, false], ["Shared/Papers", 1, false]]);
  const groups = { state: "ok", nodes };
  assert.equal(resolveCustom({ group_id: DEEP, path: [] }, groups).state, "ok");
  assert.equal(resolveCustom({ group_id: MAIN, path: [] }, groups).state, "ok");
  assert.deepEqual(resolveCustom({ group_id: RO, path: [] }, groups), { state: "blocked", reason: "readonly", path: ["Main", "Archive"] });
  assert.equal(resolveCustom({ group_id: id("g"), path: ["Gone"] }, groups).reason, "missing");
  assert.equal(resolveCustom(null, groups).reason, "unset");
  const ro = resolveCustom({ group_id: RO, path: [] }, groups);
  assert.deepEqual(planFor(EPISODE, { choice: "custom", capabilities: { features: ALL }, custom: ro }), { ok: false, reason: "custom" });
});

test("recent folders: duplicates move to the front, at most 10, gone ones hidden, read-only marked, renames shown", () => {
  let history = [];
  for (let i = 0; i < 12; i += 1) history = pushHistory(history, { group_id: id(String.fromCharCode(97 + i)), path: [`F${i}`] });
  assert.equal(history.length, MAX_HISTORY);
  assert.equal(history[0].group_id, id("l"));
  history = pushHistory(history, { group_id: id("e"), path: ["F4 again"] });
  assert.equal(history.length, MAX_HISTORY);
  assert.deepEqual(history.slice(0, 2).map((h) => h.group_id), [id("e"), id("l")]);
  assert.equal(history.filter((h) => h.group_id === id("e")).length, 1);
  assert.deepEqual(Object.keys(history[0]).sort(), ["group_id", "path"]);
  const stored = [{ group_id: DEEP, path: ["Main", "Old name"] }, { group_id: id("g"), path: ["Gone"] }, { group_id: RO, path: ["Main", "Archive"] }];
  assert.deepEqual(reconcileHistory(stored, { state: "ok", nodes: groupTree({ nodes: NODES }) }), [
    { group_id: DEEP, path: ["Main", "AmpCode", "Season 2", "Deep notes"], writable: true },
    { group_id: RO, path: ["Main", "Archive"], writable: false }]);
  // Not checked yet (list unavailable): nothing is shown.
  assert.deepEqual(reconcileHistory(stored, { state: "closed", missing: [] }), []);
});

test("an old folder job replays its original request body byte for byte, even after the folder or choice changed", async () => {
  const server = intake(ALL, { dropFirst: true });
  const conn = await connect(server);
  const { custom } = await targets(conn, { group_id: DEEP, path: [] });
  const job = newJob(EPISODE, planFor(EPISODE, { choice: "custom", capabilities: conn.capabilities, custom }).want);
  const lost = await advance(prepareSend(job, conn.transport), conn.transport);
  assert.equal(lost.state, "unknown");
  // Reloaded from storage after the user switched to another destination: the job keeps its own.
  const [reloaded] = persistable([lost]);
  await advance(prepareSend(reloaded, conn.transport), conn.transport);
  const [first, replay] = server.sent("/api/v1/url-jobs/enqueue");
  assert.equal(replay, first);
  assert.equal(JSON.parse(first).target_group_id, DEEP);
});

test("progress: clear done / delete failed touch local records only; bulk retry skips unknown and needs-you jobs", async () => {
  const mk = (state, extra = {}) => ({ ...newJob(EPISODE, { generation: "none", destination: { mode: "inbox" } }), state, job_id: `j_${state}`, ...extra });
  const jobs = [mk("succeeded"), mk("cancelled"), mk("failed", { can_retry: true, reason: "podcast_retry" }), mk("failed", { can_retry: false }),
    mk("rejected"), mk("unknown", { can_retry: true }), mk("unconfirmed", { can_retry: true }), mk("queued"), mk("blocked")];
  assert.deepEqual(jobs.map(jobCategory), ["done", "done", "failed", "failed", "failed", "busy", "needs", "busy", "needs"]);
  assert.deepEqual(pruneJobs(jobs, "done").map((j) => j.state), ["failed", "failed", "rejected", "unknown", "unconfirmed", "queued", "blocked"]);
  assert.deepEqual(pruneJobs(jobs, "failed").map((j) => j.state), ["succeeded", "cancelled", "unknown", "unconfirmed", "queued", "blocked"]);
  assert.deepEqual(retryableKeys(jobs), [jobs[2].request_key]);

  const store = { batchJobs: structuredClone(jobs) };
  const local = { get: async (k) => ({ [k]: structuredClone(store[k]) }), set: async (o) => Object.assign(store, structuredClone(o)) };
  const calls = [];
  const transport = { ready: true, destination: true, podcast: false,
    retry: async (b) => { calls.push(["retry", b]); return { schema_version: 1, job_id: b.job_id, state: "queued" }; },
    enqueue: async (b) => { calls.push(["enqueue", b]); throw Object.assign(new Error("x"), { code: "unknown" }); },
    status: async (b) => { calls.push(["status", b]); return { schema_version: 1, job_id: b.job_id, state: "queued" }; } };
  let connects = 0;
  const runner = createRunner({ local, connect: async () => { connects += 1; return { ok: false, transport }; }, schedule: () => 0 });
  await runner.prune("done");
  await runner.prune("failed");
  assert.equal(connects, 0);
  assert.deepEqual(calls, []);
  assert.deepEqual(store.batchJobs.map((j) => j.state), ["unknown", "unconfirmed", "queued", "blocked"]);

  const before = structuredClone(jobs);
  store.batchJobs = structuredClone(jobs);
  const retrying = createRunner({ local, connect: async () => ({ ok: true, transport }), schedule: () => 0 });
  calls.length = 0;
  await retrying.retryFailed();
  assert.deepEqual(calls.filter(([kind]) => kind === "retry").map(([, b]) => b.job_id), ["j_failed"]);
  const after = Object.fromEntries(store.batchJobs.map((j) => [j.request_key, j]));
  // The retried job keeps its key and payload; the retry names only the Mac's existing job.
  assert.deepEqual([after[before[2].request_key].request_key, after[before[2].request_key].want], [before[2].request_key, before[2].want]);
  assert.deepEqual(calls.find(([kind]) => kind === "retry")[1], { job_id: "j_failed" });
  // The unknown and unconfirmed jobs keep their key, state and payload.
  for (const i of [5, 6]) assert.deepEqual([after[before[i].request_key].state, after[before[i].request_key].want], [before[i].state, before[i].want]);
});

test("progress opens in the side panel, and falls back to a tab when the side panel is unavailable", async () => {
  const api = (sidePanel) => {
    const log = [];
    return { log, sidePanel, tabs: { create: async (o) => { log.push(["tab", o.url]); } }, runtime: { getURL: (p) => `chrome-extension://x/${p}` } };
  };
  const ok = api({ open: async (o) => { ok.log.push(["side", o.windowId]); } });
  assert.equal(await openProgress(ok, { windowId: 7 }), "side");
  assert.deepEqual(ok.log, [["side", 7]]);
  for (const sidePanel of [undefined, {}, { open: async () => { throw new Error("no gesture"); } }, { open: () => { throw new Error("sync"); } }]) {
    const fallback = api(sidePanel);
    assert.equal(await openProgress(fallback, { windowId: 7 }), "tab");
    assert.deepEqual(fallback.log, [["tab", "chrome-extension://x/progress.html"]]);
  }
  const noWindow = api({ open: async () => {} });
  assert.equal(await openProgress(noWindow, {}), "tab");
});

test("progress rows are named by the saved title, else the URL's distinguishing slug; the title is never sent", async () => {
  const want = { generation: "none", destination: { mode: "inbox" } };
  assert.equal(jobLabel(newJob(EPISODE, want, 0, null, "  Culture Stops Slop ")), "Culture Stops Slop");
  // Old jobs saved without a title.
  assert.equal(jobLabel({ url: EPISODE }), "season-02-episode-07");
  assert.equal(jobLabel({ url: "https://ampcode.com/podcast/episode-5", title: null }), "episode-5");
  assert.equal(jobLabel({ url: "https://blog.example/2026/11/a-post" }), "a-post");
  assert.equal(jobLabel({ url: "https://blog.example/" }), "blog.example");
  // Submitted with a title: kept locally, absent from the enqueue body.
  const store = {};
  const local = { get: async (k) => ({ [k]: structuredClone(store[k]) }), set: async (o) => Object.assign(store, structuredClone(o)) };
  const bodies = [];
  const transport = { ready: true, destination: true, podcast: false,
    enqueue: async (b) => { bodies.push(b); return { schema_version: 1, job_id: "j1", state: "queued" }; }, status: async () => ({ schema_version: 1, job_id: "j1", state: "queued" }) };
  const runner = createRunner({ local, connect: async () => ({ ok: true, transport }), schedule: () => 0 });
  await runner.submit([{ url: EPISODE, want, page: null, title: "Culture Stops Slop" }]);
  await runner.kick();
  assert.equal(store.batchJobs[0].title, "Culture Stops Slop");
  assert.equal(bodies.length, 1);
  assert.doesNotMatch(JSON.stringify(bodies), /Culture|title/);
});
