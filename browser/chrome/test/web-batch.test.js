import test from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { extractArticleSnapshot } from "../extractor.js";
import { createWebCapture, intakeBinding, renderWebPage, webOrigin, webPageIdentity } from "../web-batch.js";
import { newJob, planFor } from "../jobs.js";
import { createRunner } from "../runner.js";
import { canRestartWeb, describe } from "../progress-model.js";
import { sha256Hex } from "../capture.js";

const url = "https://claude.dev/blog/synthetic-reference/";
const destination = { mode: "group", group_id: `group_${"a".repeat(32)}`, path: ["Main", "Synthetic posts"] };
const want = { web_snapshot: true, destination };
const settings = { endpoint: "http://127.0.0.1:3210/api/v1/captures", intakeSecret: "a".repeat(64) };
const boundWant = { ...want, intake_binding: await intakeBinding(settings) };
const json = (body) => new Response(JSON.stringify(body));
const receipt = () => json({ schema_version: 1, item_id: "item_synthetic", revision_id: "revision_synthetic" });
const snapshot = { sourceUrl: url, canonicalUrl: null, title: "Synthetic reference", metadata: {}, html: "<article><h1>Reference</h1><p>Only synthetic content.</p></article>" };

test("web plans freeze deep destinations, do not request models, and preserve legacy gates", () => {
  const plan = planFor(url, { capabilities: { webSnapshot: true }, choice: "custom", custom: { state: "ok", ...destination }, defaults: { quality: true, comments: true } });
  assert.deepEqual(plan.want, want);
  assert.equal(newJob(url, want).want.quality, false);
  assert.equal(planFor(url, { capabilities: { webSnapshot: true }, choice: "current", active: { state: "blocked" } }).ok, false);
  assert.equal(planFor(url, { capabilities: { urlJobs: true }, choice: "custom" }).reason, "article_needs_inbox");
  assert.equal(webOrigin(url), "https://claude.dev/*");
  for (const bad of ["http://claude.dev/a", "https://127.1/a", "https://0x7f000001/a", "https://[::1]/", "https://10.0.0.1/a", "https://localhost/a", "https://printer.local/a", "https://docs.internal/a", "https://printer.home.arpa/a", "https://printer.localdomain/a", "https://u:p@claude.dev/a", "https://claude.dev:444/a", url + "#fragment", url + "#"])
    assert.equal(webOrigin(bad), null, bad);
});

test("unknown snapshot replays identical bytes after restart, without a second browser visit", async () => {
  const db = new Map(), sent = [], saved = [];
  let visits = 0, fail = true;
  const deps = { local: { get: async () => settings }, capabilities: async () => ({ webSnapshot: true }),
    pending: async (action, key, value) => action === "get" ? db.get(key) : action === "put" ? db.set(key, value) : db.delete(key),
    render: async () => { visits++; return { snapshot, evidence: { images: [], missing: 2 } }; },
    post: async (_endpoint, _secret, body) => {
      assert.equal(saved.at(-1).state, "unknown");
      assert.equal(db.size, 1);
      sent.push(Buffer.from(await body.arrayBuffer()));
      if (fail) throw new Error("lost receipt");
      return receipt();
    } };
  const save = async (job) => saved.push(structuredClone(job));
  let job = await createWebCapture(deps)(newJob(url, boundWant, 1), save);
  assert.deepEqual([job.state, job.sends, visits], ["unconfirmed", 1, 1]);
  fail = false;
  job = await createWebCapture({ ...deps, render: async () => { throw new Error("must not recapture"); } })(job, save);
  assert.deepEqual([job.state, job.sends, job.missing_images, db.size], ["succeeded", 2, 2, 0]);
  assert.deepEqual(sent[0], sent[1]);
  const manifest = JSON.parse(sent[0].subarray(12, 12 + sent[0].readUInt32BE(8)));
  assert.equal(manifest.external_capture_id, job.request_key);
  assert.equal(manifest.web.target_group_id, destination.group_id);
  assert.equal(manifest.quality_check, undefined);
  assert.match(describe(job).text, /网页快照已入库.*2 张图片/);
  const missing = await createWebCapture(deps)({ ...job, state: "unknown" }, save);
  assert.equal(missing.reason, "snapshot_missing");
  assert.equal(sent.length, 2);
});

test("capability loss, changed intake and missing cached response never recapture or send", async () => {
  let sent = 0, visits = 0;
  const deps = { local: { get: async () => settings }, pending: async () => undefined,
    capabilities: async () => ({ webSnapshot: false }), render: async () => { visits++; }, post: async () => { sent++; } };
  const job = newJob(url, boundWant);
  assert.equal((await createWebCapture(deps)(job, async () => {})).reason, "web_feature_missing");
  assert.equal((await createWebCapture({ ...deps, pending: async () => ({ binding: "different" }) })(job, async () => {})).reason, "intake_changed");
  assert.equal((await createWebCapture(deps)({ ...job, sends: 1 }, async () => {})).reason, "snapshot_missing");
  assert.deepEqual([visits, sent], [0, 0]);
});

test("browser visits only a permitted visible target, refuses redirects and always closes its own tab", async () => {
  const calls = []; let reads = 0;
  const api = { permissions: { contains: async () => true },
    tabs: { create: async (options) => { calls.push(options); return { id: 17 }; },
      get: async () => ({ url, status: "complete" }), remove: async (id) => calls.push(id) },
    scripting: { executeScript: async ({ func, target, args }) => {
      reads++;
      if (func.name === "extractArticleSnapshot") {
        assert.deepEqual(target, { tabId: 17, documentIds: ["checked-document"] });
        assert.equal(args[0].expectedSourceUrl, url);
      }
      return [{ result: func.name === "extractArticleSnapshot" ? snapshot : true, documentId: "checked-document" }];
    } } };
  assert.deepEqual((await renderWebPage(api, url)).snapshot, snapshot);
  assert.deepEqual(calls, [{ url, active: true }, 17]);
  const originalReads = reads;
  for (const changed of ["https://127.0.0.1/", url + "?", url + "#"]) {
    api.tabs.get = async () => ({ url: changed, status: "complete" });
    await assert.rejects(renderWebPage(api, url), /web_redirected/);
    assert.equal(calls.at(-1), 17);
    assert.equal(reads, originalReads);
  }
  api.permissions.contains = async () => false;
  const count = calls.length;
  await assert.rejects(renderWebPage(api, url), /site_permission_required/);
  assert.equal(calls.length, count);
  api.permissions.contains = async () => true;
  api.tabs.get = async () => ({ url, status: "complete" });
  api.scripting.executeScript = async ({ func, args }) => [{ documentId: "new-document", result:
    runInNewContext(`(${func.toString()})(...args)`, { URL, args, location: { href: url + "?" },
      document: new Proxy({}, { get() { throw new Error("must not read changed DOM"); } }) }) }];
  await assert.rejects(renderWebPage(api, url), /page_changed/);
});

test("runner keeps one frozen identity per selected URL, yields visits, and cancels unsent jobs", async () => {
  const mem = { ...settings, batchJobs: [] }, visited = [];
  const local = { get: async (keys) => Object.fromEntries([keys].flat().map((k) => [k, structuredClone(mem[k])])), set: async (data) => Object.assign(mem, structuredClone(data)) };
  const runner = createRunner({ local, connect: async () => ({ ok: true, transport: {} }), schedule: () => 1,
    captureWeb: async (job) => { visited.push(job.url); return { ...job, state: "unconfirmed", sends: 1, can_cancel: false }; } });
  const items = [url, "https://claude.dev/blog/second/"] .map((url) => ({ url, want: boundWant, occurrences: [{ role: "citation", href: url + "#section" }] }));
  const keys = await runner.submit(items);
  await runner.kick();
  assert.deepEqual(visited, [url, items[1].url]);
  await assert.rejects(runner.submit(items), /web_identity_protected/);
  assert.deepEqual(mem.batchJobs.map(j => j.request_key), keys);
  await runner.kick();
  assert.equal(visited.length, 2); // Unknown is explicit-only, not auto POST.
  assert.equal(mem.batchJobs[0].occurrences[0].href, url + "#section");
  mem.batchJobs.push({ ...newJob("https://claude.dev/blog/unsent/", want), can_cancel: true });
  assert.equal((await runner.act(mem.batchJobs.at(-1).request_key, "cancel")).ok, true);
  assert.equal(mem.batchJobs.at(-1).state, "cancelled");
});

test("serialized URL guard normalizes host/scheme case and one trailing slash, before any DOM read", () => {
  const injected = `(${extractArticleSnapshot.toString()})({expectedSourceUrl: expected})`;
  const context = (href) => ({ URL, location: { href }, expected: url,
    document: new Proxy({}, { get() { throw new Error("DOM reached"); } }) });
  for (const changed of [url.replace("synthetic-reference", "Synthetic-reference"), url + "?q=1", url + "?", url + "#a", url + "#", url + "/", "https://other.claude.dev/blog/synthetic-reference/"]) {
    assert.equal(webPageIdentity(changed) === webPageIdentity(url), false);
    assert.equal(runInNewContext(injected, context(changed)).code, "page_changed");
  }
  for (const equivalent of [url, "HTTPS://CLAUDE.DEV/blog/synthetic-reference"]) {
    assert.equal(webPageIdentity(equivalent), webPageIdentity(url));
    assert.throws(() => runInNewContext(injected, context(equivalent)), /DOM reached/);
  }
});

test("frozen intake rejects settings drift before queueing, before first visit and before POST", async () => {
  let current = settings, visits = 0, sends = 0;
  const local = { get: async () => current, set: async () => { throw new Error("must not queue"); } };
  const changed = { ...settings, intakeSecret: "b".repeat(64) };
  const runner = createRunner({ local, connect: async () => ({ ok: true }), captureWeb: async () => {}, schedule: () => 1 });
  current = changed;
  await assert.rejects(runner.submit([{ url, want: boundWant }]), /intake_changed/);
  const deps = { local, pending: async () => undefined, capabilities: async () => ({ webSnapshot: true }),
    render: async () => { visits++; current = changed; return { snapshot, evidence: { images: [], missing: 0 } }; }, post: async () => { sends++; return receipt(); } };
  const job = newJob(url, boundWant);
  assert.equal((await createWebCapture(deps)(job, async () => {})).reason, "intake_changed");
  assert.equal((await createWebCapture(deps)(newJob(url, want), async () => {})).reason, "intake_changed");
  assert.equal(visits, 0);
  current = settings;
  assert.equal((await createWebCapture(deps)(job, async () => {})).reason, "intake_changed");
  assert.deepEqual([visits, sends], [1, 0]);
});

test("rendering disables cancellation before visiting and interrupted visits never automatically restart", async () => {
  const saved = [];
  const capture = createWebCapture({ local: { get: async () => settings }, pending: async () => undefined,
    capabilities: async () => ({ webSnapshot: true }), render: async () => {
      assert.deepEqual([saved.at(-1).state, saved.at(-1).can_cancel, saved.at(-1).can_retry], ["needs_user", false, false]);
      throw new Error("web_redirected");
    }, post: async () => { throw new Error("must not POST"); } });
  const stopped = await capture(newJob(url, boundWant), async (job) => saved.push(job));
  assert.equal(stopped.reason, "web_redirected");
  assert.equal(stopped.can_retry, false);
  const mem = { batchJobs: saved }, local = { get: async () => mem, set: async () => {} };
  const runner = createRunner({ local, connect: async () => ({ ok: true }), captureWeb: async () => { throw new Error("must not reopen interrupted visit"); } });
  await runner.kick();
});

test("snapshot and intent storage failures prevent POST; lost success persists original bytes for recheck", async () => {
  for (const failure of ["snapshot", "intent", "success", "cleanup"]) {
    const db = new Map(), saved = [], sent = [];
    let visits = 0;
    const deps = { local: { get: async () => settings }, capabilities: async () => ({ webSnapshot: true }),
      pending: async (action, key, value) => {
        if (failure === "snapshot" && action === "put") throw new Error("synthetic IDB write failure");
        if (failure === "cleanup" && action === "delete") throw new Error("synthetic IDB cleanup failure");
        return action === "get" ? db.get(key) : action === "put" ? db.set(key, value) : db.delete(key);
      }, render: async () => { visits++; return { snapshot, evidence: { images: [], missing: 0 } }; },
      post: async (_endpoint, _secret, body) => { sent.push(Buffer.from(await body.arrayBuffer())); return receipt(); } };
    const save = async (job) => {
      if ((failure === "intent" && job.state === "unknown") || (failure === "success" && job.state === "succeeded")) throw new Error("synthetic job storage failure");
      saved.push(job);
    };
    const job = newJob(url, boundWant);
    if (failure === "intent") {
      await assert.rejects(createWebCapture(deps)(job, save), /job storage failure/);
      assert.equal(saved.at(-1).can_cancel, false);
      assert.deepEqual([sent.length, db.size], [0, 1]);
    } else {
      const result = await createWebCapture(deps)(job, save);
      if (failure === "snapshot") assert.deepEqual([result.state, sent.length], ["needs_user", 0]);
      if (failure === "cleanup") assert.deepEqual([result.state, saved.at(-1).state, sent.length], ["succeeded", "succeeded", 1]);
      if (failure === "success") {
        assert.deepEqual([result.state, db.size, sent.length], ["unconfirmed", 1, 1]);
        const done = await createWebCapture(deps)(result, async () => {});
        assert.equal(done.state, "succeeded");
        assert.deepEqual(sent[0], sent[1]);
      }
    }
    assert.equal(visits, 1);
  }
});

test("only an explicit admission rejection proves a 422 was not committed; bytes and identity survive", async () => {
  for (const [status, error, expected] of [
    [422, { schema_version: 1, error: "capture_admission_rejected", reason_code: "interactive_control_detected" }, "failed"],
    [422, { schema_version: 1, error: "request_rejected" }, "unconfirmed"],
    [422, null, "unconfirmed"],
    [500, { schema_version: 1, error: "capture_admission_rejected", reason_code: "interactive_control_detected" }, "unconfirmed"],
  ]) {
    const db = new Map();
    const original = newJob(url, boundWant);
    const capture = createWebCapture({ local: { get: async () => settings }, capabilities: async () => ({ webSnapshot: true }),
      pending: async (action, key, value) => action === "get" ? db.get(key) : action === "put" ? db.set(key, value) : db.delete(key),
      render: async () => ({ snapshot, evidence: { images: [], missing: 0 } }),
      post: async () => new Response(error ? JSON.stringify(error) : "not json", { status }) });
    const result = await capture(original, async () => {});
    assert.equal(result.state, expected);
    assert.equal(result.request_key, original.request_key);
    assert.equal(db.size, 1);
    const bytes = Buffer.from(await db.get(original.request_key).body.arrayBuffer());
    assert.equal(JSON.parse(bytes.subarray(12, 12 + bytes.readUInt32BE(8))).external_capture_id, original.request_key);
  }
});

test("owner-verified fresh capture preserves the old unknown and bytes, and duplicate clicks create one new identity", async () => {
  const old = { ...newJob(url, boundWant, 1000), state: "unconfirmed", reason: "intake_422", sends: 1, can_retry: false, can_cancel: false };
  const original = JSON.stringify(old), body = new Blob(["immutable original rejected snapshot"]);
  const verification = { schema_version: 1, request_key: old.request_key, url, intake_binding: boundWant.intake_binding,
    group_id: destination.group_id, observed_updated_at: old.updated_at, checked_at: 2000,
    job_sha256: await sha256Hex(new TextEncoder().encode(original)), snapshot_sha256: await sha256Hex(new Uint8Array(await body.arrayBuffer())),
    queries: { source_url: { method: "local_store_url_index_scan", count: 0 }, target_group: { method: "local_store_membership_scan", count: 0 } } };
  assert.equal(canRestartWeb(old), false);
  assert.equal(canRestartWeb(old, verification), true);
  for (const queries of [
    { ...verification.queries, source_url: { ...verification.queries.source_url, count: 1 } },
    { ...verification.queries, target_group: { ...verification.queries.target_group, count: 1 } },
    { ...verification.queries, source_url: { method: "failed", count: 0 } },
  ]) assert.equal(canRestartWeb(old, { ...verification, queries }), false);
  assert.equal(canRestartWeb({ ...old, state: "needs_user", reason: "web_redirected" }, verification), false);
  const mem = { ...settings, batchJobs: [structuredClone(old)], webSnapshotVerifications: {} };
  const local = { get: async (keys) => Object.fromEntries([keys].flat().map(k => [k, structuredClone(mem[k])])),
    set: async data => Object.assign(mem, structuredClone(data)) };
  const visited = [];
  const runner = createRunner({ local, pending: async (action, key) => {
    assert.equal(action, "get"); assert.equal(key, old.request_key); return { body, binding: boundWant.intake_binding };
  }, connect: async () => ({ ok: true, transport: {} }), schedule: () => 1,
  captureWeb: async job => { visited.push(job.request_key); return { ...job, state: "unconfirmed", reason: "unknown_capture", sends: 1 }; } });
  assert.equal((await runner.act(old.request_key, "retry")).ok, false);
  assert.equal(mem.batchJobs.length, 1);
  mem.webSnapshotVerifications[old.request_key] = { ...verification, snapshot_sha256: "0".repeat(64) };
  assert.equal((await runner.act(old.request_key, "retry")).ok, false);
  mem.webSnapshotVerifications[old.request_key] = verification;
  const first = await runner.act(old.request_key, "retry");
  assert.equal(first.ok, true);
  assert.notEqual(first.new_request_key, old.request_key);
  const second = await runner.act(old.request_key, "retry");
  assert.equal(second.new_request_key, first.new_request_key);
  await runner.kick();
  assert.deepEqual(visited, [first.new_request_key]);
  assert.equal(mem.batchJobs.length, 2);
  assert.equal(JSON.stringify(mem.batchJobs.find(j => j.request_key === old.request_key)), original);
  const archive = mem.webSnapshotArchives[old.request_key];
  assert.equal(JSON.stringify(archive.original_job), original);
  assert.deepEqual(archive.verification, verification);
  assert.equal(canRestartWeb(old, verification, archive), false);
  assert.equal(await sha256Hex(new Uint8Array(await body.arrayBuffer())), verification.snapshot_sha256);
  await runner.recheck(old.request_key);
  await runner.remove(old.request_key);
  assert.equal(JSON.stringify(mem.batchJobs.find(j => j.request_key === old.request_key)), original);
  assert.deepEqual(visited, [first.new_request_key]);
});

test("fresh capture recovers its committed replacement ID after interrupted publication and never resurrects cleaned jobs", async () => {
  for (const state of ["unconfirmed", "failed"]) {
    const old = { ...newJob(url, boundWant, 1000), state,
      reason: state === "failed" ? "interactive_control_detected" : "intake_422", sends: 1, can_retry: false, can_cancel: false };
    const body = new Blob(["retained original snapshot"]), original = JSON.stringify(old);
    const verification = { schema_version: 1, request_key: old.request_key, url, intake_binding: boundWant.intake_binding,
      group_id: destination.group_id, observed_updated_at: old.updated_at, checked_at: 2000,
      job_sha256: await sha256Hex(new TextEncoder().encode(original)), snapshot_sha256: await sha256Hex(new Uint8Array(await body.arrayBuffer())),
      queries: { source_url: { method: "local_store_url_index_scan", count: 0 }, target_group: { method: "local_store_membership_scan", count: 0 } } };
    assert.equal(canRestartWeb(old), false);
    assert.equal(canRestartWeb(old, verification), true);
    const mem = { ...settings, batchJobs: [structuredClone(old)], webSnapshotVerifications: { [old.request_key]: verification } };
    let interrupt = true, visits = 0;
    const local = { get: async keys => Object.fromEntries([keys].flat().map(k => [k, structuredClone(mem[k])])),
      set: async data => { if (data.batchJobs && interrupt) { interrupt = false; throw new Error("publication interrupted"); } Object.assign(mem, structuredClone(data)); } };
    const make = () => createRunner({ local, pending: async () => ({ body, binding: boundWant.intake_binding }),
      connect: async () => ({ ok: false }), schedule: () => 1 });
    await assert.rejects(make().act(old.request_key, "retry"), /publication interrupted/);
    const key = mem.webSnapshotArchives[old.request_key].replacement_job.request_key;
    assert.notEqual(key, old.request_key);
    const recovered = make();
    assert.equal((await recovered.act(old.request_key, "retry")).new_request_key, key);
    assert.deepEqual(mem.batchJobs.map(j => j.request_key), [old.request_key, key]);
    const running = createRunner({ local, connect: async () => ({ ok: true }), schedule: () => 1,
      captureWeb: async job => { visits++; return { ...job, state: "succeeded", item_id: "item_synthetic", revision_id: "revision_synthetic" }; } });
    await running.kick();
    await running.remove(key);
    await running.prune("done");
    await running.prune("failed");
    await running.kick();
    assert.equal(visits, 1);
    assert.equal(mem.batchJobs.find(j => j.request_key === key).state, "succeeded");
    assert.equal(JSON.stringify(mem.batchJobs.find(j => j.request_key === old.request_key)), original);
    assert.equal(JSON.stringify(mem.webSnapshotArchives[old.request_key].original_job), original);
  }
});

test("ordinary submit and current-tab capture cannot bypass unarchived sent identities or their owner-verified replacements", async () => {
  for (const state of ["failed", "unconfirmed"]) {
    const old = { ...newJob(url, boundWant, 1000), state, sends: 1, can_retry: false,
      reason: state === "failed" ? "interactive_control_detected" : "intake_422" };
    const body = new Blob(["original bytes"]), original = JSON.stringify(old);
    const mem = { ...settings, batchJobs: [structuredClone(old)] };
    const local = { get: async keys => Object.fromEntries([keys].flat().map(k => [k, structuredClone(mem[k])])),
      set: async data => Object.assign(mem, structuredClone(data)) };
    const runner = createRunner({ local, connect: async () => ({ ok: false }), schedule: () => 1,
      pending: async () => ({ body, binding: boundWant.intake_binding }), captureWeb: async () => { throw Error("must not visit"); } });
    const ordinary = () => runner.submit([{ url, want: boundWant }]);
    const current = () => runner.captureCurrent(url, boundWant, () => { throw Error("must not capture"); });
    await assert.rejects(ordinary(), /web_identity_protected/);
    await assert.rejects(current(), /web_identity_protected/);
    await runner.remove(old.request_key); await runner.prune("failed");
    assert.equal(JSON.stringify(mem.batchJobs[0]), original);
    const overflow = Array.from({length:200},(_,i)=>({url:`https://claude.dev/blog/synthetic-${i}/`,want:boundWant}));
    await assert.rejects(runner.submit(overflow), /batch_storage_full/);
    assert.equal(mem.batchJobs.length, 1);
    mem.webSnapshotVerifications = { [old.request_key]: { schema_version: 1, request_key: old.request_key, url,
      intake_binding: boundWant.intake_binding, group_id: destination.group_id, observed_updated_at: 1000, checked_at: 2000,
      job_sha256: await sha256Hex(new TextEncoder().encode(original)), snapshot_sha256: await sha256Hex(new Uint8Array(await body.arrayBuffer())),
      queries: {source_url:{method:"local_store_url_index_scan",count:0},target_group:{method:"local_store_membership_scan",count:0}} } };
    const fresh = await runner.act(old.request_key,"retry");
    assert.equal(fresh.ok,true); assert.notEqual(fresh.new_request_key,old.request_key);
    await assert.rejects(current(), /web_identity_protected/);
    // Ordinary submit may reuse the explicit replacement, but cannot mint another.
    assert.deepEqual(await ordinary(),[fresh.new_request_key]);
    await runner.act(fresh.new_request_key,"cancel");
    await assert.rejects(ordinary(), /web_identity_protected/);
    assert.equal(mem.batchJobs.length,2);
  }
});

test("visited redirects cannot be cancelled into a fresh ordinary submission", async () => {
  const old = {...newJob(url,boundWant),state:"needs_user",reason:"web_redirected",can_cancel:true};
  const mem={...settings,batchJobs:[old]}, local={get:async keys=>Object.fromEntries([keys].flat().map(k=>[k,structuredClone(mem[k])])),set:async data=>Object.assign(mem,structuredClone(data))};
  const runner=createRunner({local,connect:async()=>({ok:false}),schedule:()=>1,captureWeb:async()=>{throw Error("must not visit");}});
  assert.equal((await runner.act(old.request_key,"cancel")).ok,false);
  await assert.rejects(runner.submit([{url,want:boundWant}]),/web_identity_protected/);
  assert.equal(mem.batchJobs.length,1);
});
