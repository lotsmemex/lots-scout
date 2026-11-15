// Capture progress, shown in Chrome's side panel (full window height, user-resizable width) or, where
// the side panel is unavailable, in a full tab that scrolls as one page. Job writes go to the
// background runner by message; clearing and deleting touch only the local list.
import { localizeDocument, LOCALE, tx } from "./i18n.js";
import { lastAction } from "./jobs.js";
import { actionText, canRestartWeb, conflictKeys, describe, destinationText, FILTER_TEXT, filterCounts, isTerminal, JOB_FILTERS, jobCategory, jobLabel, notSentText, preserveWebIdentity, pruneJobs,
  retryableKeys } from "./progress-model.js";

export const PROGRESS_PAGE = "progress.html";

// Opens the progress view. Call it synchronously from a click handler: the side panel needs the
// user gesture. Without chrome.sidePanel (or when it refuses), a tab with the same page opens instead.
export function openProgress(api, { windowId } = {}) {
  const tab = () => Promise.resolve(api.tabs.create({ url: api.runtime.getURL(PROGRESS_PAGE) })).then(() => "tab");
  let opening = null;
  try { if (typeof api.sidePanel?.open === "function" && windowId != null) opening = api.sidePanel.open({ windowId }); } catch { opening = null; }
  if (!opening) return tab();
  return Promise.resolve(opening).then(() => "side", tab);
}

// How long the page waits for the background's answer to a retry/cancel. The runner may first finish
// reads already queued (each bounded by ACT_TIMEOUT_MS), so this is longer than one request.
export const REPLY_TIMEOUT_MS = 60000;

export function mountProgress(doc, deps) {
  const { send } = deps;
  const now = deps.now || (() => Date.now());
  localizeDocument(doc);
  const $ = (id) => doc.getElementById(id);
  let jobs = [];
  let verifications = {}, archives = {};
  let filter = "all";
  let confirming = false;
  // Answers the background never gave (no handler, closed port, no reply in time) and refusals it did not
  // store, per request key; the runner is the only writer of the stored jobs, so these stay on this page.
  const unanswered = new Map();
  let bulkNote = "";
  let checking = false;
  const ask = (message) => {
    let timer;
    const late = new Promise((resolve) => { timer = setTimeout(() => resolve(undefined), deps.replyTimeoutMs ?? REPLY_TIMEOUT_MS); });
    return Promise.race([Promise.resolve().then(() => send(message)).catch(() => undefined), late]).finally(() => clearTimeout(timer));
  };
  const askAction = async (message) => {
    unanswered.delete(message.key);
    const reply = await ask(message);
    if (!reply || typeof reply.action !== "string") unanswered.set(message.key, lastAction(message.action, false, reply?.code === "not_found" ? "not_found" : "no_response", null, now()));
    // A refusal the runner did not store on the job (web retry/cancel) is still shown on its row.
    else if (reply.ok === false) unanswered.set(message.key, lastAction(reply.action, false, reply.code ?? null, reply.http_status ?? null, Number.isFinite(reply.at) ? reply.at : now()));
    render();
  };

  const time = (ms) => new Date(ms).toLocaleTimeString(LOCALE, { hour: "2-digit", minute: "2-digit", hour12: false });
  const jobRow = (job) => {
    const { tone, text } = describe(job, now());
    const li = doc.createElement("li");
    li.className = `tone-${tone}`;
    li.dataset.category = jobCategory(job);
    const icon = doc.createElement("span"); icon.className = "icon";
    icon.textContent = tone === "ok" ? "✓" : tone === "error" || tone === "warn" ? "!" : "";
    const body = doc.createElement("div");
    // The title (or the URL's distinguishing last part); the full URL is in the tooltip.
    const url = doc.createElement("div"); url.className = "url"; url.textContent = jobLabel(job); url.title = job.url;
    const line = doc.createElement("div"); line.className = "line"; line.textContent = text;
    const where = doc.createElement("div"); where.className = "where small"; where.textContent = destinationText(job);
    body.append(url, line, where);
    const archive = archives[job.request_key];
    const retained = archive || Object.values(archives).some(a => a.replacement_job.request_key === job.request_key);
    if (archive) {
      const history = doc.createElement("div"); history.className = "action-note small";
      history.textContent = tx('已人工核定未入库，已另起') + ` · ${new Date(archive.verification.checked_at).toLocaleString(LOCALE)}`;
      body.append(history);
    }
    // The last retry/cancel and why it did not take, from the stored job or, if the background never
    // answered, from this page.
    const note = actionText({ ...job, last_action: unanswered.get(job.request_key) || job.last_action });
    if (note) { const el = doc.createElement("div"); el.className = "action-note small"; el.textContent = note; body.append(el); }
    const side = doc.createElement("div"); side.className = "meta";
    side.append(time(job.updated_at));
    const button = (label, message) => {
      const el = doc.createElement("button");
      el.className = "link"; el.type = "button"; el.textContent = label;
      el.addEventListener("click", () => (message.type === "act" ? askAction(message) : ask(message)));
      side.append(el);
    };
    if (canRestartWeb(job, verifications[job.request_key], archive)) button(tx('重新抓取（新请求）'), { type: "act", key: job.request_key, action: "retry" });
    // Retry acts on the Mac's existing job (same key and payload); it is offered only when the receipt allows it.
    if (job.can_retry) button(tx('重试'), { type: "act", key: job.request_key, action: "retry" });
    if (job.can_cancel && (!job.want?.web_snapshot || (job.state === "pending" && !job.sends))) button(tx('取消'), { type: "act", key: job.request_key, action: "cancel" });
    // Refused after a lost receipt: replay the original key and payload only when the user asks.
    if (!archive && (job.state === "unconfirmed" || (job.want?.web_snapshot && (job.state === "unknown" || job.reason === "browser_visit_in_progress")))) button(tx('再次核对'), { type: "recheck", key: job.request_key });
    if (!retained && !preserveWebIdentity(job) && isTerminal(job)) button(tx('从列表移除'), { type: "remove", key: job.request_key });
    li.append(icon, body, side);
    return li;
  };

  const render = () => {
    const counts = filterCounts(jobs);
    $("filters").replaceChildren(...JOB_FILTERS.map((f) => {
      const el = doc.createElement("button");
      el.type = "button"; el.className = f === filter ? "on" : ""; el.dataset.filter = f;
      el.setAttribute("aria-pressed", String(f === filter));
      el.textContent = `${FILTER_TEXT[f]} ${counts[f]}`;
      el.addEventListener("click", () => { filter = f; render(); });
      return el;
    }));
    const doneCount = jobs.length - pruneJobs(jobs, "done").length;
    const failedCount = jobs.length - pruneJobs(jobs, "failed").length;
    const retry = retryableKeys(jobs);
    $("clear-done").textContent = tx('清理已完成（{0}）', doneCount);
    $("clear-done").disabled = doneCount === 0;
    $("retry-failed").textContent = tx('重试失败（{0}）', retry.length);
    $("retry-failed").disabled = retry.length === 0;
    $("delete-failed").textContent = tx('删除失败项（{0}）', failedCount);
    $("delete-failed").disabled = failedCount === 0;
    $("confirm").hidden = !confirming || failedCount === 0;
    const conflicts = conflictKeys(jobs).length;
    $("recheck-conflicts").hidden = conflicts === 0;
    $("recheck-conflicts").textContent = tx('全部再次核对（{0}）', conflicts);
    $("recheck-conflicts").disabled = checking;
    $("bulk-note").textContent = bulkNote;
    $("confirm-text").textContent = tx('删除 {0} 条失败记录？只删本插件里的列表，不通知 Mac，也不改资料库。', failedCount);

    const shown = jobs.filter((job) => filter === "all" || jobCategory(job) === filter).slice().reverse();
    $("jobs").replaceChildren(...shown.map(jobRow));
    $("empty").hidden = shown.length > 0;
    $("empty").textContent = jobs.length ? tx('这一类没有条目。') : tx('还没有收录任务。');
  };

  // One click for every identity-conflict row; the background replays them one after another.
  $("recheck-conflicts").addEventListener("click", async () => {
    checking = true; bulkNote = tx('正在逐条再次核对…'); render();
    const reply = await ask({ type: "recheckConflicts" });
    checking = false;
    bulkNote = !reply || typeof reply.count !== "number" ? tx('后台没有回应，再次核对可能没有发出；请在 chrome://extensions 重新加载 元芳扩展后再试')
      : !reply.sent ? notSentText(reply.code, tx('再次核对'))
      : reply.still ? tx('已再次核对 {0} 条，其中 {1} 条 Mac 仍然拒绝，见各行', reply.sent, reply.still) : tx('已再次核对 {0} 条，Mac 都已受理', reply.sent);
    render();
  });
  $("clear-done").addEventListener("click", () => ask({ type: "prune", kind: "done" }));
  $("retry-failed").addEventListener("click", async () => {
    bulkNote = "";
    const reply = await ask({ type: "retryFailed" });
    bulkNote = !reply || typeof reply.count !== "number" ? tx('后台没有回应，批量重试可能没有发出；请在 chrome://extensions 重新加载 元芳扩展后再试')
      : reply.failed ? tx('{0} 条中有 {1} 条重试没有被受理，原因见各行', reply.count, reply.failed) : "";
    render();
  });
  $("delete-failed").addEventListener("click", () => { confirming = true; render(); });
  $("confirm-cancel").addEventListener("click", () => { confirming = false; render(); });
  $("confirm-ok").addEventListener("click", () => { confirming = false; ask({ type: "prune", kind: "failed" }); render(); });

  const set = (next, context = {}) => {
    jobs = Array.isArray(next) ? next : [];
    if (context.webSnapshotVerifications) verifications = context.webSnapshotVerifications;
    if (context.webSnapshotArchives) archives = context.webSnapshotArchives;
    // A newer outcome stored by the runner replaces what this page noted about a missing answer.
    for (const job of jobs) if ((job.last_action?.at ?? -1) >= (unanswered.get(job.request_key)?.at ?? Infinity)) unanswered.delete(job.request_key);
    render();
  };
  return { set };
}

if (globalThis.chrome?.storage?.local && globalThis.document?.getElementById("progress-page")) {
  const view = mountProgress(document, { send: (message) => chrome.runtime.sendMessage(message) });
  const keys = ["batchJobs", "webSnapshotVerifications", "webSnapshotArchives"];
  const refresh = async () => { const state = await chrome.storage.local.get(keys); view.set(state.batchJobs, state); };
  await refresh();
  chrome.storage.onChanged.addListener((changes, area) => { if (area === "local" && keys.some(key => changes[key])) refresh(); });
  chrome.runtime.sendMessage({ type: "kick" });
}
