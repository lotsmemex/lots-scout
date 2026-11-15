import { langPref, localizeDocument, setLangPref, tx } from "./i18n.js";
import { discoverCapabilities, SECRET_PATTERN, SETTING_KEYS, validateEndpoint } from "./capture.js";
import { OMDB_KEY_PATTERN, SECRETS_FEATURE, secretStatus, setSecret, testSecret } from "./secrets.js";

const NOT_OPEN = tx('等 Mac 端开放后可用');

export async function mountOptions(doc, deps) {
  const { local, extensionOrigin } = deps;
  localizeDocument(doc);
  const $ = (id) => doc.getElementById(id);
  const endpoint = $("endpoint"), secret = $("secret"), status = $("status");
  $("extension-origin").textContent = extensionOrigin;
  const saved = await local.get(SETTING_KEYS);
  endpoint.value = saved.endpoint || "";
  // The stored secret is never put back into the page; an empty field keeps it.
  let hasSecret = SECRET_PATTERN.test(saved.intakeSecret || "");
  const showSecret = () => {
    $("secret-state").textContent = hasSecret ? tx('已保存') : tx('未设置');
    secret.placeholder = hasSecret ? tx('●●●●●●●●●●  留空则不修改') : "";
  };
  showSecret();

  $("settings").addEventListener("submit", async (event) => {
    event.preventDefault();
    const nextSecret = secret.value || (hasSecret ? saved.intakeSecret : "");
    if (!validateEndpoint(endpoint.value) || !SECRET_PATTERN.test(nextSecret)) {
      status.textContent = tx('入口须是 http://127.0.0.1:端口/api/v1/captures，密钥须是 64 位小写十六进制。');
      return;
    }
    await local.set({ endpoint: endpoint.value, intakeSecret: nextSecret });
    saved.endpoint = endpoint.value;
    saved.intakeSecret = nextSecret;
    hasSecret = true;
    secret.value = "";
    showSecret();
    status.textContent = tx('已保存在本扩展内。');
    await refresh();
  });

  const subText = { "quality-sub": $("quality-sub").textContent, "comments-sub": $("comments-sub").textContent };
  const toggle = (id, subId, key, open) => {
    const input = $(id);
    input.disabled = !open;
    input.checked = open && saved[key] === true;
    $(subId).textContent = open ? subText[subId] : NOT_OPEN;
    input.onchange = () => local.set({ [key]: input.checked });
  };
  const omdb = mountOmdbKey($, () => saved);
  // Defaults apply only to features the configured Mac intake advertises.
  const refresh = async () => {
    const capabilities = await deps.discover(saved.endpoint, saved.intakeSecret);
    toggle("default-quality", "quality-sub", "defaultQualityCheck", capabilities.qualityCheck);
    toggle("default-comments", "comments-sub", "defaultComments", capabilities.comments);
    await omdb.refresh(capabilities.features.includes(SECRETS_FEATURE));
  };
  await refresh();
  const lang = $("ui-lang");
  lang.value = langPref();
  lang.addEventListener("change", () => setLangPref(lang.value));
}

const TEST_FAILURES = {
  not_set: '测试失败：Mac 上还没有 key。',
  rejected: '测试失败：OMDb 拒绝了这个 key。请确认已点过邮件里的激活链接。',
  network: '测试失败：Mac 连不上 OMDb，请稍后再试。',
  no_rating: 'key 可用，但这部片暂时没有烂番茄评分。'
};

// The OMDb key lives only in this input until the Mac accepts it; it is never written to
// chrome.storage and never shown again. The page shows only whether the Mac has one.
function mountOmdbKey($, settings) {
  const state = $("omdb-state"), sub = $("omdb-sub"), input = $("omdb"), result = $("omdb-result");
  const entry = $("omdb-entry"), actions = $("omdb-actions"), cancel = $("omdb-cancel");
  const subText = sub.textContent;
  let open = false, hasKey = false;
  const say = (message, tone = "") => { result.textContent = message ? tx(message) : ""; result.className = `result ${tone}`; };
  const show = (editing = false) => {
    state.textContent = open ? (hasKey ? tx('· 已设置') : tx('· 未设置')) : "";
    state.className = `state ${hasKey ? "on" : "off"}`;
    sub.textContent = open ? subText : NOT_OPEN;
    entry.hidden = !open || (hasKey && !editing);
    actions.hidden = !open || !hasKey || editing;
    cancel.hidden = !hasKey;
    input.value = "";
  };
  const call = async (run, buttons) => {
    const { endpoint, intakeSecret } = settings();
    buttons.forEach((b) => { b.disabled = true; });
    try { return await run(endpoint, intakeSecret); }
    catch (error) {
      say(error?.http_status === 503 ? 'Mac 的钥匙串暂时不可用，请稍后再试。'
        : error?.code === "invalid_request" ? 'Mac 拒收了这个 key，请检查后重新粘贴。'
        : '没连上 Mac 的收录服务，请确认它在运行。', "bad");
      return null;
    }
    finally { buttons.forEach((b) => { b.disabled = false; }); }
  };
  $("omdb-save").onclick = async () => {
    const value = input.value.trim();
    if (!OMDB_KEY_PATTERN.test(value)) { say('这不像 OMDb key：应为 6 到 64 位字母或数字。', "bad"); return; }
    const done = await call((e, s) => setSecret(e, s, value), [$("omdb-save")]);
    if (!done) return;
    hasKey = done.set;
    show();
    say(hasKey ? '已保存到 Mac。点「测试」确认能用。' : '保存失败，请重试。', hasKey ? "ok" : "bad");
  };
  $("omdb-replace").onclick = () => { show(true); say(""); input.focus(); };
  cancel.onclick = () => { show(); say(""); };
  $("omdb-clear").onclick = async () => {
    const done = await call((e, s) => setSecret(e, s, ""), [$("omdb-clear")]);
    if (!done) return;
    hasKey = done.set;
    show();
    say(hasKey ? '清除失败，请重试。' : '已从 Mac 清除。', hasKey ? "bad" : "");
  };
  $("omdb-test").onclick = async () => {
    say('正在请 Mac 试查一次…');
    const r = await call((e, s) => testSecret(e, s), [$("omdb-test")]);
    if (!r) return;
    if (r.ok && r.rottenTomatoes) say(tx('✓ 测试成功：《肖申克的救赎》（tt0111161）烂番茄 {0}%', r.rottenTomatoes), "ok");
    else if (r.ok || r.code === "no_rating") say(TEST_FAILURES.no_rating, "ok");
    else say(TEST_FAILURES[r.code] || '测试失败。', "bad");
  };
  return {
    async refresh(available) {
      open = available;
      hasKey = false;
      if (open) {
        const status = await call((e, s) => secretStatus(e, s), []);
        if (status) hasKey = status.set; else open = false;
      }
      show();
      if (open) say("");
    }
  };
}

if (globalThis.chrome?.storage?.local) {
  mountOptions(document, {
    local: chrome.storage.local,
    discover: (endpoint, secret) => discoverCapabilities(endpoint, secret),
    extensionOrigin: `chrome-extension://${chrome.runtime.id}`
  });
}
