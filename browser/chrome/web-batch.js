// Explicit, one-hop browser snapshots. Uses the existing batchJobs writer and
// binary snapshot store, never the URL worker or a second persistent queue.
import { buildCapture, discoverCapabilities, postCapture, SECRET_PATTERN, SETTING_KEYS, sha256Hex, validateEndpoint } from "./capture.js";
import { validDestination } from "./destination.js";
import { extractArticleSnapshot } from "./extractor.js";
import { collectImageEvidence } from "./image-capture.js";
import { pendingSnapshot } from "./snapshot-queue.js";
import { ADMISSION_REJECTIONS } from "./progress-model.js";

export function webOrigin(value) {
  try {
    const u = new URL(value), h = u.hostname.toLowerCase().replace(/\.$/, "");
    if (u.protocol !== "https:" || u.username || u.password || u.href.includes("#") || (u.port && u.port !== "443") ||
        !h.includes(".") || /(?:^|\.)(?:localhost|local|localdomain|internal|lan|home|test|invalid|example|onion)$/.test(h) || /(?:^|\.)home\.arpa$/.test(h) ||
        h.includes(":") || h.includes("[") || /^\d+\.\d+\.\d+\.\d+$/.test(h)) return null;
    return `${u.origin}/*`;
  } catch { return null; }
}

// Scheme/hostname case and one trailing pathname slash only. Path case, query,
// fragment, encoding and order remain significant (they can identify other content).
export function webPageIdentity(value) {
  const u = new URL(value);
  u.pathname = u.pathname.replace(/\/$/, "");
  return u.href;
}

export const intakeBinding = (settings) => sha256Hex(new TextEncoder().encode(JSON.stringify([settings.endpoint, settings.intakeSecret])));

// Ordinary visible Chrome navigation can redirect/request subresources before
// inspection. This is a snapshot-source guard, NOT a DNS/IP/navigation firewall.
export async function renderWebPage(api, url, { timeoutMs = 25000, wait = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const origin = webOrigin(url);
  if (!origin) throw new Error("unsafe_web_url");
  if (!await api.permissions.contains({ origins: [origin] })) throw new Error("site_permission_required");
  let tab;
  try {
    tab = await api.tabs.create({ url, active: true });
    const until = Date.now() + timeoutMs;
    for (;;) {
      const current = await api.tabs.get(tab.id);
      if (current.url && webPageIdentity(current.url) !== webPageIdentity(url)) throw new Error("web_redirected");
      if (current.status === "complete" && current.url) break;
      if (Date.now() >= until) throw new Error("web_load_timeout");
      await wait(200);
    }
    const [{ result: safe, documentId }] = await api.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, args: [url], func: (expected) => {
      const identity = (value) => { const u = new URL(value); u.pathname = u.pathname.replace(/\/$/, ""); return u.href; };
      if (identity(location.href) !== identity(expected)) return { code: "page_changed" };
      return !document.querySelector('input[type="password"],[contenteditable="true"],iframe[src*="challenge"],#challenge-running,#cf-challenge-running');
    } });
    if (safe?.code === "page_changed") throw new Error("page_changed");
    if (!safe) throw new Error("interactive_login_required");
    if (!documentId) throw new Error("page_changed");
    // Pin all content reads to the checked document, not a reusable tab/frame ID.
    const target = { tabId: tab.id, documentIds: [documentId] };
    const [{ result: snapshot }] = await api.scripting.executeScript({ target, func: extractArticleSnapshot, args: [{ includeComments: false, expectedSourceUrl: url }] });
    if (!snapshot?.sourceUrl || webPageIdentity(snapshot.sourceUrl) !== webPageIdentity(url)) throw new Error("page_changed");
    const [{ result: evidence }] = snapshot.imageUrls?.length
      ? await api.scripting.executeScript({ target, func: collectImageEvidence, args: [snapshot.imageUrls] })
      : [{ result: { images: [], missing: 0 } }];
    if (webPageIdentity((await api.tabs.get(tab.id)).url) !== webPageIdentity(url)) throw new Error("page_changed");
    return { snapshot: { ...snapshot, sourceUrl: url }, evidence };
  } finally {
    if (tab?.id != null) await api.tabs.remove(tab.id).catch(() => {});
  }
}

export function createWebCapture({ api, local, pending = pendingSnapshot, render = (url) => renderWebPage(api, url), post = postCapture, capabilities = discoverCapabilities, now = () => Date.now() }) {
  return async (job, save) => {
    const stop = (reason, uncertain = false) => ({ ...job, state: uncertain ? "unconfirmed" : "needs_user", reason,
      can_retry: !uncertain && !["web_redirected", "page_changed", "unsafe_web_url", "interactive_login_required"].includes(reason), can_cancel: false, updated_at: now() });
    const settings = await local.get(SETTING_KEYS);
    if (!validateEndpoint(settings.endpoint) || !SECRET_PATTERN.test(settings.intakeSecret || "")) return stop("settings_required", Boolean(job.sends));
    const binding = await intakeBinding(settings);
    // Legacy/unbound web jobs fail closed; never adopt the current account.
    if (job.want?.intake_binding !== binding) return stop("intake_changed", Boolean(job.sends));
    if (!validDestination(job.want?.destination) || !webOrigin(job.url)) return stop("unsafe_web_url", Boolean(job.sends));
    let request = await pending("get", job.request_key);
    if (request && request.binding !== binding) return stop("intake_changed", true);
    if (!request && job.sends) return stop("snapshot_missing", true);
    if (!(await capabilities(settings.endpoint, settings.intakeSecret)).webSnapshot) return stop("web_feature_missing", Boolean(job.sends));
    if (!request) {
      // A worker interrupted during rendering leaves a visible, non-runnable
      // needs_user state. Only an explicit retry may open another browser tab.
      job = { ...job, state: "needs_user", reason: "browser_visit_in_progress", stage: "browser", can_cancel: false, can_retry: false, updated_at: now() };
      await save(job);
      try {
        const { snapshot, evidence } = await render(job.url);
        const { body } = await buildCapture(snapshot, new Date(now()), { webSnapshot: true, requestId: job.request_key,
          targetGroupId: job.want.destination.mode === "group" ? job.want.destination.group_id : null, images: evidence.images });
        request = { body, binding, missing: evidence.missing };
        await pending("put", job.request_key, request);
      } catch (error) {
        const known = new Set(["site_permission_required", "web_redirected", "web_load_timeout", "interactive_login_required", "page_changed", "unsafe_web_url"]);
        return stop(known.has(error.message) ? error.message : "unsupported_content");
      }
    }
    if (await intakeBinding(await local.get(SETTING_KEYS)) !== binding) return stop("intake_changed", Boolean(job.sends));
    // Both immutable bytes and dispatch intent must be durable before POST.
    job = { ...job, sends: (job.sends || 0) + 1, state: "unknown", stage: "store", can_retry: false, can_cancel: false, updated_at: now() };
    await save(job);
    try {
      const response = await post(settings.endpoint, settings.intakeSecret, request.body);
      if (!response.ok) {
        if (response.status === 422) {
          let refusal;
          try { refusal = await response.json(); } catch { /* An empty/generic 422 proves nothing. */ }
          if (refusal?.schema_version === 1 && refusal.error === "capture_admission_rejected" && ADMISSION_REJECTIONS.has(refusal.reason_code)) {
            return { ...stop(refusal.reason_code), state: "failed", can_retry: false, can_cancel: false };
          }
        }
        return stop(response.status === 409 ? "web_content_conflict" : `intake_${response.status}`, true);
      }
      const receipt = await response.json();
      if (receipt?.schema_version !== 1 || typeof receipt.item_id !== "string" || !receipt.item_id || typeof receipt.revision_id !== "string" || !receipt.revision_id) return stop("invalid_receipt", true);
      const done = { ...job, state: "succeeded", reason: null, item_id: receipt.item_id, revision_id: receipt.revision_id,
        missing_images: request.missing, placement: job.want.destination.mode === "group" ? "selected_group" : "unfiled", updated_at: now() };
      await save(done);
      // A cleanup failure cannot turn a durably saved success back into unknown.
      await pending("delete", job.request_key).catch(() => {});
      return done;
    } catch { return stop("unknown_capture", true); }
  };
}
