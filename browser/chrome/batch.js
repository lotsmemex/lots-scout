// Full-page item picker, opened from "批量嗅探本页链接" (action or page menu). Progress is in the side panel.
import { tx } from "./i18n.js";
import { mountPanel } from "./panel.js";
import { openProgress } from "./progress.js";
import { connectIntake } from "./runner.js";

if (globalThis.chrome?.storage?.local) {
  const { pendingSniff } = await chrome.storage.session.get("pendingSniff");
  if (pendingSniff) await chrome.storage.session.remove("pendingSniff");
  // Read now, so opening the side panel later can happen inside the click gesture.
  const current = await chrome.tabs.getCurrent();
  const page = pendingSniff?.page || null;
  document.getElementById("source").textContent = page?.title ? tx('来自：{0}', page.title)
    : page ? tx('选中的链接') : tx('在网页上右键（或右键 元芳图标）选「批量嗅探本页链接」即可列出页面上的条目；也可以在下面手动粘贴链接。');
  mountPanel(document, {
    kind: "page", page, explicit: pendingSniff?.explicit === true,
    local: chrome.storage.local,
    connect: () => connectIntake(chrome.storage.local),
    send: (message) => chrome.runtime.sendMessage(message),
    onJobs: (fn) => chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes.batchJobs) fn(changes.batchJobs.newValue);
    }),
    openProgress: () => openProgress(chrome, { windowId: current?.windowId })
  });
}
