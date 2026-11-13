// The toolbar popup menu ("收录 1 篇" / "批量嗅探" / "纳入数据库路径") and the item picker shared with the
// batch-sniff page. Nothing is submitted until the user clicks. All job writes go to the background
// runner by message; progress is shown in the side panel (progress.js).
import { localizeDocument, tx } from "./i18n.js";
import { createProbe, loadActive, loadGroups, MAX_BATCH, parseLinks, planFor } from "./jobs.js";
import { describe, isPodcastEpisode, isSafeJob, pickStatus, preserveWebIdentity, progressSummary } from "./progress-model.js";
import { canonicalUrl } from "./saved-index.js";
import { CHOICES, pushHistory, reconcileHistory, resolveCustom } from "./destination.js";
import { classifyCandidates, decidePage } from "./sniff.js";
import { webOrigin } from "./web-batch.js";

const WHY = { nav: tx('导航'), social: tx('分享或社交'), offsite: tx('站外'), not_article: tx('不像文章'), not_item: tx('不在条目列表里') };
const CAPTURE_ERROR = {
  unsupported_page: tx('这个页面不能收录（只支持 http/https 网页）'),
  settings_required: tx('请先在设置里填写 Mac 收录入口和连接密钥'),
  page_changed: tx('页面在收录时变了，请再点一次'),
  web_feature_missing: tx('Mac 端尚未开放网页快照目录归档，请更新后端后再试'),
  unknown_capture: tx('结果尚未确认；再次点击将核对原请求，不会重新抓取'),
  web_identity_protected: tx('保留原网页请求；请在进度页核定，普通收录不能另起抓取'),
  intake_409: tx('原请求或已收录正文存在冲突；保留原文，不覆盖'),
  no_article: tx('没找到可收录的正文')
};
const STATUS_TEXT = { done: tx('已收录'), busy: tx('处理中'), retry: tx('上次失败 · 可重试') };
const missingText = (missing) => missing.join("、");
const pathText = (path) => (path || []).join(" / ");

// Why "当前 Mac 目录" cannot be used right now ("" when it can).
function currentReason(active) {
  if (active?.state === "ok") return "";
  if (active?.state === "closed") return tx('Mac 端尚未开放读取当前目录（缺少：{0}）', missingText(active.missing));
  if (active?.state === "error") return tx('读取 Mac 当前目录失败（{0}），重新打开或切回本窗口时会再读', active.code);
  if (active?.reason === "none") return tx('Mac 端没有选中目录（在 Inbox、全部条目或搜索里）；在 Mac 端点选一个目录即可');
  if (active?.reason === "readonly") return tx('Mac 当前目录「{0}」是只读的', pathText(active.path));
  if (active?.reason === "invalid") return tx('Mac 当前选中的目录已失效，请在 Mac 端重新点选');
  return tx('正在读取 Mac 当前目录…');
}
// Why "自选目录" cannot be used right now ("" when it can).
function customReason(custom) {
  if (custom?.state === "ok") return "";
  if (custom?.state === "closed") return tx('Mac 端尚未开放目录列表（缺少：{0}）', missingText(custom.missing));
  if (custom?.state === "error") return tx('读取目录列表失败（{0}），重新打开或切回本窗口时会再读', custom.code);
  if (custom?.reason === "unset") return tx('还没选目录，点「选择…」');
  if (custom?.reason === "readonly") return tx('「{0}」是只读的，请换一个目录', pathText(custom.path));
  return tx('正在读取目录列表…');
}

export async function mountPanel(doc, deps) {
  const { local, send, connect } = deps;
  const win = doc.defaultView;
  localizeDocument(doc);
  const $ = (id) => doc.getElementById(id);
  const popup = deps.kind === "popup";
  doc.body.classList.toggle("popup", popup);
  const pageUrl = deps.page?.pageUrl ? String(deps.page.pageUrl).replace(/#.*$/, "") : null;

  const prefs = await local.get(["destChoice", "destCustom", "destHistory", "defaultQualityCheck", "defaultComments", "batchJobs", "savedUrls"]);
  // The destination radio is one remembered choice shared by every entry (popup menu, picker,
  // right-click sniff). Default Inbox. "自选目录" keeps its own group_id (+ path for display) and a
  // recent-folders list; none of them ever falls back to Inbox.
  let choice = CHOICES.includes(prefs.destChoice) ? prefs.destChoice : "inbox";
  let customPick = prefs.destCustom && typeof prefs.destCustom.group_id === "string" ? prefs.destCustom : null;
  let history = Array.isArray(prefs.destHistory) ? prefs.destHistory : [];
  let customGone = null; // path of a remembered folder that is no longer listed (cleared, shown once)
  const jobs = Array.isArray(prefs.batchJobs) ? prefs.batchJobs : [];
  let conn = { ok: false, pending: true, capabilities: { features: [] }, transport: null };
  let targetsLoading = true;
  let active = null;
  let groups = null;
  let treeOpen = false;
  const custom = () => resolveCustom(customPick, groups);

  const decision = deps.page ? (popup ? decidePage(deps.page) : { mode: "list", candidates: classifyCandidates(deps.page, { explicit: deps.explicit }) }) : { mode: "list", candidates: [] };
  let candidates = decision.candidates;
  const bodyReference = (c) => c.occurrences?.some((o) => o.role === "citation" || o.role === "learn_more");
  let referenceScope = candidates.some(bodyReference) ? "body" : "all";
  const visibleCandidates = () => referenceScope === "body" ? candidates.filter(bodyReference)
    : referenceScope === "related" ? candidates.filter((c) => c.occurrences?.some((o) => o.role === "related")) : candidates;
  if (referenceScope === "body") {
    for (const c of candidates) if (!bodyReference(c)) c.checked = false;
    const scopes = doc.createElement("div"); scopes.className = "list-head"; scopes.id = "reference-scopes";
    for (const [scope, label] of [["body", tx('正文引用与 Learn more')], ["related", "Related posts"], ["all", tx('全部链接')]]) {
      const button = doc.createElement("button"); button.type = "button"; button.className = "link"; button.dataset.scope = scope;
      button.textContent = label;
      button.addEventListener("click", () => {
        referenceScope = scope;
        candidates.forEach((c) => { c.checked = false; });
        renderCandidates(); update();
      });
      scopes.append(button);
    }
    $("candidates").before(scopes);
  }
  // Items already handed to the Mac (and not failed) start unchecked, so reopening does not resubmit them.
  const sent = new Set(jobs.filter((job) => preserveWebIdentity(job) || !["rejected", "failed", "cancelled", "unavailable"].includes(job.state)).map((job) => job.url));
  // Each row follows the latest local job for its URL. Only new items and failed jobs the Mac allows to
  // retry can be checked; a retry acts on that job (same key, payload and job_id), never a new one.
  const jobByUrl = new Map(jobs.map((job) => [job.url, job]));
  // URLs the library already has, kept even after their job records were cleared.
  const saved = new Set((Array.isArray(prefs.savedUrls) ? prefs.savedUrls : []).map((e) => e?.url));
  for (const c of candidates) {
    c.job = jobByUrl.get(c.url) || null;
    c.status = pickStatus(c.job);
    if (c.status === "new" && saved.has(canonicalUrl(c.url))) c.status = "done";
    if (c.status !== "new") c.checked = false;
  }
  const selectable = (c) => c.status === "new" || c.status === "retry";
  // The popup opens on the menu and does nothing until a click; the batch page opens on the picker.
  let view = popup ? "menu" : "list";
  let submitted = false;
  let working = false;
  let pageSent = Boolean(pageUrl && sent.has(pageUrl));
  const pageSaved = Boolean(pageUrl && saved.has(canonicalUrl(pageUrl)));
  // "查看进度" summary, live while the page is open.
  const renderSummary = (list) => {
    const s = progressSummary(list);
    const el = $("progress-summary");
    el.hidden = !s.text;
    el.textContent = s.text;
    el.classList.toggle("busy", s.busy);
    el.classList.toggle("attention", s.attention);
  };
  renderSummary(jobs);
  deps.onJobs?.((next) => renderSummary(Array.isArray(next) ? next : []));

  // ---- items -------------------------------------------------------------------------------------
  const meta = (c) => {
    if (c.kind === "podcast") {
      const parts = [c.episode ? tx('第 {0} 季 · 第 {1} 集', c.episode.season, c.episode.episode) : null, c.duration, tx('Amp 播客 · 不生成内容')];
      return parts.filter(Boolean).join(" · ");
    }
    const roles = { citation: tx('正文引用'), learn_more: "Learn more", related: "Related posts" };
    const provenance = [...new Set((c.occurrences || []).map((o) => roles[o.role]).filter(Boolean))].join(" / ");
    try { const u = new URL(c.url); return `${provenance ? `${provenance} · ` : ""}${u.hostname}${u.pathname}`; } catch { return c.url; }
  };
  const row = (c) => {
    const li = doc.createElement("li");
    const label = doc.createElement("label");
    label.title = c.url;
    const box = doc.createElement("input");
    box.type = "checkbox"; box.checked = c.checked;
    box.addEventListener("change", () => { c.checked = box.checked; update(); });
    const body = doc.createElement("span"); body.className = "body";
    const title = doc.createElement("span"); title.className = "title"; title.textContent = c.title || c.url;
    box.disabled = !selectable(c);
    li.className = `st-${c.status}${box.disabled ? " off" : ""}`;
    const sub = doc.createElement("span"); sub.className = "sub"; sub.textContent = meta(c) + (c.status === "new" && c.why && !c.checked ? ` · ${WHY[c.why]}` : "");
    body.append(title, sub);
    const state = c.status === "blocked" ? describe(c.job).text : STATUS_TEXT[c.status];
    if (state) { const el = doc.createElement("span"); el.className = "state"; el.textContent = state; el.title = state; body.append(el); }
    label.append(box, body);
    li.append(label);
    return li;
  };
  // Main group: the recognized items/episodes. "其他链接" (nav, share, offsite…) is its own folded group.
  const mainGroup = () => visibleCandidates().filter((c) => referenceScope !== "all" || !c.why);
  const otherGroup = () => visibleCandidates().filter((c) => referenceScope === "all" && c.why);
  // Selecting a group checks only what can be sent: new items and retryable failures.
  const pick = (group) => { for (const c of group) if (selectable(c)) c.checked = true; };
  const renderCandidates = () => {
    for (const b of doc.querySelectorAll("[data-scope]")) b.setAttribute("aria-pressed", String(b.dataset.scope === referenceScope));
    $("candidates").replaceChildren(...mainGroup().map(row));
    $("others").hidden = otherGroup().length === 0;
    $("others-list").replaceChildren(...otherGroup().map(row));
    $("empty").hidden = candidates.length > 0;
    $("empty").textContent = tx('这页上没找到可收录的条目链接。');
  };

  // ---- plan + gating -----------------------------------------------------------------------------
  const chosen = () => {
    const list = visibleCandidates().filter((c) => c.checked && c.status === "new").map((c) => c.url);
    if (popup && view === "list" && $("include-page").checked && pageUrl && !list.includes(pageUrl)) list.unshift(pageUrl);
    return list.slice(0, MAX_BATCH);
  };
  const planOf = (url) => {
    if (targetsLoading) return { ok: false, reason: "targets_loading" };
    const plan = planFor(url, { choice, capabilities: conn.capabilities, active, custom: custom(),
      defaults: { quality: prefs.defaultQualityCheck === true, comments: prefs.defaultComments === true } });
    if (plan.want?.web_snapshot) plan.want.intake_binding = conn.intakeBinding;
    return plan.want?.web_snapshot && !webOrigin(url) ? { ok: false, reason: "unsafe_web_url" } : plan;
  };
  const plans = () => chosen().map((url) => ({ url, plan: planOf(url) }));
  const retries = () => candidates.filter((c) => c.checked && c.status === "retry").slice(0, MAX_BATCH);
  const unitOf = (list, n = list.length) => list.every((c) => c.kind === "podcast") ? tx('{0} 集', n) : tx('{0} 条', n);
  // Where a retried job goes: the destination it was first submitted with.
  const originOf = (job) => {
    const d = job?.want?.destination;
    if (d?.mode === "group") return { key: d.group_id, label: pathText(d.path) };
    if (d?.mode === "inbox" || !isSafeJob(job) || !job?.want?.target_group_id) return { key: "inbox", label: "Inbox" };
    return { key: "legacy", label: tx('旧版归入文件夹') };
  };
  const currentKey = () => {
    if (choice === "inbox") return "inbox";
    const target = choice === "current" ? active : custom();
    return target?.state === "ok" ? target.group_id : null;
  };
  // Said above the button when retries keep a destination other than the one selected now.
  const retryNote = (again) => {
    if (!again.length) return "";
    const groups = new Map();
    for (const c of again) { const o = originOf(c.job); groups.set(o.key, { ...o, list: [...(groups.get(o.key)?.list || []), c] }); }
    if (groups.size === 1 && groups.has(currentKey())) return "";
    if (groups.size === 1) return tx('重试的 {0}沿用原去向 {1}', unitOf(again), [...groups.values()][0].label);
    return tx('重试的 {0}沿用各自原去向：{1}', unitOf(again), [...groups.values()].map((g) => `${g.label} ${unitOf(g.list)}`).join("、"));
  };
  // Why "全选" can check nothing.
  const pickWhy = (main) => {
    if (!main.length || main.some(selectable)) return "";
    const n = (status) => main.filter((c) => c.status === status).length;
    if (!n("blocked")) return tx('{0}都已收录或正在处理', unitOf(main));
    return tx('没有可勾选的条目：已收录 {0} · 处理中 {1} · 需处理 {2}', n("done"), n("busy"), n("blocked"));
  };
  const heldText = (held) => {
    const reasons = new Set();
    for (const { url, plan } of held) {
      if (plan.reason === "missing") reasons.add(isPodcastEpisode(url)
        ? tx('Mac 端尚未开放 Amp 播客安全收录（缺少：{0}），这些节目不会提交，也不会改用普通收录', missingText(plan.missing))
        : tx('Mac 端尚未开放链接收录（缺少：{0}）', missingText(plan.missing)));
      else if (plan.reason === "article_needs_inbox") reasons.add(tx('普通网页目前只能收进 Inbox：请把「纳入数据库路径」切到 Inbox，或取消勾选这些网页'));
      else if (plan.reason === "active") reasons.add(tx('当前 Mac 目录不可用：{0}', currentReason(active)));
      else if (plan.reason === "custom") reasons.add(tx('自选目录不可用：{0}', customReason(custom())));
      else if (plan.reason === "unsafe_web_url") reasons.add(tx('所选链接包含 IP、本地域名或非标准 HTTPS 地址，未发送'));
      else if (plan.reason === "targets_loading") reasons.add(tx('正在读取所选收录入口的目录，请稍候'));
    }
    return [...reasons].join("；");
  };
  // Where a submit would go right now, as shown on the submit button and the menu.
  const destinationLabel = () => {
    if (choice === "inbox") return tx('收进 Inbox');
    const target = choice === "current" ? active : custom();
    return target?.state === "ok" ? tx('放入 {0}', pathText(target.path)) : choice === "current" ? tx('放入当前 Mac 目录') : tx('放入自选目录');
  };
  // What "收录 1 篇" would do now: an Amp episode becomes a job with the remembered destination; an
  // ordinary snapshots use deep destinations only with web-snapshot-v1.
  const single = () => {
    if (targetsLoading) return { ok: false, why: tx('正在读取所选收录入口的目录，请稍候') };
    if (!pageUrl) return { ok: false, why: CAPTURE_ERROR.unsupported_page };
    if (pageSent) return { ok: false, why: jobs.some(j => j.url === pageUrl && preserveWebIdentity(j))
      ? CAPTURE_ERROR.web_identity_protected : tx('本页已交给 Mac，进度见「查看进度」') };
    if (pageSaved) return { ok: false, why: tx('本页已收录') };
    if (isPodcastEpisode(pageUrl)) {
      if (!conn.ok) return { ok: false, why: conn.pending ? tx('正在连接 Mac…') : tx('Mac 收录服务正在启动或暂时不可达，稍后自动重试') };
      const plan = planOf(pageUrl);
      return plan.ok ? { ok: true, plan } : { ok: false, why: heldText([{ url: pageUrl, plan }]) };
    }
    if (choice !== "inbox") {
      if (!conn.capabilities?.webSnapshot) return { ok: false, why: tx('普通网页目前只能收进 Inbox：把「纳入数据库路径」切到 Inbox 后再收录') };
      const target = choice === "current" ? active : custom();
      if (target?.state !== "ok") return { ok: false, why: choice === "current" ? currentReason(active) : tx('请选择可写的自选目录') };
      return { ok: true, article: true, destination: { mode: "group", group_id: target.group_id, path: target.path } };
    }
    return { ok: true, article: true, destination: { mode: "inbox" } };
  };

  // ---- destinations ------------------------------------------------------------------------------
  // Picks a folder from the tree or the history list: it becomes the remembered "自选目录".
  const chooseCustom = async (node) => {
    customPick = { group_id: node.group_id, path: [...node.path] };
    choice = "custom"; customGone = null; treeOpen = false;
    await local.set({ destChoice: choice, destCustom: customPick });
    update();
  };
  const renderDestinations = () => {
    const currentWhy = currentReason(active);
    const cur = custom();
    const customWhy = customReason(cur);
    $("dest-inbox").checked = choice === "inbox";
    $("dest-current").checked = choice === "current";
    $("dest-current").disabled = Boolean(currentWhy);
    $("dest-current-row").classList.toggle("off", Boolean(currentWhy));
    $("dest-current-title").textContent = active?.state === "ok" ? tx('当前 Mac 目录：{0}', pathText(active.path)) : tx('当前 Mac 目录');
    $("dest-current-sub").textContent = currentWhy || tx('Mac 端正停留的目录；提交时按这一刻读到的目录记下');
    const closed = cur.state === "closed" || cur.state === "error";
    $("dest-custom").checked = choice === "custom";
    $("dest-custom").disabled = closed;
    $("dest-custom-row").classList.toggle("off", closed);
    $("dest-choose").hidden = closed;
    $("dest-choose").textContent = treeOpen ? tx('收起') : tx('选择…');
    const customTitle = cur.path?.length && cur.reason !== "missing" ? tx('自选目录：{0}', pathText(cur.path)) : tx('自选目录');
    $("dest-custom-title").textContent = customTitle;
    $("dest-custom-sub").textContent = customGone ? tx('上次自选的目录「{0}」已不在列表里，已清空；请重新选择', pathText(customGone))
      : customWhy || tx('任意可写的库或文件夹，任意深度');
    // Collapsed, the box shows only the selected item (and why it cannot be used, if so).
    const why = choice === "current" ? currentWhy : choice === "custom" ? customWhy : "";
    $("dest-summary").textContent = choice === "inbox" ? "Inbox" : choice === "current" ? $("dest-current-title").textContent : customTitle;
    $("dest-summary-why").textContent = why;
    // Folder tree: any writable library root or folder at any depth; read-only ones are greyed out.
    const tree = $("dest-tree");
    tree.hidden = !treeOpen || closed;
    if (!tree.hidden) {
      const nodes = groups?.state === "ok" ? [...groups.nodes.values()] : [];
      tree.replaceChildren(...(nodes.length ? nodes.map((node) => {
        const li = doc.createElement("li");
        li.classList.toggle("off", !node.writable);
        const label = doc.createElement("label");
        label.style.paddingLeft = `${12 + node.depth * 16}px`;
        label.title = pathText(node.path);
        const input = doc.createElement("input");
        input.type = "radio"; input.name = "dest-tree"; input.disabled = !node.writable;
        input.checked = cur.state === "ok" && cur.group_id === node.group_id;
        input.addEventListener("change", () => chooseCustom(node));
        const name = doc.createElement("span"); name.className = "name"; name.textContent = node.path.at(-1);
        label.append(input, name);
        if (!node.writable) { const ro = doc.createElement("span"); ro.className = "why"; ro.textContent = tx('只读'); label.append(ro); }
        li.append(label);
        return li;
      }) : [Object.assign(doc.createElement("li"), { className: "empty", textContent: groups?.state === "ok" ? tx('没有可显示的目录') : tx('正在读取目录列表…') })]));
    }
    // Recently used folders, checked against the current list: gone ones hidden, read-only greyed, new names shown.
    const recent = closed ? [] : reconcileHistory(history, groups);
    $("dest-history").hidden = recent.length === 0;
    $("dest-history-list").replaceChildren(...recent.map((entry) => {
      const chip = doc.createElement("button");
      chip.type = "button"; chip.className = "chip"; chip.textContent = pathText(entry.path);
      chip.disabled = !entry.writable;
      chip.title = entry.writable ? pathText(entry.path) : tx('「{0}」是只读的，请换一个目录', pathText(entry.path));
      chip.classList.toggle("on", choice === "custom" && cur.state === "ok" && cur.group_id === entry.group_id);
      chip.addEventListener("click", () => chooseCustom(entry));
      return chip;
    }));
  };

  const webNotice = doc.createElement("p");
  webNotice.className = "small"; webNotice.id = "web-navigation-notice";
  webNotice.textContent = tx('点击即授权逐个可见导航：浏览器可能先请求重定向和子资源；插件不提供 DNS 或私网防护，只读取并入库 URL 未变化的原页面。不登录、不读 cookie、不展开引用；仅未开始访问的排队项可取消。');
  $("submit").before(webNotice);
  const update = () => {
    const list = plans();
    const held = list.filter(({ plan }) => !plan.ok);
    const count = list.length;
    const main = mainGroup();
    const other = otherGroup();
    const otherChecked = other.filter((c) => c.checked).length;
    $("pick-count").textContent = tx('已选 {0} / {1}', main.filter((c) => c.checked).length, main.length);
    $("others-summary").textContent = tx('其他链接 {0} 个（导航、分享、站外等，默认不选）', other.length) +
      (otherChecked ? ` · ${tx('已选 {0}', otherChecked)}` : "");
    $("held").textContent = conn.ok ? heldText(held) : "";
    const again = retries();
    const total = count + again.length;
    const label = again.length ? tx('收录 {0} 条（其中重试 {1} 条）', total, again.length) : tx('收录 {0} 条', total);
    const web = list.some(({ plan }) => plan.want?.web_snapshot);
    webNotice.hidden = !web;
    $("submit").textContent = web ? `${tx('打开并抓取已选链接')} · ${count} · ${destinationLabel()}`
      : !total ? tx('收录') : count ? `${destinationLabel()} · ${label}` : label;
    $("submit").disabled = targetsLoading || working || submitted || !conn.ok || total === 0 || held.length > 0;
    $("retry-note").textContent = retryNote(again);
    $("pick-why").textContent = pickWhy(main);
    if (popup) {
      const s = single();
      $("capture-one").disabled = working || !s.ok;
      $("capture-one-page").textContent = deps.page?.title || pageUrl || tx('这个页面不能读取');
      const snapshotNotice = s.article && conn.capabilities?.webSnapshot && (prefs.defaultComments || prefs.defaultQualityCheck)
        ? tx('；结构化快照仅保存正文与图片，本次不采评论、不执行 AI 核对') : "";
      $("capture-one-note").textContent = s.ok ? destinationLabel() + snapshotNotice : s.why;
      $("capture-one-note").classList.toggle("blocked", !s.ok);
      $("sniff").disabled = !deps.page;
      $("sniff-count").textContent = deps.page ? tx('本页发现 {0} 条', main.length) : tx('这个页面不能读取');
    }
    renderDestinations();
  };

  // ---- capability probe --------------------------------------------------------------------------
  // the Mac's current folder and the folder list are re-read on open and on every focus/visibility
  // probe. loadActive / loadGroups keep their feature gates: without the features nothing is sent.
  const refreshTargets = async () => {
    [active, groups] = conn.ok ? await Promise.all([loadActive(conn.transport, conn.capabilities), loadGroups(conn.transport, conn.capabilities)]) : [null, null];
    // A remembered folder that is no longer listed is cleared, and the user is told once.
    if (groups?.state === "ok" && customPick && !groups.nodes.has(customPick.group_id)) {
      customGone = customPick.path || [];
      customPick = null;
      await local.set({ destCustom: null });
    }
  };
  // Every probe result, including the backoff retries the probe runs on its own, re-gates the page: a
  // Mac that finishes starting up unlocks submitting without a click. Missing features come back with
  // ok and are held per item ("Mac 端尚未开放…"); they are re-read on focus, not polled.
  const probe = createProbe(async () => {
    targetsLoading = true;
    update();
    try { return { ...(await connect()), pending: false }; } catch { return { ok: false, reason: "unreachable", pending: false }; }
  }, async (result) => {
    conn = { capabilities: { features: [] }, ...result };
    const notice = $("notice");
    notice.hidden = result.ok;
    notice.textContent = result.ok ? "" : result.reason === "settings" ? CAPTURE_ERROR.settings_required
      : tx('Mac 收录服务正在启动或暂时不可达，稍后自动重试');
    await refreshTargets();
    targetsLoading = false;
    update();
    if (result.ok) send({ type: "kick" });
  });
  const reprobe = () => probe.run();
  win.addEventListener("focus", reprobe);
  doc.addEventListener("visibilitychange", () => { if (doc.visibilityState === "visible") reprobe(); });

  // Hands items to the background runner. A folder that was submitted to (current or self-chosen) moves
  // to the front of the recent-folders list once the runner has taken the jobs.
  const handOver = async (items) => {
    const keys = await send({ type: "submit", items });
    const folder = items.map(({ want }) => want.destination).find((d) => d?.mode === "group");
    if (Array.isArray(keys) && keys.length && folder) {
      history = pushHistory(history, { group_id: folder.group_id, path: folder.path });
      await local.set({ destHistory: history });
    }
    return keys;
  };

  // ---- views -------------------------------------------------------------------------------------
  const showView = () => {
    $("menu").hidden = view !== "menu";
    $("picker").hidden = view !== "list" || submitted;
    $("back").hidden = !popup;
    $("include-row").hidden = !(popup && pageUrl && view === "list" && decision.mode === "list");
    $("manual").hidden = popup;
  };
  const say = (text, blocked = false) => {
    $("single").hidden = false;
    $("single").classList.toggle("blocked", blocked);
    $("single-text").textContent = text;
  };
  for (const id of ["dest-inbox", "dest-current", "dest-custom"]) {
    $(id).addEventListener("change", async () => {
      choice = $(id).value;
      // Choosing "自选目录" with nothing chosen yet opens the folder tree.
      if (choice === "custom" && custom().reason === "unset") treeOpen = true;
      await local.set({ destChoice: choice });
      update();
    });
  }
  $("dest-choose").addEventListener("click", () => { treeOpen = !treeOpen; update(); });
  $("include-page").addEventListener("change", update);
  // "全选" selects the main group only; "其他链接" has its own "全选此组"; "全不选" clears both.
  $("pick-all").addEventListener("click", () => { pick(mainGroup()); renderCandidates(); update(); });
  $("pick-others").addEventListener("click", () => { pick(otherGroup()); renderCandidates(); update(); });
  $("pick-none").addEventListener("click", () => { candidates.forEach((c) => { c.checked = false; }); renderCandidates(); update(); });
  $("sniff").addEventListener("click", () => { view = "list"; $("single").hidden = true; showView(); renderCandidates(); update(); });
  $("back").addEventListener("click", () => { view = "menu"; showView(); update(); });
  $("open-progress").addEventListener("click", () => { deps.openProgress?.(); });
  // After "收录 1 篇": the episode already sent keeps its destination; a change applies to later captures.
  $("change-dest").addEventListener("click", () => {
    $("dest-box").open = true;
    $("change-dest").hidden = true;
    say(tx('这一集已交给 Mac，去向不再改动；在下面改的去向会记住，用于之后的收录。'));
  });
  $("add-links").addEventListener("click", () => {
    const { urls } = parseLinks($("links").value);
    const known = new Set(candidates.map((c) => c.url));
    candidates = [...candidates, ...classifyCandidates({ links: urls.map((url) => ({ url })) }, { explicit: true }).filter((c) => !known.has(c.url))];
    $("links").value = "";
    renderCandidates(); update();
  });
  $("submit").addEventListener("click", async () => {
    const list = plans();
    if ($("submit").disabled || list.some(({ plan }) => !plan.ok)) return;
    // Start the permission request synchronously inside this click gesture.
    // The URLs and destination below are frozen before the dialog opens.
    const origins = [...new Set(list.filter(({ plan }) => plan.want.web_snapshot).map(({ url }) => webOrigin(url)))];
    const permission = origins.length ? globalThis.chrome?.permissions?.request({ origins }) : Promise.resolve(true);
    working = true;
    // Opened while the click still counts as a user gesture (the side panel requires one).
    deps.openProgress?.();
    update();
    let granted = false;
    try { granted = await permission; } catch { /* Permission refused: nothing queued. */ }
    if (!granted) { working = false; say(tx('未取得所选站点访问权限，没有打开网页或提交任务'), true); update(); return; }
    submitted = true;
    update();
    const again = retries();
    const titleOf = (url) => candidates.find((c) => c.url === url)?.title || (url === pageUrl ? deps.page?.title : null) || null;
    let keys;
    try {
      if (list.length) keys = await handOver(list.map(({ url, plan }) => ({ url, want: plan.want, page: pageUrl, title: titleOf(url),
        ...(plan.want.web_snapshot ? { occurrences: candidates.find((c) => c.url === url)?.occurrences || [] } : {}) })));
    } catch { /* A missing reply is not successful queue acceptance. */ }
    if (list.length && (!Array.isArray(keys) || keys.length !== list.length)) {
      working = false; submitted = false; showView(); say(tx('后台未确认接收；请查看进度后再核对，不要更换目标重复提交'), true); update(); return;
    }
    for (const { url } of list) for (const c of candidates) if (c.url === url) { c.checked = false; c.status = "busy"; }
    // Failed jobs: retried in place, one by one; each outcome is also recorded on the job (last_action).
    let refused = 0;
    for (const c of again) {
      const reply = await send({ type: "act", key: c.job.request_key, action: "retry" });
      c.checked = false;
      if (reply?.ok === true) c.status = "busy"; else refused += 1;
    }
    const parts = [];
    if (list.length) parts.push(tx('新收录 {0} 条，{1}', list.length, destinationLabel()));
    if (again.length) parts.push(refused ? tx('重试 {0} 条，其中 {1} 条未被受理（原因见进度）', again.length, refused) : tx('重试 {0} 条，沿用原去向', again.length));
    showView();
    $("submitted").hidden = false;
    $("submitted").textContent = origins.length ? tx('已冻结 {0} 条链接；将逐个打开可见标签页抓取，不展开下一层引用。进度在侧边栏。', list.length)
      : tx('已交给 Mac：{0}。关掉这个窗口也会继续，进度在侧边栏。', parts.join("；"));
    working = false;
  });
  // "收录 1 篇": only on click, with the remembered destination; an unusable one sends nothing.
  $("capture-one").addEventListener("click", async () => {
    const s = single();
    if (working || !s.ok) return;
    working = true;
    if (s.plan) {
      deps.openProgress?.();
      update();
      await handOver([{ url: pageUrl, want: s.plan.want, page: pageUrl, title: deps.page?.title || null }]);
      pageSent = true;
      for (const c of candidates) if (c.url === pageUrl) { c.checked = false; c.status = "busy"; }
      const d = s.plan.want.destination;
      say(d.mode === "inbox" ? tx('已交给 Mac：这一集收进 Inbox') : tx('已交给 Mac：这一集放入 {0}', pathText(d.path)));
      $("change-dest").hidden = false;
    } else {
      update();
      say(tx('正在收录本页…'));
      const result = await deps.captureTab(s.destination);
      if (result?.ok) pageSent = true;
      const success = s.destination?.mode === "group" ? tx('已放入 {0}', pathText(s.destination.path)) : tx('已收进 Inbox');
      say(result?.ok ? success + (result.missingImages ? tx('；{0} 张图片未取得本地证据，保留原链接', result.missingImages) : "")
        : (CAPTURE_ERROR[result?.code] || tx('收录失败（{0}）', result?.code || "unknown")), !result?.ok);
    }
    working = false;
    update();
  });

  showView(); renderCandidates(); update();
  await reprobe();
  return { reprobe };
}
