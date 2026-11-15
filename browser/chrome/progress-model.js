// Progress model: job categories, counts, filters and every user-facing text about a job's progress.
// Pure functions over stored job records. No DOM, no chrome.*, no network; the only import is i18n.js
// (tx/LOCALE, which falls back to Chinese outside a page). Reusable by another extension shell, a
// standalone runtime or a CLI.
import { LOCALE, tx } from "./i18n.js";

// ---- job-state predicates -----------------------------------------------------------------------
const PODCAST_EPISODE = /^https:\/\/ampcode\.com\/podcast\/(?:season-\d{2}\/)?episode-\d{1,3}$/;
export const isPodcastEpisode = (url) => PODCAST_EPISODE.test(url);
export const isSafeJob = (job) => job?.want?.generation === "none";
export const ADMISSION_REJECTIONS = new Set(["interactive_control_detected", "interactive_authentication_detected", "automated_access_challenge_detected", "html_has_no_visible_content", "generic_html_requires_preview"]);
// Sent failures and visited source refusals keep their identity until explicitly
// archived; clearing a list must not turn either into permission to capture anew.
export const preserveWebIdentity = (job) => Boolean(job?.want?.web_snapshot && job.state !== "succeeded" &&
  (job.sends > 0 || ["web_redirected", "page_changed", "browser_visit_in_progress"].includes(job.reason)));

// Manual checks come only from an owner-local read-only audit, not page content
// or an HTTP 422 alone. The runner also verifies the original job/bytes hashes.
export function canRestartWeb(job, verification, archive) {
  if (!job?.want?.web_snapshot || archive) return false;
  const eligible = (job.state === "failed" && ADMISSION_REJECTIONS.has(job.reason)) ||
    (job.state === "unconfirmed" && job.reason === "intake_422");
  return eligible && verification?.schema_version === 1 &&
    verification.request_key === job.request_key && verification.url === job.url &&
    verification.intake_binding === job.want.intake_binding && verification.group_id === job.want.destination?.group_id &&
    verification.observed_updated_at === job.updated_at && verification.checked_at >= job.updated_at &&
    /^[a-f0-9]{64}$/.test(verification.job_sha256 || "") && /^[a-f0-9]{64}$/.test(verification.snapshot_sha256 || "") &&
    verification.queries?.source_url?.method === "local_store_url_index_scan" && verification.queries.source_url.count === 0 &&
    verification.queries?.target_group?.method === "local_store_membership_scan" && verification.queries.target_group.count === 0;
}
const TERMINAL = new Set(["succeeded", "failed", "cancelled", "rejected", "blocked"]);
// Store success does not settle the separate model-check / comments results; keep reading back
// until those leave their in-flight states too.
const SETTLING = new Set(["running", "pending"]);
export const isTerminal = (job) => job.state === "unavailable" || (TERMINAL.has(job.state) &&
  !(job.state === "succeeded" && (SETTLING.has(job.quality_check?.state) || SETTLING.has(job.comments?.state))));


// ---- categories, filters, bulk selections -------------------------------------------------------
// Progress filters. "busy" includes unknown outcomes (still being read back) and stores whose side
// results are still settling; "needs" includes refusals that cannot prove non-acceptance.
export const JOB_FILTERS = Object.freeze(["all", "busy", "failed", "needs", "done"]);
export function jobCategory(job) {
  if (job.state === "failed" || job.state === "rejected") return "failed";
  if (["needs_user", "blocked", "unconfirmed", "unavailable"].includes(job.state)) return "needs";
  if (job.state === "cancelled" || (job.state === "succeeded" && isTerminal(job))) return "done";
  return "busy";
}
// "清理已完成" / "删除失败项": local records only, finished jobs only. Unknown and unconfirmed jobs are
// never terminal, so they are never dropped.
export const pruneJobs = (jobs, kind) => (kind === "done" || kind === "failed")
  ? jobs.filter((job) => preserveWebIdentity(job) || !(isTerminal(job) && jobCategory(job) === kind)) : jobs;
// "重试失败": only failed jobs whose last receipt allowed a retry. A job whose outcome is unknown (even
// one carrying an old can_retry) or that needs the user is never rewritten by a bulk retry.
export const retryableKeys = (jobs) => jobs
  .filter((job) => jobCategory(job) === "failed" && job.state === "failed" && job.can_retry === true && job.job_id)
  .map((job) => job.request_key);

// Jobs a "全部再次核对" replays: refused with request_identity_conflict after a send whose outcome could
// not be ruled out (state "unconfirmed"). Unknown jobs keep reconciling on their own and are not included.
export const conflictKeys = (jobs) => jobs
  .filter((job) => job.state === "unconfirmed" && job.reason === "request_identity_conflict")
  .map((job) => job.request_key);

// How the picker treats a sniffed URL that already has a local job (the latest one for that URL):
// "done" (stored), "busy" (with the Mac), "retry" (failed and the Mac's last receipt allows a retry of that
// same job), "blocked" (unknown outcome, needs you, refused: not selectable), or "new" (no job, or one that
// ended without creating anything to retry: cancelled / not sent / failed without retry, as before).
export function pickStatus(job) {
  if (!job) return "new";
  if (job.state === "succeeded") return "done";
  if (preserveWebIdentity(job)) return "blocked";
  if (["pending", "queued", "leased", "artifact_ready", "retry_wait"].includes(job.state)) return "busy";
  if (job.state === "failed" && job.can_retry === true && job.job_id) return "retry";
  if (["unknown", "unconfirmed", "needs_user", "blocked", "rejected"].includes(job.state)) return "blocked";
  return "new";
}


// ---- labels and texts ---------------------------------------------------------------------------
// What a progress row is called: the title saved with the job, else the URL's last part (for Amp
// episodes the season and episode, e.g. "season-02-episode-03"), else the URL.
export function jobLabel(job) {
  if (typeof job?.title === "string" && job.title.trim()) return job.title.trim();
  try {
    const url = new URL(job.url);
    const parts = url.pathname.split("/").filter(Boolean);
    if (isPodcastEpisode(job.url)) return parts.slice(1).join("-");
    return parts.at(-1) || url.hostname;
  } catch { return String(job?.url || ""); }
}

export const FILTER_TEXT = Object.freeze({ all: tx('全部'), busy: tx('进行中'), failed: tx('失败'), needs: tx('需处理'), done: tx('完成') });
// Counts per filter, one set of numbers for the filter chips and the menu summary.
export function filterCounts(jobs) {
  const counts = Object.fromEntries(JOB_FILTERS.map((f) => [f, 0]));
  for (const job of jobs || []) { counts.all += 1; counts[jobCategory(job)] += 1; }
  return counts;
}
// The progress summary shown next to "查看进度": same categories as the progress page's filters.
export function progressSummary(jobs) {
  const n = filterCounts(jobs);
  const parts = [n.busy && tx('进行中 {0}', n.busy), n.needs && tx('需处理 {0}', n.needs), n.failed && tx('失败 {0}', n.failed)].filter(Boolean);
  return { busy: n.busy > 0, attention: n.needs + n.failed > 0, text: parts.length ? parts.join(" · ") : n.all ? tx('全部完成') : "" };
}

// Where a job was sent, as shown on its progress row (never the folder ID).
export function destinationText(job) {
  const d = job?.want?.destination;
  if (d?.mode === "group") return tx('放入 {0}', (d.path || []).join(" / "));
  if (isSafeJob(job) && job.want?.target_group_id) return tx('归入（旧版）');
  return tx('收进 Inbox');
}
const ACTION_TEXT = { retry: tx('重试'), cancel: tx('取消') };
const NOT_SENT = {
  not_allowed_locally: tx('没有发出：本地记录显示这条现在不能{0}'),
  no_job_id: tx('没有发出：本地记录里没有 Mac 任务号'),
  mac_unreachable: tx('没有发出：当时连不上 Mac 收录服务'),
  settings_required: tx('没有发出：设置里缺少收录入口或连接密钥'),
  feature_missing: tx('没有发出：Mac 端没有开放链接任务'),
  not_found: tx('没有发出：本地列表里已找不到这条'),
  intake_changed: tx('没有发出：收录入口或连接密钥已变化，原快照不能用于新请求'),
  no_response: tx('后台没有回应，{0}可能没有发出；请在 chrome://extensions 重新加载 元芳扩展后再试')
};
// Why an action of kind `verb` was not sent, for a fixed code (mac_unreachable when unknown).
export const notSentText = (code, verb) => (NOT_SENT[code] || NOT_SENT.mac_unreachable).replace("{0}", verb);
// The line shown under a row about its last retry/cancel ("" when there is nothing to say).
export function actionText(job) {
  const a = job?.last_action;
  if (!a || typeof a !== "object") return "";
  const verb = ACTION_TEXT[a.action] || ACTION_TEXT.retry;
  const when = Number.isFinite(a.at) ? new Date(a.at).toLocaleTimeString(LOCALE, { hour: "2-digit", minute: "2-digit", hour12: false }) : "";
  const tail = (text) => when ? `${text}（${when}）` : text;
  if (a.ok) return a.action === "retry" && job.state === "failed" ? tail(tx('Mac 收到了重试，但这条仍是失败')) : "";
  if (NOT_SENT[a.code]) return tail(NOT_SENT[a.code].replace("{0}", verb));
  if (a.code === "timeout") return tail(tx('{0}请求 15 秒内没有回应，Mac 是否收到未知', verb));
  const detail = [a.http_status ? `HTTP ${a.http_status}` : null, a.code].filter(Boolean).join(" · ");
  return tail(tx('{0}未被 Mac 受理（{1}）', verb, detail || "unknown"));
}

const STATE_TEXT = {
  pending: ["busy", tx('等待交给 Mac')],
  unknown: ["busy", tx('结果未知，正在向 Mac 读回')],
  queued: ["busy", tx('已在 Mac 队列中排队')],
  leased: ["busy", tx('正在抓取正文和元数据')],
  artifact_ready: ["busy", tx('正在整理入库')],
  retry_wait: ["wait", tx('等待重试')],
  needs_user: ["warn", tx('需要你处理')],
  succeeded: ["ok", tx('已存入资料库')],
  failed: ["error", tx('抓取失败')],
  cancelled: ["muted", tx('已取消')],
  rejected: ["error", tx('Mac 拒绝了这个链接')],
  blocked: ["warn", tx('需要你处理')],
  unconfirmed: ["warn", tx('需处理')],
  unavailable: ["warn", tx('Mac 批量收录尚未开放，未发送')]
};
const REASON_TEXT = {
  target_missing: tx('没有有效的归入文件夹 ID，未发送'),
  challenge_detected: tx('站点要求人工验证，请在浏览器打开后点 元芳图标收录'),
  interactive_login_required: tx('需要登录才能看到，请在浏览器打开后点 元芳图标收录'),
  unsupported_content: tx('没取到可收录正文，可能需要浏览器渲染；可在浏览器打开后点 元芳图标收录'),
  rate_limited: tx('站点限流'),
  cancelled_by_user: tx('你取消了'),
  permission_denied: tx('没有收录权限'),
  request_identity_conflict: tx('同一请求的内容不一致，已停止'),
  invalid_request: tx('链接或参数无效'),
  resource_not_found: tx('Mac 上找不到这个任务'),
  podcast_retry: tx('Mac 处理这一集时出错，可以重试')
};
const UNCONFIRMED_TEXT = { request_identity_conflict: tx('与原请求参数不一致'), permission_denied: tx('授权被拒'), resource_not_found: tx('找不到这条请求') };
const QUALITY_TEXT = {
  pending: tx('模型检查：等收录完成'), running: tx('模型检查中'), passed: tx('模型检查：通过'), corrected: tx('模型检查：已修正格式'),
  needs_review: tx('模型检查：有建议待你确认'), failed: tx('模型检查失败（未校正）'), unavailable: tx('模型检查：不可用')
};
const COMMENT_TEXT = { pending: tx('评论：等待'), captured: tx('评论：已收录'), none_found: tx('评论：这次快照里没识别到评论区'), in_frame: tx('评论在嵌入框里，未收录'), too_large: tx('评论过大，未收录'), unavailable: tx('评论：不可用') };

const PLACEMENT_TEXT = { existing_locations_preserved: tx('已存在，位置未变'), selected_group: tx('已放入所选文件夹'), unfiled: tx('已收进 Inbox') };

export function describe(job, now = Date.now()) {
  if (job.want?.web_snapshot) {
    const labels = { pending: tx('等待逐个打开网页'), unknown: tx('快照已提交，结果未知；请核对原请求'),
      unconfirmed: tx('结果未确认；保留原快照，等待核对'), needs_user: tx('网页抓取已停止，需处理'),
      succeeded: tx('网页快照已入库'), cancelled: tx('已取消'), failed: tx('快照在入库前被明确拒收') };
    const reasons = { site_permission_required: tx('未取得所选站点访问权限'), web_redirected: tx('目标发生重定向，未抓取新页面'),
      web_load_timeout: tx('网页加载超时'), unsafe_web_url: tx('不安全的网页地址'), intake_changed: tx('收录入口已变化，原快照未重投'),
      snapshot_missing: tx('原快照缺失，不能重新抓取冒充原请求'), web_feature_missing: tx('Mac 未开放网页快照'),
      browser_visit_in_progress: tx('正在可见访问，或访问已中断；在途不可取消。中断后请先关闭遗留标签页，再核对原请求'),
      web_content_conflict: tx('正文或原请求冲突，未覆盖'), interactive_login_required: tx('需要登录或人工验证，未采集'),
      settings_required: tx('设置里缺少收录入口或连接密钥'), page_changed: tx('页面在抓取时变了，未采集'),
      invalid_receipt: tx('Mac 的回执无法识别，结果未确认'), unknown_capture: tx('快照已发出但没有收到确认，结果未知'),
      interactive_control_detected: tx('Mac 拒收：页面含需要操作的交互控件'), interactive_authentication_detected: tx('Mac 拒收：页面要求登录或身份验证'),
      automated_access_challenge_detected: tx('Mac 拒收：页面是人机验证'), html_has_no_visible_content: tx('Mac 拒收：页面没有可见正文'),
      generic_html_requires_preview: tx('Mac 拒收：这类普通网页需先在 Mac 端预览确认') };
    const intake = /^intake_(\d{3})$/.exec(job.reason || "");
    const parts = [job.reason === "browser_visit_in_progress" ? tx('可见访问／中断核对') : labels[job.state] || tx('网页抓取已停止，需处理')];
    if (job.reason) parts.push(reasons[job.reason] || REASON_TEXT[job.reason] || (intake ? tx('Mac 收录服务返回 HTTP {0}，结果未确认', intake[1]) : job.reason));
    if (job.missing_images) parts.push(tx('{0} 张图片未取得本地证据，保留原链接', job.missing_images));
    return { tone: job.state === "succeeded" ? "ok" : job.state === "cancelled" ? "muted" : job.state === "pending" ? "busy" : "warn", text: parts.join(" · ") };
  }
  const [tone, text] = STATE_TEXT[job.state] || STATE_TEXT.unknown;
  // Whether this was a new capture or an enrichment of an existing episode is the Mac's decision.
  // A job held back here was never sent, so it is not something the Mac refused.
  const safe = isSafeJob(job);
  // Placement is this job's outcome, never a claim about where the item is now.
  const placed = safe && job.state === "succeeded" ? PLACEMENT_TEXT[job.placement] : null;
  const parts = [placed ? placed
    // A partial cover/metadata result never reads as full completion.
    : safe && job.state === "succeeded" && job.enrichment === "partial" ? tx('已入库，部分信息未能补全（封面或元数据）')
    : safe && job.state === "succeeded" ? tx('完成：Mac 已按节目收录或补全') : job.reason === "target_missing" ? tx('未发送')
    : safe && job.state === "rejected" && job.reason === "invalid_request" ? tx('提交失败') : job.state === "blocked" ? tx('需处理') : text];
  // First-send 400/409 only mean this request was not accepted and created no task; they say nothing
  // about whether the episode is already in the library.
  if (placed && job.enrichment === "partial") parts.push(tx('部分信息未能补全（封面或元数据）'));
  if (job.state === "unconfirmed") parts.push(job.reason === "invalid_request" || job.reason === "podcast_duplicate_conflict"
    ? tx('Mac 现在拒绝这条请求（目标无效或有重复），但无法确认之前是否已受理；请在 Mac 端核对')
    : tx('Mac 现在拒绝这条请求（{0}），但无法确认之前是否已受理；请在 Mac 端核对', UNCONFIRMED_TEXT[job.reason] || job.reason));
  else if (safe && job.reason === "invalid_request") parts.push(tx('这次请求未被受理（目标或移出文件夹无效），没有新建任务；请重新选择后再提交'));
  else if (safe && job.reason === "podcast_duplicate_conflict") parts.push(tx('这次请求未被受理（库里有重复副本），没有新建任务；请在 Mac 端处理重复项'));
  else if (job.reason) parts.push(REASON_TEXT[job.reason] || tx('原因：{0}', job.reason));
  if (job.state === "retry_wait" && job.retry_at_ms) {
    const at = new Date(job.retry_at_ms);
    const sameDay = at.toDateString() === new Date(now).toDateString();
    parts.push(tx('Mac 计划 {0} 再试', at.toLocaleString(LOCALE, sameDay ? { hour: "2-digit", minute: "2-digit", hour12: false } : { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })));
  }
  const quality = job.quality_check || {};
  // "Not checked because nothing was stored" is not the same as "the model route is unavailable".
  if (quality.state === "unavailable" && quality.reason === "capture_not_committed") parts.push(tx('模型检查：未入库，未检查'));
  else if (QUALITY_TEXT[quality.state]) parts.push(QUALITY_TEXT[quality.state]);
  if (COMMENT_TEXT[job.comments?.state]) parts.push(COMMENT_TEXT[job.comments.state]);
  return { tone, text: parts.join(" · ") };
}
