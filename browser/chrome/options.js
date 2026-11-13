import { langPref, localizeDocument, setLangPref, tx } from "./i18n.js";
import { discoverCapabilities, SECRET_PATTERN, SETTING_KEYS, validateEndpoint } from "./capture.js";

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
  // Defaults apply only to features the configured Mac intake advertises.
  const refresh = async () => {
    const capabilities = await deps.discover(saved.endpoint, saved.intakeSecret);
    toggle("default-quality", "quality-sub", "defaultQualityCheck", capabilities.qualityCheck);
    toggle("default-comments", "comments-sub", "defaultComments", capabilities.comments);
  };
  await refresh();
  const lang = $("ui-lang");
  lang.value = langPref();
  lang.addEventListener("change", () => setLangPref(lang.value));
}

if (globalThis.chrome?.storage?.local) {
  mountOptions(document, {
    local: chrome.storage.local,
    discover: (endpoint, secret) => discoverCapabilities(endpoint, secret),
    extensionOrigin: `chrome-extension://${chrome.runtime.id}`
  });
}
