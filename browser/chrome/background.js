import { extractArticleSnapshot } from "./extractor.js";
import { revealComments } from "./reveal.js";
import { resolveLang, txIn } from "./i18n.js";
import { buildCapture, discoverCapabilities, postCapture, SECRET_PATTERN, SETTING_KEYS, sha256Hex, validateEndpoint } from "./capture.js";
import { connectIntake, createRunner } from "./runner.js";
import { collectPageLinks } from "./sniff.js";
import { collectImageEvidence } from "./image-capture.js";
import { pendingSnapshot } from "./snapshot-queue.js";
import { createWebCapture, intakeBinding } from "./web-batch.js";
import { validDestination } from "./destination.js";

const MENU_LINK = "scout-capture-link";
const MENU_SNIFF_PAGE = "scout-sniff-page";
const MENU_SNIFF_ACTION = "scout-sniff-action";
const ROSE = "#a8737f";
const KNOWN = new Set(["unsupported_page", "settings_required", "page_changed", "web_feature_missing", "unknown_capture", "web_identity_protected"]);

const badge = async (tabId, text, color, clearAfterMs = 3000) => {
  await chrome.action.setBadgeBackgroundColor({ tabId, color });
  await chrome.action.setBadgeText({ tabId, text });
  if (clearAfterMs) setTimeout(() => chrome.action.setBadgeText({ tabId, text: "" }), clearAfterMs);
};

// Current-tab capture uses the selected folder only when the intake advertises
// web-snapshot-v1. Older intakes keep the legacy Inbox-only contract.
async function captureTab(tabId, destination = { mode: "inbox" }) {
  try {
    if (!tabId) throw new Error("unsupported_page");
    const tab = await chrome.tabs.get(tabId);
    if (!/^https?:\/\//.test(tab.url || "")) throw new Error("unsupported_page");
    const settings = await chrome.storage.local.get(SETTING_KEYS);
    if (!validateEndpoint(settings.endpoint) || !SECRET_PATTERN.test(settings.intakeSecret || "")) {
      await chrome.runtime.openOptionsPage();
      throw new Error("settings_required");
    }
    await badge(tabId, "…", ROSE, 0);
    // New manifest fields are sent only to an intake that advertises them.
    const capabilities = await discoverCapabilities(settings.endpoint, settings.intakeSecret);
    const webSnapshot = capabilities.webSnapshot === true && new URL(tab.url).hostname !== "mp.weixin.qq.com";
    if (!validDestination(destination) || (destination.mode !== "inbox" && !webSnapshot)) throw new Error("web_feature_missing");
    const capture = async () => {
      const includeComments = !webSnapshot && capabilities.comments && settings.defaultComments === true;
      const key = await sha256Hex(new TextEncoder().encode(JSON.stringify([
        settings.endpoint, settings.intakeSecret, tab.url, destination.mode, destination.group_id || null
      ])));
      const pending = await pendingSnapshot("get", key);
      let request = pending;
      if (!request) {
        if (includeComments) {
          await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, func: revealComments });
        }
        const [{ result: snapshot }] = await chrome.scripting.executeScript({
          target: { tabId, frameIds: [0] }, func: extractArticleSnapshot, args: [{ includeComments }]
        });
        if (snapshot.sourceUrl !== tab.url) throw new Error("page_changed");
        const [{ result: evidence }] = webSnapshot && snapshot.imageUrls?.length
          ? await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, func: collectImageEvidence, args: [snapshot.imageUrls] })
          : [{ result: { images: [], missing: 0 } }];
        const { body } = await buildCapture(snapshot, new Date(), {
          comments: includeComments,
          qualityCheck: !webSnapshot && capabilities.qualityCheck && settings.defaultQualityCheck === true ? "configured" : null,
          webSnapshot, targetGroupId: destination.group_id, images: evidence.images
        });
        request = { body, missing: evidence.missing };
        await pendingSnapshot("put", key, request);
      }
      let response;
      try { response = await postCapture(settings.endpoint, settings.intakeSecret, request.body); }
      catch { throw new Error("unknown_capture"); }
      if (!response.ok) {
        if (response.status < 500 && response.status !== 409) await pendingSnapshot("delete", key);
        throw new Error(`intake_${response.status}`);
      }
      // A malformed or lost success receipt is unknown too; keep the immutable request.
      let receipt;
      try { receipt = await response.json(); } catch { throw new Error("unknown_capture"); }
      if (!receipt?.item_id || receipt.schema_version !== 1) throw new Error("unknown_capture");
      await pendingSnapshot("delete", key);
      await badge(tabId, "OK", ROSE);
      return { ok: true, item_id: receipt.item_id, missingImages: request.missing };
    };
    return await runner.captureCurrent(tab.url, { destination, intake_binding: await intakeBinding(settings) }, capture);
  } catch (error) {
    // Deliberately do not log errors: settings, URLs, metadata and intake receipts stay private.
    if (tabId) await badge(tabId, "!", "#b42318");
    const message = String(error?.message || "");
    return { ok: false, code: KNOWN.has(message) || /^intake_\d{3}$/.test(message) ? message : ["invalid_snapshot", "article_not_found"].includes(message) ? "no_article" : "failed" };
  }
}

// The single writer of batch jobs; keeps submitted jobs moving after the popup closes.
const runner = createRunner({ local: chrome.storage.local, connect: () => connectIntake(chrome.storage.local),
  captureWeb: createWebCapture({ api: chrome, local: chrome.storage.local }) });
chrome.runtime.onStartup.addListener(() => runner.kick());

const OWN_PAGES = chrome.runtime.getURL("");
let captureQueue = Promise.resolve();
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  // Only this extension's own popup and pages; injected page functions never message.
  if (sender.id !== chrome.runtime.id || !String(sender.url || "").startsWith(OWN_PAGES)) return false;
  const handle = {
    capture: () => {
      const run = captureQueue.then(() => captureTab(message.tabId, message.destination));
      captureQueue = run.catch(() => {});
      return run;
    },
    submit: () => runner.submit(Array.isArray(message.items) ? message.items : []),
    kick: () => runner.kick(),
    recheck: () => runner.recheck(message.key),
    act: () => runner.act(message.key, message.action === "cancel" ? "cancel" : "retry"),
    retryFailed: () => runner.retryFailed(),
    recheckConflicts: () => runner.recheckConflicts(),
    remove: () => runner.remove(message.key),
    prune: () => runner.prune(message.kind === "failed" ? "failed" : "done")
  }[message?.type];
  if (!handle) return false;
  Promise.resolve().then(handle).then((value) => reply(value ?? { ok: true }), () => reply({ ok: false }));
  return true;
});

// Menu titles follow the language chosen in settings (mirrored to storage as uiLang).
async function buildMenus() {
  const { uiLang } = await chrome.storage.local.get("uiLang");
  const lang = resolveLang(uiLang, chrome.i18n.getUILanguage());
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: MENU_SNIFF_ACTION, title: txIn(lang, "批量嗅探本页链接"), contexts: ["action"] });
    chrome.contextMenus.create({ id: MENU_SNIFF_PAGE, title: txIn(lang, "批量嗅探本页链接"), contexts: ["page", "selection"] });
    chrome.contextMenus.create({
      id: MENU_LINK, title: txIn(lang, "用元芳收录此链接"), contexts: ["link"],
      targetUrlPatterns: ["http://*/*", "https://*/*"]
    });
  });
}
chrome.runtime.onInstalled.addListener(() => { buildMenus(); runner.kick(); });
chrome.storage.onChanged.addListener((changes, area) => { if (area === "local" && changes.uiLang) buildMenus(); });

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  let pendingSniff = { page: null };
  if (info.menuItemId === MENU_LINK && info.linkUrl) {
    pendingSniff = { explicit: true, page: { pageUrl: null, title: "", links: [{ url: info.linkUrl, zone: "body", item: true, title: "" }] } };
  } else if (tab?.id) {
    // The menu click grants activeTab for this tab: read its links once, now.
    try {
      const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, func: collectPageLinks });
      pendingSniff = { page: result };
    } catch { /* No access to this page: open the picker empty, with manual paste. */ }
  }
  await chrome.storage.session.set({ pendingSniff });
  await chrome.tabs.create({ url: chrome.runtime.getURL("batch.html") });
});
