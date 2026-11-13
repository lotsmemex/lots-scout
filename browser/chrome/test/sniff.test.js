import test from "node:test";
import assert from "node:assert/strict";
import { createProbe, newJob } from "../jobs.js";
import { createRunner } from "../runner.js";
import { classifyCandidates, collectPageLinks, decidePage } from "../sniff.js";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const LIST = "https://ampcode.com/podcast";
const EPISODES = [...Array.from({ length: 10 }, (_, i) => `https://ampcode.com/podcast/episode-${i + 1}`),
  ...Array.from({ length: 7 }, (_, i) => `https://ampcode.com/podcast/season-02/episode-0${i + 1}`)];
// What collectPageLinks reports for a synthetic Amp-like list page.
const listPage = (extra = []) => ({
  pageUrl: LIST, title: "Podcast", ogType: "website", articleCount: 0, articleChars: 0,
  links: [
    { url: "https://ampcode.com/", zone: "chrome", item: false, title: "Amp" },
    { url: "https://ampcode.com/news", zone: "chrome", item: false, title: "News" },
    { url: "https://ampcode.com/manual", zone: "chrome", item: false, title: "Manual" },
    ...EPISODES.map((url, i) => ({ url, zone: "body", item: true, title: `Episode ${i + 1}`, duration: "58:12" })),
    { url: "https://x.com/ampcode", zone: "share", item: false, title: "Share" },
    { url: "https://ampcode.com/podcast.rss", zone: "body", item: false, title: "RSS" },
    { url: "https://ampcode.com/privacy", zone: "chrome", item: false, title: "Privacy" },
    ...extra
  ]
});

test("sniffing preselects the 17 episodes and leaves navigation, footer and share links unchecked", () => {
  const candidates = classifyCandidates(listPage([{ url: "https://ampcode.com/podcast/episode-3#t=10", zone: "body", item: false, title: "dup" }]));
  assert.deepEqual(candidates.filter((c) => c.checked).map((c) => c.url), EPISODES);
  assert(candidates.filter((c) => c.checked).every((c) => c.kind === "podcast"));
  const why = Object.fromEntries(candidates.filter((c) => !c.checked).map((c) => [c.url, c.why]));
  assert.deepEqual(why, { "https://ampcode.com/": "nav", "https://ampcode.com/news": "nav", "https://ampcode.com/manual": "nav",
    "https://x.com/ampcode": "social", "https://ampcode.com/podcast.rss": "not_article", "https://ampcode.com/privacy": "nav" });
  assert.deepEqual(candidates.find((c) => c.url === EPISODES[10]).episode, { season: 2, episode: 1 });
  assert.equal(candidates.find((c) => c.url === EPISODES[0]).duration, "58:12");
});

test("ordinary sites: same-site item links are checked, other sites and loose links are not", () => {
  const candidates = classifyCandidates({ pageUrl: "https://blog.example/", links: [
    { url: "https://blog.example/2026/11/a-post", zone: "body", item: true, title: "A post" },
    { url: "https://www.blog.example/2026/11/b-post", zone: "body", item: true, title: "B post" },
    { url: "https://blog.example/2026/11/inline", zone: "body", item: false, title: "inline" },
    { url: "https://other.example/2026/x", zone: "body", item: true, title: "other" },
    { url: "http://blog.example/2026/11/insecure", zone: "body", item: true, title: "http" },
    { url: "https://blog.example/tags/x", zone: "body", item: true, title: "tag" }
  ] });
  assert.deepEqual(candidates.filter((c) => c.checked).map((c) => c.title), ["A post", "B post"]);
  assert.deepEqual(candidates.filter((c) => !c.checked).map((c) => c.why), ["not_item", "offsite", "not_article"]);
});

test("toolbar click: a list page opens the picker; an episode or long single article is saved directly", () => {
  assert.equal(decidePage(listPage()).mode, "list");
  const episode = { ...listPage(), pageUrl: EPISODES[0], ogType: "website" };
  assert.equal(decidePage(episode).mode, "single");
  assert.equal(decidePage({ pageUrl: "https://blog.example/p/long", articleCount: 1, articleChars: 5000, links: listPage().links }).mode, "single");
  assert.equal(decidePage({ pageUrl: "https://blog.example/p/short", articleCount: 0, articleChars: 0, links: [] }).mode, "single");
});

test("a 200-item page is capped at 200 candidates", () => {
  const links = Array.from({ length: 260 }, (_, i) => ({ url: `https://blog.example/2026/post-${i}`, zone: "body", item: true, title: `P${i}` }));
  assert.equal(classifyCandidates({ pageUrl: "https://blog.example/", links }).length, 200);
});

test("capability probe retries a failed read with backoff and re-reads on demand (focus/visibility)", async () => {
  const timers = []; const results = []; let answers = [false, false, true];
  const probe = createProbe(async () => ({ ok: answers.shift() }), (r) => results.push(r.ok),
    { schedule: (fn, ms) => { timers.push([fn, ms]); return timers.length; }, cancel: () => {}, base: 1000, max: 8000 });
  await probe.run();
  assert.deepEqual(timers.map(([, ms]) => ms), [1000]);
  await timers[0][0]();
  assert.deepEqual(timers.map(([, ms]) => ms), [1000, 2000]);
  await timers[1][0]();
  assert.deepEqual(results, [false, false, true]);
  assert.equal(timers.length, 2);
  answers = [true];
  await probe.run(); // e.g. the popup regained focus
  assert.deepEqual(results, [false, false, true, true]);
});

test("runner: submitted jobs advance in the background; remove drops only finished records and sends nothing", async () => {
  const store = {};
  const local = { get: async (k) => ({ [k]: structuredClone(store[k]) }), set: async (o) => Object.assign(store, structuredClone(o)) };
  const calls = [];
  const transport = { ready: true, podcast: false, destination: true,
    enqueue: async (b) => { calls.push(b); return { schema_version: 1, job_id: `j${calls.length}`, state: "succeeded" }; },
    status: async () => { throw new Error("unexpected"); } };
  const runner = createRunner({ local, connect: async () => ({ ok: true, transport }), schedule: () => 0 });
  const keys = await runner.submit([{ url: "https://ampcode.com/podcast/episode-1", want: { generation: "none", destination: { mode: "inbox" } }, page: LIST }]);
  await runner.kick();
  assert.equal(calls.length, 1);
  assert.equal(store.batchJobs[0].state, "succeeded");
  assert.equal(store.batchJobs[0].page, LIST);
  store.batchJobs.push({ ...newJob("https://ampcode.com/podcast/episode-2", { generation: "none", destination: { mode: "inbox" } }), state: "unconfirmed" });
  await runner.remove(store.batchJobs[1].request_key);
  await runner.remove(keys[0]);
  assert.deepEqual(store.batchJobs.map((j) => j.state), ["unconfirmed"]);
  assert.equal(calls.length, 1);
});

// ---- real ampcode.com pages (saved 2026-11-08, HTML only) ------------------------------------------
const CHROME_BIN = [process.env.CHROME_BIN, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium", "/usr/bin/google-chrome", "/usr/bin/chromium"]
  .find((candidate) => candidate && existsSync(candidate));
const FIXTURE = (name) => new URL(`./fixtures/${name}`, import.meta.url);
const REAL = { list: ["https://ampcode.com/podcast", "ampcode-podcast.html"],
  s2e03: ["https://ampcode.com/podcast/season-02/episode-03", "ampcode-podcast-season-02-episode-03.html"],
  s1e5: ["https://ampcode.com/podcast/episode-5", "ampcode-podcast-episode-5.html"] };
// The 17 episode URLs from the public RSS feed (copied from candidates.json).
const RSS_EPISODES = JSON.parse(readFileSync(FIXTURE("ampcode-podcast-episodes.json"), "utf8")).urls;

// Runs the real collectPageLinks over each saved page in headless Chrome. Comments and scripts are stripped, links
// resolve against a <base> of the original URL, and every host fails to resolve, so nothing is fetched.
async function sniffReal() {
  const root = mkdtempSync(join(tmpdir(), "scout-sniff-real-"));
  const child = spawn(CHROME_BIN, ["--headless=new", "--disable-gpu", "--disable-background-networking", "--no-first-run",
    "--no-default-browser-check", "--use-mock-keychain", "--host-resolver-rules=MAP * ~NOTFOUND", "--blink-settings=imagesEnabled=false",
    "--remote-debugging-pipe", `--user-data-dir=${join(root, "profile")}`, "about:blank"],
  { detached: true, stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  let timer;
  try {
    const [toChrome, fromChrome] = [child.stdio[3], child.stdio[4]];
    let id = 0; let buffer = "";
    const pending = new Map();
    fromChrome.on("data", (chunk) => {
      buffer += chunk;
      for (let end; (end = buffer.indexOf("\0")) >= 0;) {
        const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
        pending.get(message.id)?.(message); pending.delete(message.id);
      }
    });
    const send = (method, params = {}, sessionId) => new Promise((resolve) => {
      id += 1; pending.set(id, resolve);
      toChrome.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + "\0");
    });
    const run = async () => {
      const out = {};
      for (const [key, [url, file]] of Object.entries(REAL)) {
        const html = readFileSync(FIXTURE(file), "utf8").replace(/<!--[\s\S]*?-->/g, "").replace(/<script\b[\s\S]*?<\/script>/gi, "").replace("<head>", `<head><base href="${url}">`);
        const path = join(root, file); writeFileSync(path, html);
        const { targetId } = (await send("Target.createTarget", { url: pathToFileURL(path).href })).result;
        const { sessionId } = (await send("Target.attachToTarget", { targetId, flatten: true })).result;
        for (;;) {
          const value = (await send("Runtime.evaluate", { expression: `location.protocol === "file:" && document.readyState === "complete" ? JSON.stringify((${collectPageLinks})()) : ""`, returnByValue: true }, sessionId)).result?.result?.value;
          if (value) { out[key] = { ...JSON.parse(value), pageUrl: url }; break; }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
      return out;
    };
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("chrome_deadline")), 20_000); });
    return await Promise.race([run(), deadline]);
  } finally {
    clearTimeout(timer);
    try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
    await exited;
    rmSync(root, { recursive: true, force: true });
  }
}

test("real Amp pages: the list page opens the picker with exactly the 17 RSS episodes checked", { skip: !CHROME_BIN }, async (t) => {
  const pages = await sniffReal();
  const byEpisode = (a, b) => RSS_EPISODES.indexOf(a) - RSS_EPISODES.indexOf(b);
  const episodesOf = (list) => list.filter((c) => c.kind === "podcast").map((c) => c.url).sort(byEpisode);

  await t.test("list page", () => {
    const { mode, candidates } = decidePage(pages.list);
    assert.equal(mode, "list");
    const checked = candidates.filter((c) => c.checked);
    assert.equal(checked.length, 17);
    assert.deepEqual(checked.map((c) => c.url).sort(byEpisode), RSS_EPISODES);
    assert(checked.every((c) => c.kind === "podcast" && c.episode && c.title && /^\d{2}:\d{2}:\d{2}$/.test(c.duration)));
    assert.equal(candidates.find((c) => c.url.endsWith("season-02/episode-07")).title, "Culture Stops Slop");
    // Everything else (header, sidebar, footer, YouTube/Spotify/X, RSS) is folded away unchecked.
    const others = candidates.filter((c) => !c.checked);
    assert(others.length >= 20 && others.every((c) => c.why && c.kind === "article"));
    for (const url of ["https://ampcode.com/home", "https://ampcode.com/pricing", "https://ampcode.com/podcast.rss", "https://x.com/ampcode"])
      assert(others.some((c) => c.url === url), url);
  });

  for (const key of ["s2e03", "s1e5"]) {
    await t.test(`episode page ${key}`, () => {
      const page = pages[key];
      const { mode, candidates } = decidePage(page);
      // A toolbar click still saves only this episode...
      assert.equal(mode, "single");
      // ...but the sidebar's full episode list is recognized for "choose other items".
      const checked = candidates.filter((c) => c.checked);
      assert.deepEqual(checked.map((c) => c.url).sort(byEpisode), RSS_EPISODES);
      assert(checked.some((c) => c.url === page.pageUrl));
      assert.equal(checked.filter((c) => c.url !== page.pageUrl).length, 16);
      assert.deepEqual(episodesOf(candidates), RSS_EPISODES);
      assert(candidates.filter((c) => !c.checked).every((c) => c.kind === "article" && c.why));
      // Right-click batch sniff on the same page: the same 17, nothing else checked.
      assert.deepEqual(classifyCandidates(page).filter((c) => c.checked).map((c) => c.url).sort(byEpisode), RSS_EPISODES);
    });
  }
});
