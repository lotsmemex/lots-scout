// Toolbar popup: sniff the current tab (activeTab, only now) and show the menu. Nothing is saved until
// the user clicks "收录 1 篇" or picks items after "批量嗅探".
import { mountPanel } from "./panel.js";
import { openProgress } from "./progress.js";
import { connectIntake } from "./runner.js";
import { collectPageLinks } from "./sniff.js";

const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
let page = null;
if (tab?.id && /^https?:\/\//.test(tab.url || "")) {
  try {
    const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, func: collectPageLinks });
    page = result;
  } catch { /* No access to this page: the menu says it cannot be read. */ }
}
mountPanel(document, {
  kind: "popup", page,
  local: chrome.storage.local,
  connect: () => connectIntake(chrome.storage.local),
  send: (message) => chrome.runtime.sendMessage(message),
  captureTab: (destination) => chrome.runtime.sendMessage({ type: "capture", tabId: tab.id, destination }),
  onJobs: (fn) => chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.batchJobs) fn(changes.batchJobs.newValue);
  }),
  openProgress: () => openProgress(chrome, { windowId: tab?.windowId })
});
