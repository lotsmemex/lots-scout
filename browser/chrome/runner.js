// The one writer of the persisted batch jobs. Runs in the service worker, so submitted jobs keep
// going after the popup closes; pages and the popup only send it messages and render storage.
// Pure (dependencies injected) so the same code runs in node tests and in the render harness.
import { discoverCapabilities, NO_CAPABILITIES, SECRET_PATTERN, SETTING_KEYS, sha256Hex, validateEndpoint } from "./capture.js";
import { act, advance, httpTransport, MAX_BATCH, newJob, persistable, prepareSend, removeFinished, unavailableTransport, willEnqueue } from "./jobs.js";
import { intakeBinding, webOrigin } from "./web-batch.js";
import { validDestination } from "./destination.js";
import { canRestartWeb, conflictKeys, isTerminal, preserveWebIdentity, pruneJobs, retryableKeys } from "./progress-model.js";
import { savedEntryOf, savedIndexAdd } from "./saved-index.js";
import { pendingSnapshot } from "./snapshot-queue.js";

export const PROBE_TIMEOUT_MS = 5000;

// Probes the configured intake. `ok` means the Mac answered the capabilities read with a non-5xx
// HTTP status; which requests may be sent is then decided from `features` (a feature missing there is
// permanent until the Mac changes: no automatic retry, only a re-read on focus). Refused connection,
// timeout, 5xx and a daemon still warming up are `reason: "unreachable"`, retried with backoff by the caller.
export async function connectIntake(local, fetchImpl = globalThis.fetch, { timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const { endpoint, intakeSecret } = await local.get(SETTING_KEYS);
  if (!validateEndpoint(endpoint) || !SECRET_PATTERN.test(intakeSecret || "")) {
    return { ok: false, reason: "settings", capabilities: NO_CAPABILITIES, transport: unavailableTransport() };
  }
  let answered = false;
  const probeFetch = async (url, init) => {
    const response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    answered = response.status < 500;
    return response;
  };
  const capabilities = await discoverCapabilities(endpoint, intakeSecret, probeFetch);
  if (!answered) return { ok: false, reason: "unreachable", capabilities: NO_CAPABILITIES, transport: unavailableTransport() };
  return { ok: true, capabilities, intakeBinding: await intakeBinding({ endpoint, intakeSecret }),
    transport: capabilities.urlJobs || capabilities.webSnapshot ? httpTransport(endpoint, intakeSecret, fetchImpl, capabilities) : unavailableTransport() };
}

export function createRunner({ local, connect, captureWeb, pending = pendingSnapshot, now = () => Date.now(), schedule = (fn, ms) => setTimeout(fn, ms) }) {
  let chain = Promise.resolve();
  let timer = null;
  // Every read-modify-write of batchJobs goes through this queue, one at a time.
  const serial = (fn) => { const run = chain.then(fn); chain = run.catch(() => {}); return run; };
  const archives = async () => (await local.get("webSnapshotArchives")).webSnapshotArchives || {};
  const retainedKeys = (archived) => new Set(Object.values(archived).flatMap(a => [a.original_job.request_key, a.replacement_job.request_key]));
  // The same target boundary protects both ordinary submit and current-tab capture.
  // An archived original still blocks minting another identity if its explicit
  // replacement was cancelled; only the manual action can create a replacement.
  const existingWeb = (jobs, archived, url, want) => {
    const matches = j => j.want?.web_snapshot && j.url === url && j.want.intake_binding === want.intake_binding &&
      j.want.destination.mode === want.destination.mode && j.want.destination.group_id === want.destination.group_id;
    return jobs.find(j => matches(j) && !archived[j.request_key] &&
      (preserveWebIdentity(j) || !["cancelled", "failed"].includes(j.state))) ||
      Object.values(archived).map(a => a.original_job).find(matches);
  };
  const load = async () => {
    const { batchJobs } = await local.get("batchJobs");
    const jobs = Array.isArray(batchJobs) ? [...batchJobs] : [];
    // The immutable archive commits the replacement ID before publishing the new
    // job. A worker interruption can recover that same ID, never mint a second.
    for (const archive of Object.values(await archives())) {
      for (const job of [archive.original_job, archive.replacement_job]) {
        if (job && !jobs.some(j => j.request_key === job.request_key)) jobs.push(job);
      }
    }
    return jobs;
  };
  // Every write of the jobs also records URLs now known to be in the library; the index only grows here,
  // so dropping job records (clear done, remove) never forgets them.
  const save = async (jobs) => {
    const archived = await archives(), retained = retainedKeys(archived);
    if (jobs.length > 200 && jobs.slice(0, jobs.length - 200).some(j => retained.has(j.request_key) || preserveWebIdentity(j))) throw new Error("batch_storage_full");
    const kept = jobs.slice(-200);
    const records = persistable(kept).map((j, index) => archived[j.request_key]?.original_job || (preserveWebIdentity(kept[index]) ? kept[index] : j));
    const entries = jobs.map(savedEntryOf).filter(Boolean);
    if (!entries.length) return local.set({ batchJobs: records });
    const { savedUrls } = await local.get("savedUrls");
    const known = new Map((Array.isArray(savedUrls) ? savedUrls : []).map((e) => [e?.url, e]));
    const changed = entries.filter((e) => known.get(e.url)?.item_id !== e.item_id || !known.has(e.url));
    return local.set(changed.length ? { batchJobs: records, savedUrls: savedIndexAdd(savedUrls, changed) } : { batchJobs: records });
  };
  const put = async (job) => save((await load()).map((old) => old.request_key === job.request_key ? job : old));
  const restartWeb = async (job) => {
    const list = await load(), archived = await archives();
    if (archived[job.request_key]) {
      await save(list);
      return { action: "retry", ok: true, new_request_key: archived[job.request_key].replacement_job.request_key };
    }
    const { webSnapshotVerifications = {} } = await local.get("webSnapshotVerifications");
    const verification = webSnapshotVerifications[job.request_key];
    if (!canRestartWeb(job, verification) || list.length >= 200) return { action: "retry", ok: false, code: "not_allowed_locally" };
    const binding = await intakeBinding(await local.get(SETTING_KEYS));
    const request = await pending("get", job.request_key);
    if (binding !== job.want.intake_binding || request?.binding !== binding || !request?.body) return { action: "retry", ok: false, code: "intake_changed" };
    const jobHash = await sha256Hex(new TextEncoder().encode(JSON.stringify(job)));
    const snapshotHash = await sha256Hex(new Uint8Array(await request.body.arrayBuffer()));
    if (verification.job_sha256 !== jobHash || verification.snapshot_sha256 !== snapshotHash) return { action: "retry", ok: false, code: "not_allowed_locally" };
    const replacement = { ...newJob(job.url, job.want, now(), job.page, job.title), can_cancel: true,
      occurrences: structuredClone(job.occurrences || []) };
    const archive = { schema_version: 1, original_job: structuredClone(job), job_sha256: jobHash,
      snapshot_key: job.request_key, snapshot_sha256: snapshotHash, intake_binding: binding,
      destination: structuredClone(job.want.destination), verification: structuredClone(verification),
      replacement_job: replacement };
    await local.set({ webSnapshotArchives: { ...archived, [job.request_key]: archive } });
    await save([...list, replacement]);
    return { action: "retry", ok: true, new_request_key: replacement.request_key };
  };
  // "unconfirmed" (refused after a lost receipt) waits for the user's explicit re-check.
  const runnable = (job, transport) => job.want?.web_snapshot ? Boolean(captureWeb) && job.state === "pending"
    : !isTerminal(job) && job.state !== "unconfirmed" && (willEnqueue(job, transport) || Boolean(job.job_id && job.state !== "pending" && job.state !== "unknown"));
  const step = async (key, transport) => {
    const job = (await load()).find((candidate) => candidate.request_key === key);
    if (!job) return;
    if (job.want?.web_snapshot) {
      if ((await archives())[key]) return;
      if (captureWeb && !isTerminal(job)) await put(await captureWeb(job, put));
      return;
    }
    // The send count is saved before the request leaves, so an interrupted first send is not taken for one later.
    const ready = prepareSend(job, transport);
    if (ready !== job) await put(ready);
    await put(await advance(ready, transport, now()));
  };
  // connect() plus why the Mac cannot be asked now: unreachable / not set up / no url-jobs feature.
  const reach = async () => {
    let conn;
    try { conn = await connect(); } catch { conn = { ok: false, reason: "unreachable" }; }
    const unready = !conn.ok ? (conn.reason === "settings" ? "settings_required" : "mac_unreachable")
      : conn.transport?.ready !== true ? "feature_missing" : null;
    return { transport: conn.transport, unready };
  };
  const later = (ms) => { if (!timer) timer = schedule(() => { timer = null; kick(); }, ms); };
  const kick = () => serial(async () => {
    const { ok, transport } = await connect();
    // Mac away (starting up, unreachable, not set up): touch no job, so an unknown job keeps its state,
    // key and payload and nothing is marked failed; try the connection again more slowly.
    if (!ok) {
      if ((await load()).some((job) => !isTerminal(job) && job.state !== "unconfirmed")) later(15000);
      return;
    }
    for (const job of (await load()).filter((candidate) => runnable(candidate, transport))) {
      await step(job.request_key, transport);
      // Yield between visible browser visits so cancel and recheck can run.
      if (job.want?.web_snapshot) break;
    }
    // Read back unfinished jobs every few seconds (jittered). Features the Mac lacks are not polled for:
    // the pages re-read them on focus and kick again.
    if ((await load()).some((job) => runnable(job, transport))) later(3000 + Math.random() * 3000);
  });

  // Answers the caller as soon as its own step is done; the follow-up read-back runs after it.
  const thenKick = (run) => { run.finally(() => kick()).catch(() => {}); return run; };
  return {
    kick,
    captureCurrent: (url, want, capture) => serial(async () => {
      if (want.intake_binding !== await intakeBinding(await local.get(SETTING_KEYS))) throw new Error("web_identity_protected");
      if (existingWeb(await load(), await archives(), url, want)) throw new Error("web_identity_protected");
      return capture();
    }),
    submit: (items) => serial(async () => {
      if (items.length > MAX_BATCH) throw new Error("batch_limit");
      const binding = await intakeBinding(await local.get(SETTING_KEYS));
      if (items.some((item) => item.want?.web_snapshot && item.want.intake_binding !== binding)) throw new Error("intake_changed");
      const list = await load(), keys = [];
      const archived = await archives();
      for (const { url, want, page, title, occurrences } of items) {
        if (want?.web_snapshot && (!captureWeb || !webOrigin(url) || !validDestination(want.destination))) throw new Error("invalid_web_batch");
        const existing = existingWeb(list, archived, url, { ...want, intake_binding: binding,
          destination: want?.destination || { mode: want?.target_group_id ? "group" : "inbox", group_id: want?.target_group_id } });
        if (existing && (preserveWebIdentity(existing) || archived[existing.request_key])) throw new Error("web_identity_protected");
        const job = existing || newJob(url, want, now(), page, title);
        if (!existing) {
          if (want?.web_snapshot) {
            job.can_cancel = true;
            job.occurrences = structuredClone((occurrences || []).slice(0, 200));
          }
          list.push(job);
        }
        keys.push(job.request_key);
      }
      // Never evict an unfinished/unknown identity to make room for a batch.
      if (list.length > 200 && list.slice(0, list.length - 200).some((j) => !isTerminal(j))) throw new Error("batch_storage_full");
      await save(list);
      return keys;
    }).then((keys) => { kick(); return keys; }),
    // Explicit re-check: replays the original key and payload once.
    recheck: (key) => serial(async () => { const { transport } = await connect(); await step(key, transport); }).then(() => kick()),
    // Explicit re-check of every identity-conflict job, one at a time: each replays its original key and
    // payload once, exactly like the single "再次核对". Nothing else is touched.
    recheckConflicts: () => thenKick(serial(async () => {
      const { transport, unready } = await reach();
      const keys = conflictKeys(await load());
      if (unready) return { ok: false, code: unready, count: keys.length, sent: 0, still: keys.length };
      for (const key of keys) await step(key, transport);
      const still = conflictKeys(await load()).filter((key) => keys.includes(key)).length;
      return { ok: still === 0, code: null, count: keys.length, sent: keys.length, still };
    })),
    // The outcome is recorded on the job (last_action) and returned to the page that asked.
    act: (key, action) => thenKick(serial(async () => {
      const { transport, unready } = await reach();
      const job = (await load()).find((candidate) => candidate.request_key === key);
      if (!job) return { ok: false, code: "not_found" };
      if (job.want?.web_snapshot) {
        if (action === "retry" && !job.can_retry) return restartWeb(job);
        if ((await archives())[key]) return { action, ok: false, code: "not_allowed_locally" };
        if (action === "cancel" && job.can_cancel && !job.sends && job.state === "pending") {
          await put({ ...job, state: "cancelled", can_retry: false, can_cancel: false, updated_at: now() });
          return { action, ok: true };
        }
        if (action === "retry" && job.can_retry) { await step(key, transport); return { action, ok: true }; }
        return { action, ok: false, code: "not_allowed_locally" };
      }
      const next = await act(job, action, transport, now(), unready);
      await put(next);
      return next.last_action;
    })),
    // Bulk retry of failed jobs the Mac allowed to retry; same per-job action as the single retry.
    retryFailed: () => thenKick(serial(async () => {
      const { transport, unready } = await reach();
      const outcomes = [];
      for (const key of retryableKeys(await load())) {
        const job = (await load()).find((candidate) => candidate.request_key === key);
        if (!job) continue;
        const next = await act(job, "retry", transport, now(), unready);
        await put(next);
        outcomes.push(next.last_action);
      }
      return { ok: outcomes.every((o) => o.ok), count: outcomes.length, failed: outcomes.filter((o) => !o.ok).length };
    })),
    // Local record only, finished jobs only; nothing is sent.
    remove: (key) => serial(async () => {
      const jobs = await load();
      if (!retainedKeys(await archives()).has(key) && !preserveWebIdentity(jobs.find(j => j.request_key === key))) await save(removeFinished(jobs, key));
    }),
    prune: (kind) => serial(async () => {
      const retained = retainedKeys(await archives()), jobs = await load();
      await save(jobs.filter(job => retained.has(job.request_key) || pruneJobs([job], kind).length));
    })
  };
}
