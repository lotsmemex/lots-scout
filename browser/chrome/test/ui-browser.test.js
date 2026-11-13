// The real popup.html / batch.html / progress.html in headless Chrome. The chrome.* API and the intake
// are faked inside the page; the extension files are served from http://ext.test/ by CDP request
// interception and every other request is refused there, so nothing leaves the process.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { newJob } from "../jobs.js";

const CHROME_BIN = [process.env.CHROME_BIN, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium", "/usr/bin/google-chrome", "/usr/bin/chromium"]
  .find((candidate) => candidate && existsSync(candidate));
const ROOT = new URL("../", import.meta.url);
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png" };

// Synthetic folder IDs and pages only.
const id = (c) => `group_${c.repeat(32)}`;
const [MAIN, AMP, S2, DEEP, RO, ZOT, GONE] = ["m", "a", "s", "d", "r", "z", "g"].map(id);
const NODES = [
  { group_id: MAIN, name: "Main", kind: "user", parent_id: null, root_group_id: MAIN, writable: true },
  { group_id: AMP, name: "AmpCode", kind: "collection", parent_id: MAIN, root_group_id: MAIN, writable: true },
  { group_id: S2, name: "Season 2", kind: "collection", parent_id: AMP, root_group_id: MAIN, writable: true },
  { group_id: DEEP, name: "Deep notes", kind: "collection", parent_id: S2, root_group_id: MAIN, writable: true },
  { group_id: RO, name: "Archive", kind: "collection", parent_id: MAIN, root_group_id: MAIN, writable: false },
  { group_id: ZOT, name: "Shared", kind: "zotero_group", parent_id: null, root_group_id: ZOT, writable: false }
];
const ACTIVE = { group_id: AMP, path: ["Main", "AmpCode"], root_group_id: MAIN, writable: true, updated_at: null };
const NO_ACTIVE = { group_id: null, path: [], root_group_id: null, writable: false, updated_at: null };
const ALL = ["url-jobs-v1", "url-jobs-no-generation-v1", "url-jobs-enrich-v1", "url-jobs-destination-v1", "url-jobs-active-group-v1", "url-jobs-group-picker-v1"];
const EPISODES = [...Array.from({ length: 10 }, (_, i) => `https://ampcode.com/podcast/episode-${i + 1}`),
  ...Array.from({ length: 7 }, (_, i) => `https://ampcode.com/podcast/season-02/episode-0${i + 1}`)];
const page = (pageUrl) => ({
  pageUrl, title: pageUrl.endsWith("/podcast") ? "Podcast" : "Culture Stops Slop", ogType: "website", articleCount: 0, articleChars: 0,
  links: [
    ...["https://ampcode.com/", "https://ampcode.com/news", "https://ampcode.com/manual", "https://ampcode.com/privacy"].map((url) => ({ url, zone: "chrome", item: false, title: url })),
    ...EPISODES.map((url, i) => ({ url, zone: "body", item: true, title: `Episode ${i + 1}`, duration: "58:12" })),
    { url: "https://x.com/ampcode", zone: "share", item: false, title: "Share" },
    { url: "https://ampcode.com/podcast.rss", zone: "body", item: false, title: "RSS" }
  ]
});
const LIST = page("https://ampcode.com/podcast");
const EPISODE = page(EPISODES[16]);

const mock = (cfg) => `(() => {
  const cfg = ${JSON.stringify(cfg)};
  localStorage.setItem("memex.lang", "zh");
  const mem = Object.assign({ endpoint: "http://127.0.0.1:3210/api/v1/captures", intakeSecret: "${"b".repeat(64)}" }, cfg.store);
  const listeners = [];
  Object.assign(window, { __mem: mem, __sent: [], __fetch: [], __open: [], __permissions: [] });
  window.fetch = async (url, init) => {
    const route = new URL(String(url)).pathname;
    __fetch.push([route, init && init.body]);
    const json = (body) => new Response(JSON.stringify({ schema_version: 1, ...body }), { status: 200 });
    if (route === "/api/v1/capabilities") return json({ features: cfg.features });
    if (route === "/api/v1/active-group") return json(cfg.active);
    if (route === "/api/v1/groups") {
      if (window.__holdGroups) await new Promise((resolve) => { window.__releaseGroups = resolve; });
      return json({ groups_version: "x", nodes: cfg.nodes });
    }
    return new Response("{}", { status: 404 });
  };
  const get = async (keys) => Object.fromEntries([keys].flat().filter((k) => k in mem).map((k) => [k, structuredClone(mem[k])]));
  window.chrome = {
    runtime: { id: "x", getURL: (p) => "http://ext.test/" + p,
      // cfg.noReply: message types an (old) background has no handler for, so the reply is undefined.
      sendMessage: async (m) => { __sent.push(m); if ((cfg.noReply || []).includes(m.type)) return undefined;
        return m.type === "submit" ? m.items.map((_, i) => "k" + i) : { ok: true }; } },
    tabs: { query: async () => [{ id: 1, windowId: 9, url: cfg.page && cfg.page.pageUrl }], getCurrent: async () => ({ id: 2, windowId: 9 }),
      create: async (o) => { __open.push(["tab", o.url]); } },
    sidePanel: { open: async (o) => { __open.push(["side", o.windowId]); } },
    permissions: { request: async (o) => { __permissions.push(o); return cfg.permission !== false; } },
    scripting: { executeScript: async () => [{ result: cfg.page }] },
    storage: {
      local: { get, set: async (o) => { Object.assign(mem, structuredClone(o));
        const changes = Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { newValue: structuredClone(v) }]));
        listeners.forEach((fn) => fn(changes, "local")); } },
      session: { get: async () => ({ pendingSniff: cfg.pendingSniff || null }), remove: async () => {} },
      onChanged: { addListener: (fn) => listeners.push(fn) }
    }
  };
})();`;

async function withChrome(run) {
  const root = mkdtempSync(join(tmpdir(), "scout-ui-"));
  const child = spawn(CHROME_BIN, ["--headless=new", "--disable-gpu", "--disable-background-networking", "--no-first-run",
    "--no-default-browser-check", "--use-mock-keychain", "--host-resolver-rules=MAP * ~NOTFOUND", "--lang=zh-CN", "--unsafely-treat-insecure-origin-as-secure=http://ext.test",
    "--remote-debugging-pipe", `--user-data-dir=${join(root, "profile")}`, "about:blank"],
  { detached: true, stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  const refused = [];
  let timer;
  try {
    const [toChrome, fromChrome] = [child.stdio[3], child.stdio[4]];
    let seq = 0; let buffer = "";
    const pending = new Map();
    const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
      seq += 1; pending.set(seq, (m) => m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result));
      toChrome.write(JSON.stringify({ id: seq, method, params, ...(sessionId ? { sessionId } : {}) }) + "\0");
    });
    fromChrome.on("data", (chunk) => {
      buffer += chunk;
      for (let end; (end = buffer.indexOf("\0")) >= 0;) {
        const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
        if (message.id) { pending.get(message.id)?.(message); pending.delete(message.id); continue; }
        if (message.method !== "Fetch.requestPaused") continue;
        const { requestId, request } = message.params;
        const url = new URL(request.url);
        if (url.origin === "http://ext.test") {
          const file = url.pathname.slice(1) || "popup.html";
          const path = new URL(file, ROOT);
          if (!existsSync(path)) { send("Fetch.fulfillRequest", { requestId, responseCode: 404 }, message.sessionId); continue; }
          const body = readFileSync(path).toString("base64");
          send("Fetch.fulfillRequest", { requestId, responseCode: 200, body,
            responseHeaders: [{ name: "Content-Type", value: TYPES[extname(file)] || "application/octet-stream" }] }, message.sessionId);
        } else {
          refused.push(request.url);
          send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }, message.sessionId);
        }
      }
    });
    const open = async (path, cfg) => {
      const { targetId } = await send("Target.createTarget", { url: "about:blank" });
      const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
      await send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] }, sessionId);
      await send("Page.enable", {}, sessionId);
      await send("Page.addScriptToEvaluateOnNewDocument", { source: mock(cfg) }, sessionId);
      await send("Page.navigate", { url: `http://ext.test/${path}` }, sessionId);
      const evaluate = async (expression) => {
        const { result, exceptionDetails } = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
        if (exceptionDetails) throw new Error(`${expression}: ${exceptionDetails.exception?.description || exceptionDetails.text}`);
        return result.value;
      };
      const waitFor = async (expression, ms = 5000) => {
        const until = Date.now() + ms;
        for (;;) {
          try { if (await evaluate(expression)) return; } catch { /* page still loading */ }
          if (Date.now() > until) throw new Error(`timeout: ${expression}`);
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      };
      const settle = () => new Promise((resolve) => setTimeout(resolve, 300));
      const click = async (selector) => { await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`); await settle(); };
      // Mounted and probed: the destination summary is filled after the first probe and folder reads.
      await waitFor(path === "progress.html" ? `document.getElementById("filters")?.childElementCount > 0`
        : `window.__fetch?.some(([r]) => r === "/api/v1/capabilities") && document.getElementById("dest-summary")?.textContent !== ""`);
      await settle();
      const screenshot = async (name) => {
        if (!process.env.UI_PROOF_DIR) return;
        await send("Emulation.setDeviceMetricsOverride", { width: 460, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
        const { data } = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }, sessionId);
        writeFileSync(join(process.env.UI_PROOF_DIR, name + ".png"), Buffer.from(data, "base64"));
      };
      return { evaluate, waitFor, click, screenshot,
        colorScheme: (value) => send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value }] }, sessionId),
        close: () => send("Target.closeTarget", { targetId }) };
    };
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("chrome_deadline")), 40_000); });
    return await Promise.race([run(open), deadline]);
  } finally {
    clearTimeout(timer);
    try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
    await exited;
    rmSync(root, { recursive: true, force: true });
    // Only the intake routes were asked, and only of the in-page fake; the network saw nothing else.
    assert.deepEqual(refused, []);
  }
}

const submits = (p) => p.evaluate(`__sent.filter((m) => m.type === "submit")`);
const text = (p, id) => p.evaluate(`document.getElementById(${JSON.stringify(id)}).textContent`);

test("popup and batch page in Chrome: menu, destinations, recent folders, picker", { skip: !CHROME_BIN }, async (t) => {
  await withChrome(async (open) => {
    await t.test("the menu never submits by itself; 收录 1 篇 sends the remembered destination and opens the side panel", async () => {
      const p = await open("popup.html", { page: EPISODE, features: ALL, active: ACTIVE, nodes: NODES, store: { destChoice: "current" } });
      await new Promise((resolve) => setTimeout(resolve, 600));
      assert.deepEqual(await submits(p), []);
      assert.deepEqual(await p.evaluate(`[document.getElementById("menu").hidden, document.getElementById("picker").hidden]`), [false, true]);
      assert.equal(await text(p, "capture-one-page"), "Culture Stops Slop");
      assert.equal(await text(p, "capture-one-note"), "放入 Main / AmpCode");
      assert.equal(await text(p, "sniff-count"), "本页发现 17 条");
      assert.equal(await text(p, "dest-summary"), "当前 Mac 目录：Main / AmpCode");
      assert.equal(await p.evaluate(`document.getElementById("dest-box").open`), false);
      await p.click("#capture-one");
      const [submit] = await submits(p);
      assert.deepEqual(submit.items, [{ url: EPISODE.pageUrl, page: EPISODE.pageUrl, title: "Culture Stops Slop",
        want: { generation: "none", destination: { mode: "group", group_id: AMP, path: ["Main", "AmpCode"] } } }]);
      assert.deepEqual(await p.evaluate("__open"), [["side", 9]]);
      assert.equal(await text(p, "single-text"), "已交给 Mac：这一集放入 Main / AmpCode");
      assert.equal(await p.evaluate(`document.getElementById("change-dest").hidden`), false);
      assert.deepEqual(await p.evaluate("__mem.destHistory"), [{ group_id: AMP, path: ["Main", "AmpCode"] }]);
      // A second click does not resubmit the same page.
      await p.click("#capture-one");
      assert.equal((await submits(p)).length, 1);
      await p.close();
    });

    await t.test("current Mac folder is null: that option is greyed with the reason, and 收录 1 篇 sends nothing (no Inbox fallback)", async () => {
      const p = await open("popup.html", { page: EPISODE, features: ALL, active: NO_ACTIVE, nodes: NODES, store: { destChoice: "current" } });
      assert.equal(await p.evaluate(`document.getElementById("dest-current").disabled`), true);
      assert.equal(await p.evaluate(`document.getElementById("dest-current-row").classList.contains("off")`), true);
      assert.match(await text(p, "dest-current-sub"), /Mac 端没有选中目录/);
      assert.match(await text(p, "dest-summary-why"), /Mac 端没有选中目录/);
      assert.equal(await p.evaluate(`document.getElementById("capture-one").disabled`), true);
      assert.match(await text(p, "capture-one-note"), /当前 Mac 目录不可用：Mac 端没有选中目录/);
      await p.evaluate(`document.getElementById("capture-one").disabled = false`); // even a forced click
      await p.click("#capture-one");
      assert.deepEqual(await submits(p), []);
      assert.deepEqual(await p.evaluate("__open"), []);
      await p.close();
    });

    await t.test("批量嗅探: 全选 selects only the main group; 其他链接 has its own 全选此组; the button names the destination", async () => {
      const p = await open("popup.html", { page: LIST, features: ALL, active: ACTIVE, nodes: NODES, store: { destChoice: "current" } });
      await p.click("#sniff");
      const counts = () => p.evaluate(`[document.querySelectorAll("#candidates input:checked").length, document.querySelectorAll("#others-list input:checked").length, document.querySelectorAll("#others-list input").length]`);
      await p.click("#pick-none");
      assert.deepEqual(await counts(), [0, 0, 6]);
      await p.click("#pick-all");
      assert.deepEqual(await counts(), [17, 0, 6]);
      assert.equal(await text(p, "submit"), "放入 Main / AmpCode · 收录 17 条");
      await p.click("#pick-others");
      assert.deepEqual(await counts(), [17, 6, 6]);
      await p.click("#pick-none");
      assert.deepEqual(await counts(), [0, 0, 6]);
      await p.click("#dest-inbox");
      await p.click("#pick-all");
      assert.equal(await text(p, "submit"), "收进 Inbox · 收录 17 条");
      assert.equal(await p.evaluate("__mem.destChoice"), "inbox");
      assert.deepEqual(await submits(p), []);
      await p.close();
    });

    await t.test("自选目录: deep folders selectable, read-only not; recent folders checked against the list; the choice is shared by every entry", async () => {
      const store = { destChoice: "custom", destCustom: { group_id: DEEP, path: ["old"] },
        destHistory: [{ group_id: DEEP, path: ["Main", "Old name"] }, { group_id: GONE, path: ["Gone"] }, { group_id: RO, path: ["Main", "Archive"] }] };
      const p = await open("popup.html", { page: EPISODE, features: ALL, active: ACTIVE, nodes: NODES, store });
      assert.equal(await p.evaluate(`document.getElementById("dest-custom").checked`), true);
      assert.equal(await text(p, "dest-custom-title"), "自选目录：Main / AmpCode / Season 2 / Deep notes");
      assert.equal(await text(p, "capture-one-note"), "放入 Main / AmpCode / Season 2 / Deep notes");
      assert.deepEqual(await p.evaluate(`[...document.querySelectorAll("#dest-history-list .chip")].map((c) => [c.textContent, c.disabled])`),
        [["Main / AmpCode / Season 2 / Deep notes", false], ["Main / Archive", true]]);
      await p.click("#dest-box > summary");
      await p.click("#dest-choose");
      const tree = await p.evaluate(`[...document.querySelectorAll("#dest-tree li")].map((li) => [li.querySelector(".name").textContent, li.querySelector("input").disabled, li.querySelector("input").checked])`);
      assert.deepEqual(tree, [["Main", false, false], ["AmpCode", false, false], ["Season 2", false, false], ["Deep notes", false, true], ["Archive", true, false], ["Shared", true, false]]);
      await p.click("#dest-tree li:nth-child(2) input");
      assert.deepEqual(await p.evaluate("[__mem.destChoice, __mem.destCustom]"), ["custom", { group_id: AMP, path: ["Main", "AmpCode"] }]);
      assert.equal(await p.evaluate(`document.getElementById("dest-tree").hidden`), true);
      const shared = await p.evaluate("structuredClone(__mem)");
      assert.deepEqual(await submits(p), []);
      await p.close();

      // Right-click "批量嗅探" opens the batch page: same remembered destination.
      const b = await open("batch.html", { pendingSniff: { page: LIST }, features: ALL, active: NO_ACTIVE, nodes: NODES, store: shared });
      assert.equal(await b.evaluate(`document.getElementById("dest-custom").checked`), true);
      assert.equal(await text(b, "dest-summary"), "自选目录：Main / AmpCode");
      assert.equal(await text(b, "submit"), "放入 Main / AmpCode · 收录 17 条");
      await b.click("#submit");
      const [submit] = await submits(b);
      assert.equal(submit.items.length, 17);
      assert.deepEqual(submit.items.map((item) => item.title), EPISODES.map((_, i) => `Episode ${i + 1}`));
      assert(submit.items.every((item) => item.want.destination.mode === "group" && item.want.destination.group_id === AMP));
      assert.deepEqual(await b.evaluate("__open"), [["side", 9]]);
      assert.deepEqual(await b.evaluate("__mem.destHistory.map((h) => h.group_id)"), [AMP, DEEP, GONE, RO]);
      await b.close();
    });

    await t.test("a remembered folder no longer listed is cleared and the user is told", async () => {
      const p = await open("batch.html", { pendingSniff: { page: LIST }, features: ALL, active: ACTIVE, nodes: NODES,
        store: { destChoice: "custom", destCustom: { group_id: GONE, path: ["Main", "Gone"] } } });
      assert.match(await text(p, "dest-custom-sub"), /上次自选的目录「Main \/ Gone」已不在列表里，已清空/);
      assert.equal(await p.evaluate("__mem.destCustom"), null);
      assert.equal(await p.evaluate(`document.getElementById("submit").disabled`), true);
      assert.deepEqual(await submits(p), []);
      await p.close();
    });
  });
});

test("progress page in Chrome: filters, clear done and delete failed are local only, bulk retry", { skip: !CHROME_BIN }, async () => {
  const inbox = { generation: "none", destination: { mode: "inbox" } };
  const folder = { generation: "none", destination: { mode: "group", group_id: AMP, path: ["Main", "AmpCode"] } };
  const mk = (state, extra = {}) => ({ ...newJob(EPISODES[0], extra.folder ? folder : inbox, 1_700_000_000_000, null, extra.title ?? null), state, job_id: `j_${state}`, ...extra });
  const batchJobs = [mk("succeeded", { placement: "unfiled", title: "Culture Stops Slop" }), mk("succeeded", { placement: "selected_group", folder: true }), mk("cancelled"),
    mk("failed", { can_retry: true, reason: "podcast_retry" }), mk("rejected", { reason: "invalid_request" }),
    mk("unknown", { can_retry: true }), mk("unconfirmed", { reason: "permission_denied" }), mk("queued", { can_cancel: true })];
  await withChrome(async (open) => {
    const p = await open("progress.html", { features: ALL, store: { batchJobs } });
    await p.waitFor(`document.querySelectorAll("#jobs li").length === ${batchJobs.length}`);
    assert.deepEqual(await p.evaluate(`[...document.querySelectorAll("#filters button")].map((b) => b.textContent)`),
      ["全部 8", "进行中 2", "失败 2", "需处理 1", "完成 3"]);
    assert.deepEqual(await p.evaluate(`["clear-done", "retry-failed", "delete-failed"].map((id) => document.getElementById(id).textContent)`),
      ["清理已完成（3）", "重试失败（1）", "删除失败项（2）"]);
    // One set of numbers: the filter chips (no second summary line, no folder-ID legend).
    assert.equal(await p.evaluate(`document.getElementById("summary")`), null);
    assert.doesNotMatch(await p.evaluate("document.body.textContent"), /group_|后端|不要重试/);
    const names = await p.evaluate(`[...document.querySelectorAll("#jobs .url")].map((el) => [el.textContent, el.title])`);
    assert.deepEqual(names.at(-1), ["Culture Stops Slop", EPISODES[0]]);
    assert.deepEqual(names.at(-2), ["episode-1", EPISODES[0]]);
    assert.match(await p.evaluate("document.body.textContent"), /放入 Main \/ AmpCode/);
    await p.click(`#filters button[data-filter="failed"]`);
    assert.deepEqual(await p.evaluate(`[...document.querySelectorAll("#jobs li")].map((li) => li.dataset.category)`), ["failed", "failed"]);
    assert.match(await p.evaluate(`document.querySelector("#jobs").textContent`), /Mac 处理这一集时出错，可以重试/);
    assert.doesNotMatch(await p.evaluate(`document.querySelector("#jobs").textContent`), /podcast_retry/);
    assert.equal(await p.evaluate(`document.querySelectorAll("#jobs button.quiet").length`), 0);
    assert.deepEqual(await p.evaluate(`[...document.querySelectorAll("#jobs button")].filter((b) => b.textContent === "重试").map((b) => b.className)`), ["link"]);
    await p.click("#clear-done");
    await p.click("#delete-failed");
    assert.equal(await p.evaluate(`document.getElementById("confirm").hidden`), false);
    assert.deepEqual(await p.evaluate("__sent.filter((m) => m.type !== 'kick')"), [{ type: "prune", kind: "done" }]);
    await p.click("#confirm-ok");
    await p.click("#retry-failed");
    assert.deepEqual(await p.evaluate("__sent.filter((m) => m.type !== 'kick')"), [{ type: "prune", kind: "done" }, { type: "prune", kind: "failed" }, { type: "retryFailed" }]);
    // The page itself never talks to the intake: clearing and deleting are local records only.
    assert.deepEqual(await p.evaluate("__fetch"), []);
    await p.close();
  });
});

test("progress page in Chrome: a retry the background never answers is shown, not swallowed", { skip: !CHROME_BIN }, async () => {
  const inbox = { generation: "none", destination: { mode: "inbox" } };
  const job = { ...newJob(EPISODES[16], inbox, 1_700_000_000_000, null, "Culture Stops Slop"), state: "failed", stage: "commit", job_id: "j1", reason: "podcast_retry", can_retry: true };
  const refused = { ...newJob(EPISODES[15], inbox, 1_700_000_000_000, null, "The Company of the Future"), state: "failed", job_id: "j2", reason: "podcast_retry", can_retry: true,
    last_action: { action: "retry", ok: false, code: "invalid_state", http_status: 409, at: 1_700_000_000_000 } };
  await withChrome(async (open) => {
    const p = await open("progress.html", { features: ALL, store: { batchJobs: [refused, job] }, noReply: ["act", "retryFailed"] });
    await p.waitFor(`document.querySelectorAll("#jobs li").length === 2`);
    const notes = () => p.evaluate(`[...document.querySelectorAll("#jobs li")].map((li) => li.querySelector(".action-note")?.textContent || "")`);
    assert.match((await notes())[1], /^重试未被 Mac 受理（HTTP 409 · invalid_state）/);
    assert.equal((await notes())[0], "");
    await p.click("#jobs li:first-child button.link");
    assert.deepEqual(await p.evaluate("__sent.filter((m) => m.type === 'act')"), [{ type: "act", key: job.request_key, action: "retry" }]);
    assert.match((await notes())[0], /^后台没有回应，重试可能没有发出；请在 chrome:\/\/extensions 重新加载 元芳扩展后再试/);
    await p.click("#retry-failed");
    assert.match(await text(p, "bulk-note"), /后台没有回应，批量重试可能没有发出/);
    assert.deepEqual(await p.evaluate("__fetch"), []);
    await p.close();
  });
});

test("picker in Chrome: rows follow the local job for their URL; failed episodes are retried on their original job", { skip: !CHROME_BIN }, async (t) => {
  const inbox = { generation: "none", destination: { mode: "inbox" } };
  const job = (url, i, extra) => ({ ...newJob(url, inbox, 1_700_000_000_000, null, `Episode ${i + 1}`), job_id: `job_${i}`, ...extra });
  const boxes = (p) => p.evaluate(`[...document.querySelectorAll("#candidates input")].map((b) => [b.checked, b.disabled])`);
  const states = (p) => p.evaluate(`[...document.querySelectorAll("#candidates .state")].map((s) => s.textContent)`);
  await withChrome(async (open) => {
    await t.test("4 succeeded + 13 failed (can_retry): 全选 checks the 13; submit sends 13 retries on the original keys and 0 enqueues", async () => {
      const batchJobs = EPISODES.map((url, i) => i < 4 ? job(url, i, { state: "succeeded", placement: "unfiled" })
        : job(url, i, { state: "failed", stage: "commit", reason: "podcast_retry", can_retry: true }));
      const p = await open("popup.html", { page: EPISODE, features: ALL, active: ACTIVE, nodes: NODES, store: { destChoice: "current", batchJobs } });
      await p.click("#sniff");
      await p.click("#pick-all");
      const after = await boxes(p);
      assert.equal(after.filter(([checked]) => checked).length, 13);
      assert.deepEqual(after.slice(0, 4), [[false, true], [false, true], [false, true], [false, true]]);
      const shown = await states(p);
      assert.deepEqual([shown.filter((s) => s === "已收录").length, shown.filter((s) => s === "上次失败 · 可重试").length], [4, 13]);
      assert.equal(await text(p, "submit"), "收录 13 条（其中重试 13 条）");
      assert.equal(await p.evaluate(`document.getElementById("submit").disabled`), false);
      // The current choice is Main / AmpCode; the retries keep their own destination and say so.
      assert.equal(await text(p, "retry-note"), "重试的 13 集沿用原去向 Inbox");
      assert.equal(await text(p, "pick-why"), "");
      await p.click("#submit");
      const acts = await p.evaluate(`__sent.filter((m) => m.type === "act")`);
      assert.deepEqual(acts, batchJobs.slice(4).map((j) => ({ type: "act", key: j.request_key, action: "retry" })));
      assert.deepEqual(await submits(p), []);
      await p.close();
    });

    await t.test("unknown, needs-you and in-progress rows cannot be checked; 全选 says why instead of doing nothing", async () => {
      const mixed = EPISODES.map((url, i) => job(url, i, { state: ["succeeded", "queued", "leased", "retry_wait", "unknown", "unconfirmed", "rejected"][i % 7],
        can_retry: true, reason: i % 7 === 6 ? "invalid_request" : null }));
      const p = await open("popup.html", { page: EPISODE, features: ALL, active: ACTIVE, nodes: NODES, store: { destChoice: "inbox", batchJobs: mixed } });
      await p.click("#sniff");
      await p.click("#pick-all");
      assert((await boxes(p)).every(([checked, disabled]) => !checked && disabled));
      const shown = await states(p);
      assert.deepEqual(shown.slice(0, 4), ["已收录", "处理中", "处理中", "处理中"]);
      assert.match(shown[4], /结果未知/);
      assert.match(shown[5], /需处理/);
      assert.match(shown[6], /Mac 拒绝了这个链接|提交失败/);
      assert.match(await text(p, "pick-why"), /^没有可勾选的条目：已收录 3 · 处理中 8 · 需处理 6$/);
      assert.equal(await p.evaluate(`document.getElementById("submit").disabled`), true);
      await p.close();

      const settled = EPISODES.map((url, i) => job(url, i, { state: i % 2 ? "succeeded" : "queued" }));
      const q = await open("batch.html", { pendingSniff: { page: LIST }, features: ALL, active: ACTIVE, nodes: NODES, store: { batchJobs: settled } });
      await q.click("#pick-all");
      assert.equal(await text(q, "pick-why"), "17 集都已收录或正在处理");
      assert.deepEqual(await q.evaluate(`__sent.filter((m) => m.type === "submit" || m.type === "act")`), []);
      await q.close();
    });
  });
});

test("progress page in Chrome: 全部再次核对 counts only identity conflicts and sends one bulk message", { skip: !CHROME_BIN }, async () => {
  const folder = { generation: "none", destination: { mode: "group", group_id: AMP, path: ["Main", "AmpCode"] } };
  const mk = (i, extra) => ({ ...newJob(EPISODES[i], folder, 1_700_000_000_000, null, `Episode ${i + 1}`), sends: 1, ...extra });
  const batchJobs = [mk(0, { state: "unconfirmed", reason: "request_identity_conflict" }), mk(1, { state: "unconfirmed", reason: "request_identity_conflict" }),
    mk(2, { state: "unconfirmed", reason: "permission_denied" }), mk(3, { state: "unknown" })];
  await withChrome(async (open) => {
    const p = await open("progress.html", { features: ALL, store: { batchJobs } });
    await p.waitFor(`document.querySelectorAll("#jobs li").length === 4`);
    assert.deepEqual(await p.evaluate(`[document.getElementById("recheck-conflicts").hidden, document.getElementById("recheck-conflicts").textContent]`), [false, "全部再次核对（2）"]);
    await p.click("#recheck-conflicts");
    assert.deepEqual(await p.evaluate("__sent.filter((m) => m.type !== 'kick')"), [{ type: "recheckConflicts" }]);
    assert.deepEqual(await p.evaluate("__fetch"), []);
    await p.close();
    const q = await open("progress.html", { features: ALL, store: { batchJobs: batchJobs.slice(2) } });
    await q.waitFor(`document.querySelectorAll("#jobs li").length === 2`);
    assert.equal(await q.evaluate(`document.getElementById("recheck-conflicts").hidden`), true);
    await q.close();
  });
});

test("picker in Chrome: URLs in the saved index stay 已收录 after 清理已完成 removed their jobs; 全选 skips them", { skip: !CHROME_BIN }, async () => {
  const savedUrls = EPISODES.slice(0, 13).map((url, i) => ({ url, item_id: `item_${i}`, at: 1_700_000_000_000 }));
  await withChrome(async (open) => {
    const p = await open("popup.html", { page: EPISODE, features: ALL, active: ACTIVE, nodes: NODES, store: { destChoice: "inbox", batchJobs: [], savedUrls } });
    await p.click("#sniff");
    await p.click("#pick-none");
    await p.click("#pick-all");
    const rows = await p.evaluate(`[...document.querySelectorAll("#candidates li")].map((li) => [li.querySelector("input").checked, li.querySelector("input").disabled, li.querySelector(".state")?.textContent || ""])`);
    assert.deepEqual(rows.slice(0, 13).map(([c, d, s]) => [c, d, s]), Array(13).fill([false, true, "已收录"]));
    assert.deepEqual(rows.slice(13).map(([c, d]) => [c, d]), Array(4).fill([true, false]));
    assert.equal(await text(p, "submit"), "收进 Inbox · 收录 4 条");
    await p.close();
  });
});

test("popup menu in Chrome: 查看进度 shows the live progress summary", { skip: !CHROME_BIN }, async () => {
  const inbox = { generation: "none", destination: { mode: "inbox" } };
  const mk = (i, state, extra = {}) => ({ ...newJob(EPISODES[i], inbox, 1_700_000_000_000), state, job_id: `j${i}`, ...extra });
  await withChrome(async (open) => {
    const p = await open("popup.html", { page: EPISODE, features: ALL, active: ACTIVE, nodes: NODES,
      store: { batchJobs: [mk(0, "queued"), mk(1, "leased"), mk(2, "succeeded"), mk(3, "unconfirmed", { reason: "request_identity_conflict" })] } });
    const summary = () => p.evaluate(`(() => { const el = document.getElementById("progress-summary"); return [el.textContent, el.hidden, el.classList.contains("busy"), el.classList.contains("attention")]; })()`);
    assert.deepEqual(await summary(), ["进行中 2 · 需处理 1", false, true, true]);
    // Jobs change while the menu is open: the runner finishes everything.
    await p.evaluate(`chrome.storage.local.set({ batchJobs: __mem.batchJobs.map((j) => ({ ...j, state: "succeeded" })) })`);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.deepEqual(await summary(), ["全部完成", false, false, false]);
    await p.evaluate(`chrome.storage.local.set({ batchJobs: [] })`);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal((await summary())[1], true);
    await p.close();
  });
});

test("ordinary snapshot selects a deep folder, discloses excluded options, and shows link provenance", { skip: !CHROME_BIN }, async () => {
  const article = { pageUrl: "https://example.test/blog/models", title: "Which model should you build with?", ogType: "article", articleCount: 1, articleChars: 5000,
    links: [{ url: "https://example.test/blog/cost", zone: "body", item: true, title: "What a task costs", occurrences: [{ role: "learn_more" }, { role: "related" }] },
      { url: "https://other.test/subagents", zone: "body", item: true, title: "When to fold subagents", occurrences: [{ role: "citation" }] }] };
  await withChrome(async (open) => {
    const config = { page: article, features: [...ALL, "web-snapshot-v1"], active: ACTIVE, nodes: NODES,
      store: { destChoice: "custom", destCustom: { group_id: DEEP, path: ["Main", "AmpCode", "Season 2", "Deep notes"] }, defaultComments: true } };
    const p = await open("popup.html", config);
    assert.equal(await p.evaluate(`document.getElementById("capture-one").disabled`), false);
    assert.match(await text(p, "capture-one-note"), /Main \/ AmpCode \/ Season 2 \/ Deep notes.*本次不采评论、不执行 AI 核对/);
    await p.screenshot("web-snapshot-destination");
    await p.click("#capture-one");
    assert.deepEqual(await p.evaluate(`__sent.filter(m => m.type === "capture")`), [{ type: "capture", tabId: 1,
      destination: { mode: "group", group_id: DEEP, path: ["Main", "AmpCode", "Season 2", "Deep notes"] } }]);
    await p.click("#sniff");
    assert.match(await p.evaluate(`document.getElementById("candidates").textContent`), /Learn more \/ Related posts/);
    assert.match(await p.evaluate(`document.querySelector("#candidates .sub").textContent`), /^Learn more \/ Related posts · /);
    assert.match(await p.evaluate(`document.getElementById("candidates").textContent`), /正文引用/);
    assert.equal(await p.evaluate(`document.querySelectorAll("#candidates input")[1].checked`), false);
    await p.screenshot("web-snapshot-references");
    // Pending binary survives reopening the DB; no recapture or changed bytes on retry.
    assert.deepEqual(await p.evaluate(`(async () => {
      const { pendingSnapshot } = await import("./snapshot-queue.js");
      await pendingSnapshot("put", "synthetic", { body: new Blob(["immutable"], { type: "application/vnd.memex.capture-v1" }), missing: 2 });
      const saved = await pendingSnapshot("get", "synthetic");
      await pendingSnapshot("delete", "synthetic");
      return [await saved.body.text(), saved.missing, (await pendingSnapshot("get", "synthetic")) === undefined];
    })()`), ["immutable", 2, true]);
    await p.close();
    const old = await open("popup.html", { ...config, features: ALL });
    assert.equal(await old.evaluate(`document.getElementById("capture-one").disabled`), true);
    assert.match(await text(old, "capture-one-note"), /普通网页目前只能收进 Inbox/);
    assert.deepEqual(await old.evaluate(`__sent.filter(m => m.type === "capture")`), []);
    await old.close();
  });
});

test("reference batch: one-hop scope, selected-origin permission, frozen filing and denial", { skip: !CHROME_BIN }, async () => {
  const article = { pageUrl: "https://claude.dev/blog/synthetic-source/", title: "合成页面：正文引用批量抓取", articleCount: 1, articleChars: 5000,
    links: [
      { url: "https://claude.dev/blog/synthetic-a/", title: "合成引用 A · 成本与能力", zone: "body", item: true,
        occurrences: [{ role: "citation", href: "https://claude.dev/blog/synthetic-a/#cost", heading: "成本", text: "引用 A" }, { role: "learn_more", href: "https://claude.dev/blog/synthetic-a/", text: "Learn more" }] },
      { url: "https://platform.claude.com/docs/synthetic-b", title: "合成引用 B · 站外文档", zone: "body", item: true, occurrences: [{ role: "citation", text: "引用 B" }] },
      { url: "https://claude.dev/blog/synthetic-related/", title: "合成推荐 · 不在正文中", zone: "body", item: true, occurrences: [{ role: "related", text: "Related" }] }
    ] };
  await withChrome(async (open) => {
    const cfg = { page: article, features: [...ALL, "web-snapshot-v1"], active: ACTIVE, nodes: NODES,
      store: { destChoice: "custom", destCustom: { group_id: DEEP, path: ["Main", "AmpCode", "Season 2", "Deep notes"] } } };
    const p = await open("popup.html", cfg);
    await p.click("#sniff");
    assert.equal(await p.evaluate(`document.querySelectorAll("#candidates input").length`), 2);
    await p.click("#pick-all");
    assert.equal(await p.evaluate(`document.querySelectorAll("#candidates input:checked").length`), 2);
    assert.match(await text(p, "submit"), /打开并抓取已选链接.*Deep notes/);
    assert.match(await text(p, "web-navigation-notice"), /浏览器可能先请求重定向和子资源.*不提供 DNS 或私网防护/);
    assert.deepEqual(await p.evaluate("__permissions"), []);
    await p.screenshot("refsniff-selected-light");
    await p.colorScheme("dark");
    assert.equal(await p.evaluate(`matchMedia('(prefers-color-scheme: dark)').matches`), true);
    await p.screenshot("refsniff-selected-dark");
    await p.click("#submit");
    const [submission] = await submits(p);
    assert.deepEqual(submission.items.map((i) => i.url), article.links.slice(0, 2).map((l) => l.url));
    assert(submission.items.every((i) => i.want.web_snapshot === true && i.want.destination.group_id === DEEP));
    assert(submission.items.every((i) => /^[a-f0-9]{64}$/.test(i.want.intake_binding)));
    assert.equal(submission.items[0].occurrences.length, 2);
    assert.deepEqual(await p.evaluate("__permissions"), [{ origins: ["https://claude.dev/*", "https://platform.claude.com/*"] }]);
    assert.match(await text(p, "submitted"), /已冻结 2 条链接.*不展开下一层/);
    await p.screenshot("refsniff-queued-dark");
    await p.close();
    const denied = await open("popup.html", { ...cfg, permission: false });
    await denied.click("#sniff"); await denied.click("#pick-all"); await denied.click("#submit");
    assert.deepEqual(await submits(denied), []);
    assert.match(await text(denied, "single-text"), /没有打开网页或提交任务/);
    await denied.screenshot("refsniff-permission-denied");
    await denied.close();
    const status = await open("progress.html", { features: [...ALL, "web-snapshot-v1"], store: { batchJobs: [{ request_key: "frozen", url: article.links[0].url,
      title: "合成引用 A", want: { web_snapshot: true, destination: { mode: "group", group_id: DEEP, path: ["Main", "Deep notes"] } }, state: "unknown", updated_at: 1, sends: 1 }] } });
    assert.match(await status.evaluate("document.body.textContent"), /快照已提交，结果未知.*再次核对/s);
    assert.deepEqual(await status.evaluate(`Array.from(document.querySelectorAll('#jobs button'), b => b.textContent)`), ["再次核对"]);
    await status.screenshot("refsniff-unknown-original-request");
    await status.close();
    for (const [reason, phrase, screenshot, buttons] of [
      ["browser_visit_in_progress", "在途不可取消", "refsniff-in-progress", ["再次核对"]],
      ["web_redirected", "目标发生重定向", "refsniff-url-changed", []]
    ]) {
      const stopped = await open("progress.html", { features: [...ALL, "web-snapshot-v1"], store: { batchJobs: [{ request_key: "stopped", url: article.links[0].url,
        title: "合成引用 A", want: { web_snapshot: true, destination: { mode: "group", group_id: DEEP, path: ["Main", "Deep notes"] } },
        state: "needs_user", reason, can_cancel: false, can_retry: false, updated_at: 1 }] } });
      assert((await stopped.evaluate("document.body.textContent")).includes(phrase));
      assert.deepEqual(await stopped.evaluate(`Array.from(document.querySelectorAll('#jobs button'), b => b.textContent)`), buttons);
      await stopped.screenshot(screenshot);
      await stopped.close();
    }
    // A new intake's capability reply must never be paired with the old tree.
    const changing = await open("popup.html", cfg);
    await changing.click("#sniff"); await changing.click("#pick-all");
    const oldBinding = await changing.evaluate(`import('./web-batch.js').then(m => m.intakeBinding(__mem))`);
    await changing.evaluate(`__mem.intakeSecret = 'c'.repeat(64); __holdGroups = true; dispatchEvent(new Event('focus'));`);
    await changing.waitFor(`typeof window.__releaseGroups === 'function' && document.getElementById('submit').disabled`);
    assert.match(await text(changing, "held"), /正在读取所选收录入口的目录/);
    // Exercise the handler as well as the disabled button (a stale enabled UI).
    await changing.evaluate(`document.getElementById('submit').disabled = false; document.getElementById('submit').click();`);
    assert.deepEqual(await submits(changing), []);
    assert.deepEqual(await changing.evaluate("__permissions"), []);
    await changing.evaluate(`__holdGroups = false; __releaseGroups();`);
    await changing.waitFor(`!document.getElementById('submit').disabled`);
    await changing.click("#submit");
    const [fresh] = await submits(changing);
    assert.notEqual(fresh.items[0].want.intake_binding, oldBinding);
    assert.equal(fresh.items[0].want.intake_binding, await changing.evaluate(`import('./web-batch.js').then(m => m.intakeBinding(__mem))`));
    await changing.close();
  });
});

test("web fresh-capture action appears only after a zero-result owner audit and archived unknown stays visible", { skip: !CHROME_BIN }, async () => {
  const url = "https://claude.dev/blog/synthetic-chart/";
  const job = { ...newJob(url, { web_snapshot: true, intake_binding: "b".repeat(64),
    destination: { mode: "group", group_id: DEEP, path: ["Main", "Deep notes"] } }, 1),
    state: "unconfirmed", reason: "intake_422", title: "合成图表引用", can_retry: false };
  const verification = { schema_version: 1, request_key: job.request_key, url, intake_binding: job.want.intake_binding,
    group_id: DEEP, observed_updated_at: 1, checked_at: 2, job_sha256: "a".repeat(64), snapshot_sha256: "b".repeat(64),
    queries: { source_url: { method: "local_store_url_index_scan", count: 0 }, target_group: { method: "local_store_membership_scan", count: 0 } } };
  await withChrome(async (open) => {
    const p = await open("progress.html", { store: { batchJobs: [job] } });
    const actions = () => p.evaluate(`Array.from(document.querySelectorAll('#jobs button'), b => b.textContent)`);
    assert.deepEqual(await actions(), ["再次核对"]);
    await p.screenshot("refsniff-manual-restart-unverified");
    const publish = async (value) => {
      await p.evaluate(`chrome.storage.local.set({webSnapshotVerifications: {${JSON.stringify(job.request_key)}: ${JSON.stringify(value)}}})`);
    };
    await publish({ ...verification, queries: { ...verification.queries, source_url: { ...verification.queries.source_url, count: 1 } } });
    await p.waitFor(`!document.querySelector('#jobs').textContent.includes('重新抓取')`);
    assert.deepEqual(await actions(), ["再次核对"]);
    await publish(verification);
    await p.waitFor(`document.querySelector('#jobs').textContent.includes('重新抓取（新请求）')`);
    assert.deepEqual(await actions(), ["重新抓取（新请求）", "再次核对"]);
    await p.screenshot("refsniff-manual-restart-verified");
    await p.click("#jobs button");
    assert.deepEqual(await p.evaluate(`__sent.filter(m => m.type === 'act')`), [{ type: "act", key: job.request_key, action: "retry" }]);
    const replacement = { ...job, request_key: "synthetic-new-key", state: "pending", reason: null };
    const archive = { original_job: job, replacement_job: replacement, verification };
    await p.evaluate(`chrome.storage.local.set({webSnapshotArchives: {${JSON.stringify(job.request_key)}: ${JSON.stringify(archive)}}})`);
    await p.waitFor(`document.querySelector('#jobs').textContent.includes('已人工核定未入库，已另起')`);
    assert.deepEqual(await actions(), []);
    assert.match(await p.evaluate(`document.querySelector('#jobs').textContent`), /结果未确认.*intake_422.*已人工核定未入库，已另起/s);
    assert.deepEqual(await p.evaluate(`__mem.batchJobs`), [job]);
    await p.screenshot("refsniff-manual-restart-archived");
    await p.close();
  });
});

test("protected web failures disable ordinary UI and both real background entry handlers refuse new capture", { skip: !CHROME_BIN }, async () => {
  const url = "https://claude.dev/blog/synthetic-rejected-chart/";
  await withChrome(async open => {
    for (const state of ["failed", "unconfirmed", "needs_user"]) {
      const job = {...newJob(url,{web_snapshot:true,destination:{mode:"group",group_id:DEEP,path:["Main","Deep notes"]}},1),
        state,sends:state === "needs_user" ? 0 : 1,can_cancel:state === "needs_user",
        reason:state === "failed" ? "interactive_control_detected" : state === "needs_user" ? "web_redirected" : "intake_422"};
      const p = await open("popup.html",{features:[...ALL,"web-snapshot-v1"],nodes:NODES,active:ACTIVE,
        page:{pageUrl:url,title:"合成图表拒收页",articleCount:1,articleChars:2000,links:[{url,title:"合成图表拒收页",zone:"body",item:true}]},
        store:{batchJobs:[job],destChoice:"custom",destCustom:{group_id:DEEP,path:["Main","Deep notes"]}}});
      assert.equal(await p.evaluate(`document.getElementById('capture-one').disabled`),true);
      assert.match(await text(p,"capture-one-note"),/保留原网页请求.*普通收录不能另起抓取/);
      await p.evaluate(`document.getElementById('capture-one').disabled=false;document.getElementById('capture-one').click()`);
      assert.deepEqual(await p.evaluate(`__sent.filter(m=>m.type==='capture')`),[]);
      const responses=await p.evaluate(`(async()=>{
        const {intakeBinding}=await import('./web-batch.js');
        __mem.batchJobs[0].want.intake_binding=await intakeBinding(__mem);
        const before=JSON.stringify(__mem.batchJobs);
        chrome.runtime.onMessage={addListener:fn=>window.__handler=fn};
        chrome.runtime.onStartup=chrome.runtime.onInstalled={addListener:()=>{}};
        chrome.contextMenus={onClicked:{addListener:()=>{}}};
        chrome.action={setBadgeText:async()=>{},setBadgeBackgroundColor:async()=>{}};
        chrome.tabs.get=async()=>({url:${JSON.stringify(url)}});
        await import('./background.js');
        const ask=message=>new Promise(resolve=>__handler(message,{id:'x',url:'http://ext.test/popup.html'},resolve));
        const capture=await ask({type:'capture',tabId:1,destination:__mem.batchJobs[0].want.destination});
        const submit=await ask({type:'submit',items:[{url:${JSON.stringify(url)},want:__mem.batchJobs[0].want}]});
        return {capture,submit,unchanged:before===JSON.stringify(__mem.batchJobs)};
      })()`);
      assert.deepEqual(responses,{capture:{ok:false,code:"web_identity_protected"},submit:{ok:false},unchanged:true});
      await p.close();
      const picker=await open("batch.html",{features:[...ALL,"web-snapshot-v1"],nodes:NODES,active:ACTIVE,
        pendingSniff:{explicit:true,page:{links:[{url,title:"合成图表拒收页"}]}},store:{batchJobs:[job]}});
      await picker.click("#pick-all");
      assert.equal(await picker.evaluate(`document.querySelector('#candidates input').disabled`),true);
      assert.deepEqual(await submits(picker),[]);
      await picker.close();
      const status=await open("progress.html",{store:{batchJobs:[job]}});
      const labels=await status.evaluate(`Array.from(document.querySelectorAll('#jobs button'),b=>b.textContent)`);
      assert(!labels.includes("从列表移除"));assert(!labels.includes("重新抓取（新请求）"));
      assert(!labels.includes("取消"));
      assert.equal(await status.evaluate(`document.getElementById('delete-failed').disabled`),true);
      await status.close();
    }
  });
});

test("protected Inbox web identities survive missing capabilities and failed probes without legacy capture or submit", { skip: !CHROME_BIN }, async () => {
  const url="https://claude.dev/blog/synthetic-inbox-refusal/";
  await withChrome(async open => {
    for(const state of ["failed","unconfirmed"]) for(const probe of ["missing","failed"]) {
      const job={...newJob(url,{web_snapshot:true,destination:{mode:"inbox"}},1),state,sends:1,
        reason:state==="failed"?"interactive_control_detected":"intake_422"};
      const p=await open("progress.html",{store:{batchJobs:[job]}});
      const result=await p.evaluate(`(async()=>{
        const {intakeBinding}=await import('./web-batch.js');
        __mem.batchJobs[0].want.intake_binding=await intakeBinding(__mem);
        const before=JSON.stringify(__mem.batchJobs);let reads=0,posts=0;
        window.fetch=async(url,init)=>{if(new URL(url).pathname==='/api/v1/capabilities')return new Response(JSON.stringify({schema_version:1,features:[]}),{status:${probe==="failed"?503:200}});posts++;throw Error('must not POST');};
        chrome.runtime.onMessage={addListener:fn=>window.__handler=fn};
        chrome.runtime.onStartup=chrome.runtime.onInstalled={addListener:()=>{}};
        chrome.contextMenus={onClicked:{addListener:()=>{}}};
        chrome.action={setBadgeText:async()=>{},setBadgeBackgroundColor:async()=>{}};
        chrome.tabs.get=async()=>({url:${JSON.stringify(url)}});
        chrome.scripting.executeScript=async()=>{reads++;throw Error('must not read DOM');};
        Object.defineProperty(window,'indexedDB',{get(){reads++;throw Error('must not construct request');}});
        await import('./background.js');
        const ask=message=>new Promise(resolve=>__handler(message,{id:'x',url:'http://ext.test/progress.html'},resolve));
        const capture=await ask({type:'capture',tabId:1,destination:{mode:'inbox'}});
        const submit=await ask({type:'submit',items:[{url:${JSON.stringify(url)},want:{destination:{mode:'inbox'}}}]});
        return {capture,submit,reads,posts,unchanged:before===JSON.stringify(__mem.batchJobs)};
      })()`);
      assert.deepEqual(result,{capture:{ok:false,code:"web_identity_protected"},submit:{ok:false},reads:0,posts:0,unchanged:true});
      await p.close();
    }
  });
});
