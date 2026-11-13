// Batch link jobs: one persistent Mac queue job per link. Pure module (no chrome.* use) so it
// runs in node tests and in the synthetic render harness.
import { postJson, randomBase64Url } from "./capture.js";
import { isPodcastEpisode, isSafeJob, isTerminal } from "./progress-model.js";
import { ACTIVE_GROUP_FEATURE, ACTIVE_GROUP_ROUTE, DESTINATION_FEATURE, destinationFields, GROUP_PICKER_FEATURE, groupTree, GROUPS_ROUTE, placementOf, PLACEMENTS,
  resolveActiveGroup, validDestination } from "./destination.js";

export const MAX_BATCH = 200;
export const MAX_KEPT_JOBS = 200;
const QUEUE_STATES = new Set(["queued", "leased", "artifact_ready", "retry_wait", "needs_user", "succeeded", "failed", "cancelled"]);
// Errors after which the same key must not be sent again.
// invalid_request / podcast_duplicate_conflict are definitive enqueue rejections (no job was created).
const FATAL = new Set(["permission_denied", "request_identity_conflict", "invalid_request", "resource_not_found", "podcast_duplicate_conflict"]);
const PERSISTED = ["request_key", "url", "want", "job_id", "state", "stage", "item_id", "revision_id", "quality_check", "comments",
  "reason", "retry_at_ms", "can_retry", "can_cancel", "updated_at", "sends", "page", "placement", "enrichment", "title", "last_action"];

export function parseLinks(text) {
  const urls = [];
  let rejected = 0;
  for (const raw of String(text || "").split(/\s+/)) {
    if (!raw) continue;
    let url;
    try { url = new URL(raw); } catch { rejected += 1; continue; }
    // The Mac queue admits canonical HTTPS without credentials or fragment.
    if (url.protocol !== "https:" || url.username || url.password) { rejected += 1; continue; }
    url.hash = "";
    if (!urls.includes(url.href)) urls.push(url.href);
  }
  return { urls: urls.slice(0, MAX_BATCH), rejected, overflow: Math.max(0, urls.length - MAX_BATCH) };
}

// Gate under which 1.3.x target/remove jobs are reconciled with their original payload.
// Job-state predicates live in progress-model.js (no DOM, no chrome.*, no network); re-exported here.
export { isPodcastEpisode, isSafeJob, isTerminal };
export const PODCAST_FEATURES = Object.freeze(["url-jobs-v1", "url-jobs-no-generation-v1", "url-jobs-enrich-v1", "url-jobs-group-picker-v1"]);

// 1.3.x jobs carry an explicit target/remove placement and no destination_mode; they are only ever
// replayed with their original payload (never created by the current UI).
const GROUP_ID = /^group_[A-Za-z0-9_]{1,122}$/;
const MAX_REMOVE_GROUPS = 2;
const validPlacement = (want) => GROUP_ID.test(want?.target_group_id || "") && Array.isArray(want.remove_from_group_ids) &&
  want.remove_from_group_ids.length <= MAX_REMOVE_GROUPS && want.remove_from_group_ids.every((id) => GROUP_ID.test(id)) &&
  !want.remove_from_group_ids.includes(want.target_group_id);

export const missingFeatures = (capabilities, names) =>
  names.filter((name) => !(Array.isArray(capabilities?.features) && capabilities.features.includes(name)));
// Amp podcast episodes always use the destination semantics (no generation, dedupe, enrich). Filing into
// the Mac's current folder additionally needs the active-group read; a self-chosen folder needs the
// folder list. Missing any of them holds the episode; nothing is ever sent through the legacy enqueue
// in its place.
export const PODCAST_DESTINATION_FEATURES = Object.freeze(["url-jobs-v1", "url-jobs-no-generation-v1", "url-jobs-enrich-v1", DESTINATION_FEATURE]);
const CHOICE_FEATURES = { inbox: [], current: [ACTIVE_GROUP_FEATURE], custom: [GROUP_PICKER_FEATURE] };
export const podcastMissing = (capabilities, choice) =>
  missingFeatures(capabilities, [...PODCAST_DESTINATION_FEATURES, ...(CHOICE_FEATURES[choice] || [])]);

// the Mac's current folder, read only when both features are advertised; otherwise nothing is sent.
export async function loadActive(transport, capabilities) {
  const missing = missingFeatures(capabilities, [DESTINATION_FEATURE, ACTIVE_GROUP_FEATURE]);
  if (missing.length) return { state: "closed", missing };
  try { return resolveActiveGroup(await transport.activeGroup()); }
  catch (error) { return { state: "error", code: error?.code || "unknown" }; }
}

// The folder list for "自选目录", read only when both features are advertised; otherwise nothing is sent.
export async function loadGroups(transport, capabilities) {
  const missing = missingFeatures(capabilities, [DESTINATION_FEATURE, GROUP_PICKER_FEATURE]);
  if (missing.length) return { state: "closed", missing };
  try {
    const nodes = groupTree(await transport.groups());
    return nodes ? { state: "ok", nodes } : { state: "error", code: "unknown" };
  } catch (error) { return { state: "error", code: error?.code || "unknown" }; }
}

// How one URL would be sent right now, or why it is held back. Nothing silently falls back to Inbox.
// `choice` is "inbox", "current" (the Mac's current folder, `active` from loadActive) or "custom" (the
// self-chosen folder, `custom` from resolveCustom). A folder is snapshotted into the request as is.
export function planFor(url, { choice = "inbox", capabilities, active, custom, defaults = {} }) {
  const hold = (reason, extra = {}) => ({ ok: false, reason, ...extra });
  if (isPodcastEpisode(url)) {
    const missing = podcastMissing(capabilities, choice);
    if (missing.length) return hold("missing", { missing });
    if (choice === "inbox") return { ok: true, want: { generation: "none", destination: { mode: "inbox" } } };
    const target = choice === "current" ? active : choice === "custom" ? custom : null;
    if (target?.state !== "ok") return hold(choice === "custom" ? "custom" : "active");
    return { ok: true, want: { generation: "none", destination: { mode: "group", group_id: target.group_id, path: target.path } } };
  }
  // Explicit rendered batches use the existing snapshot protocol, never a URL job.
  if (capabilities?.webSnapshot) {
    const target = choice === "current" ? active : choice === "custom" ? custom : null;
    if (choice !== "inbox" && target?.state !== "ok") return hold(choice === "custom" ? "custom" : "active");
    return { ok: true, want: { web_snapshot: true, destination: choice === "inbox" ? { mode: "inbox" }
      : { mode: "group", group_id: target.group_id, path: [...target.path] } } };
  }
  // Old servers keep their original Inbox-only URL contract.
  if (choice !== "inbox") return hold("article_needs_inbox");
  if (!capabilities?.urlJobs) return hold("missing", { missing: ["url-jobs-v1"] });
  return { ok: true, want: { quality: capabilities.qualityCheck === true && defaults.quality === true,
    comments: capabilities.comments === true && defaults.comments === true } };
}

// Re-reads the Mac's capabilities: on demand (page focus/visibility) and, after a failed read, on its
// own with exponential backoff, so one failure while the service restarts does not stick.
export function createProbe(connect, onResult, { schedule = setTimeout, cancel = clearTimeout, base = 2000, max = 60000 } = {}) {
  let delay = base, timer = null, running = null;
  const run = () => {
    if (running) return running;
    if (timer) { cancel(timer); timer = null; }
    running = (async () => {
      let result;
      try { result = await connect(); } catch { result = { ok: false }; }
      if (result.ok) delay = base;
      else { timer = schedule(() => { timer = null; return run(); }, delay); result.retry_in_ms = delay; delay = Math.min(max, delay * 2); }
      await onResult(result);
      return result;
    })().finally(() => { running = null; });
    return running;
  };
  return { run };
}

// Local record only: finished jobs can be dropped from the list; nothing is sent to the Mac.
export const removeFinished = (jobs, requestKey) => jobs.filter((job) => job.request_key !== requestKey || !isTerminal(job));

export function podcastGate(capabilities) {
  const features = Array.isArray(capabilities?.features) ? capabilities.features : [];
  const missing = PODCAST_FEATURES.filter((name) => !features.includes(name));
  return { open: missing.length === 0, missing };
}

// `page` is the page the job was sniffed from and `title` the item title seen there (both display only,
// never sent). The destination is a snapshot taken at
// submit time: it is part of the durable request identity, replayed verbatim, never re-read later.
export function newJob(url, want, now = Date.now(), page = null, title = null) {
  const safe = want.generation === "none";
  const copy = (d) => d.mode === "inbox" ? { mode: "inbox" } : { mode: "group", group_id: String(d.group_id || ""), path: [...(d.path || [])].map(String) };
  return {
    request_key: `chrome_capture_${randomBase64Url(24)}`, url, page: typeof page === "string" ? page : null, placement: null,
    title: typeof title === "string" && title.trim() ? title.trim().slice(0, 300) : null,
    want: want.web_snapshot === true ? { web_snapshot: true, quality: false, comments: false, destination: copy(want.destination), intake_binding: want.intake_binding }
      : safe && want.destination ? { quality: false, comments: false, generation: "none", destination: copy(want.destination) }
      // 1.3.x shape (explicit target/remove, no destination_mode); kept so old records are understood.
      : safe ? { quality: false, comments: false, generation: "none", target_group_id: String(want.target_group_id || ""),
        remove_from_group_ids: [...(want.remove_from_group_ids || [])].map(String) }
      : { quality: Boolean(want.quality), comments: Boolean(want.comments) },
    job_id: null, state: "pending", stage: null, item_id: null, revision_id: null,
    quality_check: { state: "not_requested", reason: null },
    comments: { state: want.comments ? "pending" : "not_requested", reason: null },
    reason: null, retry_at_ms: null, can_retry: false, can_cancel: false, updated_at: now
  };
}

export function persistable(jobs) {
  return jobs.slice(-MAX_KEPT_JOBS).map((job) => Object.fromEntries(
    (job.want?.web_snapshot ? [...PERSISTED, "occurrences", "missing_images"] : PERSISTED).map((key) => [key, job[key] ?? null])));
}

const sub = (value) => value && typeof value.state === "string"
  ? { state: value.state, reason: typeof value.reason === "string" ? value.reason : null } : null;

export function applyReceipt(job, receipt, now = Date.now()) {
  return {
    ...job,
    state: QUEUE_STATES.has(receipt.state) ? receipt.state : "unknown",
    stage: typeof receipt.stage === "string" ? receipt.stage : null,
    job_id: receipt.job_id ?? job.job_id,
    item_id: receipt.item_id ?? job.item_id,
    revision_id: receipt.revision_id ?? job.revision_id,
    quality_check: sub(receipt.quality_check) ?? job.quality_check,
    comments: sub(receipt.comments) ?? job.comments,
    reason: typeof receipt.reason === "string" ? receipt.reason : null,
    retry_at_ms: Number.isFinite(receipt.retry_at_ms) ? receipt.retry_at_ms : null,
    can_retry: receipt.can_retry === true,
    can_cancel: receipt.can_cancel === true,
    placement: placementOf(receipt) ?? (PLACEMENTS.includes(job.placement) ? job.placement : null),
    // Podcast receipts: only the enrichment state is kept (pending | complete | partial).
    enrichment: ["pending", "complete", "partial"].includes(receipt.enrichment?.state) ? receipt.enrichment.state : job.enrichment ?? null,
    updated_at: now
  };
}

// `send` is "first" for a job's first enqueue, "replay" for any later enqueue of the same key, null otherwise.
function applyError(job, error, now, send = null) {
  const code = error?.code || "unknown";
  // After a possibly-lost earlier send, no rejection (target/duplicate/identity/permission) proves the original
  // request was never accepted: keep key and payload unchanged and ask the user to check. Transport trouble
  // stays unknown and keeps reconciling.
  // For the safe batch only a first-send 400/409 is a definitive "not accepted"; identity/auth/not-found
  // and store/read failures never prove that nothing was written.
  const definitive = code === "invalid_request" || code === "podcast_duplicate_conflict";
  if (send === "replay" || (send === "first" && isSafeJob(job) && !definitive)) {
    if (code === "unknown" || code === "unavailable") return { ...job, state: "unknown", reason: null, updated_at: now };
    return { ...job, state: "unconfirmed", reason: code, updated_at: now };
  }
  if (code === "unavailable") return { ...job, state: "unavailable", reason: error.reason || null, updated_at: now };
  if (code === "podcast_duplicate_conflict") return { ...job, state: "blocked", reason: code, can_retry: false, can_cancel: false, updated_at: now };
  if (FATAL.has(code)) return { ...job, state: "rejected", reason: code, can_retry: false, can_cancel: false, updated_at: now };
  // Lost receipt or network failure: the outcome is unknown. Keep the same key and replay it.
  return { ...job, state: "unknown", reason: null, updated_at: now };
}

// One step for one job. Pending/unknown jobs (re)send the same key and input; queued jobs are read back.
// Whether advance() would send an enqueue for this job now.
export function willEnqueue(job, transport) {
  if (isTerminal(job) || !(job.state === "pending" || job.state === "unknown" || job.state === "unconfirmed" || !job.job_id)) return false;
  if (!isSafeJob(job)) return true;
  if (job.want.destination) return transport.destination === true && validDestination(job.want.destination);
  return transport.podcast === true && validPlacement(job.want);
}
// Counted and saved before the request goes out, so a send interrupted by closing the page is not
// mistaken for a first send later.
export const prepareSend = (job, transport) => willEnqueue(job, transport) ? { ...job, sends: (job.sends || 0) + 1 } : job;

export async function advance(job, transport, now = Date.now()) {
  if (isTerminal(job)) return job;
  const enqueueing = job.state === "pending" || job.state === "unknown" || job.state === "unconfirmed" || !job.job_id;
  const firstSend = job.state === "pending" && (job.sends || 0) <= 1;
  try {
    if (enqueueing) {
      if (isSafeJob(job) && job.want.destination) {
        // Destination gate closed (or lost since): send nothing and keep the job, to reconcile later.
        if (transport.destination !== true) return job;
        if (!validDestination(job.want.destination)) return { ...job, state: "rejected", reason: "target_missing", can_retry: false, can_cancel: false, updated_at: now };
        return applyReceipt(job, await transport.enqueue({
          request_key: job.request_key, url: job.url, include_comments: false, quality_check: "off", generation_policy: "none",
          ...destinationFields(job.want.destination)
        }), now);
      }
      if (isSafeJob(job)) {
        // Gate closed (or lost since): send nothing and keep the job as it is, to reconcile later.
        if (transport.podcast !== true) return job;
        // No (valid) placement saved with this key: never send it, and never patch the old key.
        if (!validPlacement(job.want)) return { ...job, state: "rejected", reason: "target_missing", can_retry: false, can_cancel: false, updated_at: now };
        return applyReceipt(job, await transport.enqueue({
          request_key: job.request_key, url: job.url, include_comments: false, quality_check: "off", generation_policy: "none",
          target_group_id: job.want.target_group_id, remove_from_group_ids: [...job.want.remove_from_group_ids]
        }), now);
      }
      return applyReceipt(job, await transport.enqueue({
        request_key: job.request_key, url: job.url,
        include_comments: job.want.comments, quality_check: job.want.quality ? "configured" : "off"
      }), now);
    }
    return applyReceipt(job, await transport.status({ job_id: job.job_id }), now);
  } catch (error) {
    return applyError(job, error, now, enqueueing ? (firstSend ? "first" : "replay") : null);
  }
}

// Retry/cancel/status requests wait at most this long, so one hung request cannot hold the runner's queue.
export const ACT_TIMEOUT_MS = 15000;
const SERVER_CODE = /^[a-z0-9_]{1,64}$/;
// What happened to the last retry/cancel of this job: {action, ok, code, http_status, at}. Only these fields;
// never the URL, payload, secret or nonce.
export function lastAction(action, ok, code = null, httpStatus = null, at = Date.now()) {
  return { action: action === "cancel" ? "cancel" : "retry", ok: ok === true,
    code: typeof code === "string" && SERVER_CODE.test(code) ? code : code == null ? null : "unknown",
    http_status: Number.isInteger(httpStatus) ? httpStatus : null, at };
}

// Retry/cancel are offered only when the last receipt allowed them; the server rechecks anyway. Every call
// records its outcome in `last_action`, including why nothing was sent. A refused or unanswered action
// leaves the state as it was rather than guessing; key and payload are never touched. `unready` is the
// runner's reason the Mac cannot be asked now (null when it can).
export async function act(job, action, transport, now = Date.now(), unready = null) {
  const record = (next, ok, code = null, status = null) => ({ ...next, last_action: lastAction(action, ok, code, status, now) });
  if (!(action === "retry" ? job.can_retry : job.can_cancel)) return record(job, false, "not_allowed_locally");
  if (!job.job_id) return record(job, false, "no_job_id");
  if (unready || transport?.ready !== true) return record(job, false, unready || "feature_missing");
  try { return record(applyReceipt(job, await transport[action]({ job_id: job.job_id }), now), true, null, 200); }
  catch (error) {
    const code = error?.timeout ? "timeout" : error?.code || "unknown";
    return record(FATAL.has(error?.code) ? applyError(job, error, now) : job, false, code, error?.http_status);
  }
}

export function unavailableTransport() {
  const fail = async () => { throw Object.assign(new Error("unavailable"), { code: "unavailable" }); };
  return { ready: false, podcast: false, destination: false, activeGroup: fail, groups: fail, enqueue: fail, status: fail, retry: fail, cancel: fail };
}

// `podcast` is true only when the same intake's capabilities carried every PODCAST_FEATURES entry.
export function httpTransport(endpoint, secret, fetchImpl = fetch, capabilities = null, { timeoutMs = ACT_TIMEOUT_MS } = {}) {
  // Enqueue keeps no client timeout (its unknown-outcome handling is unchanged); status/retry/cancel are bounded.
  const call = (route, bounded = false) => (input) => postJson(endpoint, secret, `/api/v1/url-jobs/${route}`, input, fetchImpl, bounded ? { timeoutMs } : {});
  // `podcast`: legacy 1.3.x replay gate; `destination`: destination_mode requests (podcast episodes).
  return { ready: true, podcast: podcastGate(capabilities).open, destination: podcastMissing(capabilities, "inbox").length === 0,
    activeGroup: () => postJson(endpoint, secret, ACTIVE_GROUP_ROUTE, {}, fetchImpl),
    groups: () => postJson(endpoint, secret, GROUPS_ROUTE, {}, fetchImpl), enqueue: call("enqueue"), status: call("status", true), retry: call("retry", true), cancel: call("cancel", true) };
}
