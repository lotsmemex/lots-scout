import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { buildCapture } from "../capture.js";

const chrome = [
  process.env.CHROME_BIN,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].find((candidate) => candidate && existsSync(candidate));

const DEADLINE_MS = 15_000;

// Loads the fixture in headless Chrome and reads its published result over a private CDP pipe
// (--dump-dom never exits in Chrome for Testing 153). Chrome runs in its own process group so
// every exit path, including the deadline, kills exactly that group and nothing else.
async function runFixture(binary, profile, url) {
  const child = spawn(binary, ["--headless=new", "--disable-gpu", "--disable-background-networking", "--no-first-run",
    "--no-default-browser-check", "--use-mock-keychain", "--remote-debugging-pipe", `--user-data-dir=${profile}`, url],
  { detached: true, stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  const killGroup = () => { try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ } };
  let timer;
  try {
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("chrome_deadline")), DEADLINE_MS); });
    const [toChrome, fromChrome] = [child.stdio[3], child.stdio[4]];
    let id = 0; let buffer = "";
    const pending = new Map();
    fromChrome.on("data", (chunk) => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf("\0")) >= 0) {
        const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
        pending.get(message.id)?.(message); pending.delete(message.id);
      }
    });
    const send = (method, params = {}, sessionId) => new Promise((resolve) => {
      id += 1; pending.set(id, resolve);
      toChrome.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + "\0");
    });
    const read = async () => {
      let target;
      while (!target) {
        target = (await send("Target.getTargets")).result.targetInfos.find((info) => info.type === "page" && info.url === url);
        if (!target) await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const { sessionId } = (await send("Target.attachToTarget", { targetId: target.targetId, flatten: true })).result;
      for (;;) {
        const reply = await send("Runtime.evaluate", { expression: "document.documentElement.getAttribute('data-result')", returnByValue: true }, sessionId);
        const value = reply.result?.result?.value;
        if (value) return value;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    };
    return await Promise.race([read(), deadline]);
  } finally {
    clearTimeout(timer);
    killGroup();
    await exited;
  }
}

test("real Chrome sanitizes and bounds article extraction", { skip: !chrome }, async () => {
  const root = mkdtempSync(join(tmpdir(), "scout-extractor-test-"));
  try {
    const extractor = readFileSync(new URL("../extractor.js", import.meta.url), "utf8")
      .replace("export function extractArticleSnapshot", "function extractArticleSnapshot")
      .replace("MAX_CANDIDATE_NODES = 20_000", "MAX_CANDIDATE_NODES = 20")
      .replace("MAX_TOTAL_NODES = 50_000", "MAX_TOTAL_NODES = 50")
      .replace("MAX_TOTAL_ATTRIBUTES = 100_000", "MAX_TOTAL_ATTRIBUTES = 100")
      .replace("MAX_TOTAL_TEXT_CODE_UNITS = 8 * 1024 * 1024", "MAX_TOTAL_TEXT_CODE_UNITS = 4096")
      .replace("MAX_TOTAL_SERIALIZED_BYTES = 16 * 1024 * 1024", "MAX_TOTAL_SERIALIZED_BYTES = 1024")
      .replace("MAX_COMMENT_NODES = 20_000", "MAX_COMMENT_NODES = 30");
    const fixture = `<!doctype html><html><head><title>Fixture article</title></head><body></body><script>
${extractor}
const text = "Harmless retained article text with enough context for deterministic extraction. ".repeat(6);
const attempt = (markup, prepare, options) => {
  document.body.innerHTML = markup;
  if (prepare) prepare();
  try { return { ok: true, value: extractArticleSnapshot(options) }; }
  catch (error) { return { ok: false, code: error.message }; }
};
const normal = attempt(\`<article onclick="bad()"><h1>Fixture</h1><img src="x" onerror="bad()"><form>FORM_SECRET<input value="INPUT_SECRET"></form><p>\${text}</p></article>\`);
const prohibitedRoot = attempt(\`<form role="article"><p>\${text}</p></form>\`);
const editableRoot = attempt(\`<article contenteditable="true"><p>\${text}</p></article>\`);
const prohibitedAncestor = attempt(\`<form><article><p>\${text}</p></article></form>\`);
const editableAncestor = attempt(\`<section contenteditable="true"><article><p>\${text}</p></article></section>\`);
const largeProhibitedDescendant = attempt(\`<article><p>\${text}</p><form id="large-form"></form></article>\`, () => {
  document.querySelector("#large-form").textContent = "FORM_SECRET".repeat(10_000);
});
const removableOnly = attempt(\`<article><form><p>\${text}</p></form><p>tiny</p></article>\`);
const ambiguous = attempt(\`<article><p>\${text}</p></article><article><p>\${text}</p></article>\`);
const oversized = attempt("<article id='oversized'></article>", () => {
  document.querySelector("#oversized").textContent = "x".repeat(4097);
});
const nodeBound = attempt("<article id='nodes'></article>", () => {
  const article = document.querySelector("#nodes");
  for (let index = 0; index < 21; index += 1) article.append(document.createElement("span"));
});
const aggregateBound = attempt("<main id='aggregate'></main>", () => {
  const main = document.querySelector("#aggregate");
  for (let candidate = 0; candidate < 3; candidate += 1) {
    const article = document.createElement("article");
    for (let index = 0; index < 8; index += 1) {
      const span = document.createElement("span"); span.textContent = "x"; article.append(span);
    }
    main.append(article);
  }
});
const comment = "Thoughtful reader comment adding context. ";
const withComments = (markup, prepare) => attempt(markup, prepare, { includeComments: true });
const commentsOutside = withComments(\`<article><p>\${text}</p></article><section id="comments"><p>\${comment}<script>bad()<\\/script><button>REPLY_BUTTON</button></p></section>\`);
const commentsInside = withComments(\`<article><p>\${text}</p><div id="comments"><p>INNER \${comment}</p></div></article>\`);
const commentsInsideOff = attempt(\`<article><p>\${text}</p><div id="comments"><p>INNER \${comment}</p></div></article>\`);
const commentArticles = withComments(\`<article><p>\${text}</p></article><section class="comments"><article><p>\${text}</p></article></section>\`);
const commentArticlesOff = attempt(\`<article><p>\${text}</p></article><section class="comments"><article><p>\${text}</p></article></section>\`);
const commentsFrame = withComments(\`<article><p>\${text}</p></article><iframe id="disqus_thread" src="about:blank"></iframe>\`);
const commentsNone = withComments(\`<article><p>\${text}</p></article>\`);
const commentsLarge = withComments(\`<article><p>\${text}</p></article><section id="comments"><p>\${comment}</p></section>\`, () => {
  const section = document.querySelector("#comments");
  for (let index = 0; index < 40; index += 1) section.append(document.createElement("span"));
});
const noCanonical = attempt(\`<article><p>\${text}</p></article>\`);
const mainOnly = attempt(\`<header><h1>Site</h1></header><main><h1>Episode</h1><iframe src="https://www.youtube-nocookie.com/embed/tEse6n4hEJQ?rel=0"></iframe><iframe src="https://evil.invalid/embed/abcdefgh"></iframe><p>\${text}</p></main><footer>FOOTER_TEXT</footer>\`);
const withMetadata = attempt(\`<meta name="apple-mobile-web-app-title" content="Amp"><meta property="article:modified_time" content="2026-10-30"><script type="application/ld+json">{"@graph":[{"@type":"PodcastEpisode","author":[{"name":"Quinn"},{"name":"Thorsten"}]}]}<\\/script><script type="application/ld+json">not json<\\/script><article><p>\${text}</p></article>\`);
const publishedWins = attempt(\`<meta property="article:modified_time" content="2026-10-30"><article><time datetime="2026-10-28">Oct 28</time><p>\${text}</p></article>\`);
const result = {
  noCanonical: noCanonical.ok && noCanonical.value.canonicalUrl === null,
  withMetadata: withMetadata.ok && JSON.stringify(withMetadata.value.metadata.creators) === JSON.stringify(["Quinn", "Thorsten"])
    && withMetadata.value.metadata.siteName === "Amp" && withMetadata.value.metadata.publishedDate === null
    && !withMetadata.value.html.includes("PodcastEpisode"),
  publishedWins: publishedWins.ok && publishedWins.value.metadata.publishedDate === "2026-10-28",
  mainOnly: mainOnly.ok && mainOnly.value.html.includes("https://www.youtube.com/watch?v=tEse6n4hEJQ")
    && !/iframe|evil\\.invalid|FOOTER_TEXT/.test(mainOnly.value.html)
    && /<article(?: |>|\\s)/.test(mainOnly.value.html) && !mainOnly.value.html.includes("<main")
    && JSON.stringify(mainOnly.value.videos) === JSON.stringify(["https://www.youtube.com/watch?v=tEse6n4hEJQ"]),
  commentsOutside: commentsOutside.ok && commentsOutside.value.comments.state === "captured"
    && commentsOutside.value.comments.html.includes("Thoughtful reader")
    && !/bad\\(\\)|REPLY_BUTTON/.test(commentsOutside.value.comments.html)
    && !commentsOutside.value.html.includes("Thoughtful reader"),
  commentsInside: commentsInside.ok && commentsInside.value.comments.state === "captured"
    && commentsInside.value.comments.html.includes("INNER") && !commentsInside.value.html.includes("INNER"),
  commentsInsideOff: commentsInsideOff.ok && commentsInsideOff.value.comments === null
    && commentsInsideOff.value.html.includes("INNER"),
  commentArticles: commentArticles.ok && commentArticles.value.comments.state === "captured",
  commentArticlesOff: !commentArticlesOff.ok && commentArticlesOff.code === "article_not_found",
  commentsFrame: commentsFrame.ok && commentsFrame.value.comments.state === "in_frame",
  commentsNone: commentsNone.ok && commentsNone.value.comments.state === "none_found",
  commentsLarge: commentsLarge.ok && commentsLarge.value.comments.state === "too_large"
    && commentsLarge.value.comments.html === null,
  normal: normal.ok && normal.value.html.includes("Harmless retained")
    && !/FORM_SECRET|INPUT_SECRET|onclick|onerror/.test(normal.value.html),
  prohibitedRoot: !prohibitedRoot.ok && prohibitedRoot.code === "article_not_found",
  editableRoot: !editableRoot.ok && editableRoot.code === "article_not_found",
  prohibitedAncestor: !prohibitedAncestor.ok && prohibitedAncestor.code === "article_not_found",
  editableAncestor: !editableAncestor.ok && editableAncestor.code === "article_not_found",
  largeProhibitedDescendant: largeProhibitedDescendant.ok
    && !largeProhibitedDescendant.value.html.includes("FORM_SECRET"),
  removableOnly: !removableOnly.ok && removableOnly.code === "article_not_found",
  ambiguous: !ambiguous.ok && ambiguous.code === "article_not_found",
  oversized: !oversized.ok && oversized.code === "article_not_found",
  nodeBound: !nodeBound.ok && nodeBound.code === "article_not_found",
  aggregateBound: !aggregateBound.ok && aggregateBound.code === "article_not_found",
};
document.body.replaceChildren();
document.documentElement.setAttribute("data-result", encodeURIComponent(JSON.stringify(result)));
</script></html>`;
    const fixturePath = join(root, "fixture.html");
    writeFileSync(fixturePath, fixture);
    const encoded = await runFixture(chrome, join(root, "profile"), pathToFileURL(fixturePath).href);
    assert(encoded, "Chrome fixture did not publish a result");
    assert.deepEqual(JSON.parse(decodeURIComponent(encoded)), {
      noCanonical: true,
      mainOnly: true,
      withMetadata: true,
      publishedWins: true,
      commentsOutside: true,
      commentsInside: true,
      commentsInsideOff: true,
      commentArticles: true,
      commentArticlesOff: true,
      commentsFrame: true,
      commentsNone: true,
      commentsLarge: true,
      normal: true,
      prohibitedRoot: true,
      editableRoot: true,
      prohibitedAncestor: true,
      editableAncestor: true,
      largeProhibitedDescendant: true,
      removableOnly: true,
      ambiguous: true,
      oversized: true,
      nodeBound: true,
      aggregateBound: true,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rendered prose preserves outline, native video posters, tables and publication evidence", { skip: !chrome }, async () => {
  const root = mkdtempSync(join(tmpdir(), "scout-structure-test-"));
  try {
    const extractor = readFileSync(new URL("../extractor.js", import.meta.url), "utf8")
      .replace("export function extractArticleSnapshot", "function extractArticleSnapshot");
    const fixture = `<!doctype html><html><head><title>Article</title>
<meta property="article:published_time" content="2026-11-09">
<meta property="article:modified_time" content="2026-11-10T01:00:00-08:00">
<script type="application/ld+json">{"@type":"WebSite","author":{"name":"Not the author"}}<\/script>
<script type="application/ld+json">{"@type":"BlogPosting","author":{"name":"Actual author"},"articleSection":"Playbooks"}<\/script>
</head><body><header>Navigation</header><aside><a href="#deep" style="visibility:hidden">Deep section</a></aside>
<div class="hero"><h1>Article</h1></div><div id="body" class="prose">
<h2 id="start">Start</h2><p>${"Article context with `code` and media. ".repeat(12)}</p>
<h3 id="deep">Deep</h3><h4 id="detail">Detail</h4>
<figure><video src="https://example.test/a.mp4" poster="https://example.test/a.jpg" aria-label="Demo A"></video><figcaption>First demo</figcaption></figure>
<figure><video poster="https://example.test/b.jpg"><source src="https://example.test/b.mp4"></video><figcaption>Second demo</figcaption></figure>
<table><tr><th>A</th><th>B</th><th>C</th></tr><tr><td>1</td><td>2</td><td>3</td></tr></table>
<div role="grid" aria-rowcount="20"><div role="row"><span role="gridcell">Loaded row</span></div></div>
<p>Use <code>agent.run()</code>.</p><pre><code class="language-js">  const x = 1;\n  run(x);</code></pre>
</div><footer><h2>Related posts</h2>Not article</footer><script>
${extractor}
try {
  const s = extractArticleSnapshot();
  document.documentElement.setAttribute('data-result', encodeURIComponent(JSON.stringify(s)));
} catch (e) { document.documentElement.setAttribute('data-result', JSON.stringify({error:e.message})); }
</script></body></html>`;
    const path = join(root, "fixture.html");
    writeFileSync(path, fixture);
    const s = JSON.parse(decodeURIComponent(await runFixture(chrome, join(root, "profile"), pathToFileURL(path).href)));
    assert.equal(s.error, undefined);
    assert.deepEqual(s.metadata.creators, ["Actual author"]);
    assert.equal(s.metadata.publishedDate, "2026-11-09");
    assert.equal(s.structure.section, "Playbooks");
    assert.deepEqual(s.structure.headings.map(({ level, id }) => [level, id]), [[2, "start"], [3, "deep"], [4, "detail"]]);
    assert.equal(s.structure.toc[0].id, "deep");
    assert.deepEqual(s.structure.media.map(({ url, poster, caption }) => [url, poster, caption]), [
      ["https://example.test/a.mp4", "https://example.test/a.jpg", "First demo"],
      ["https://example.test/b.mp4", "https://example.test/b.jpg", "Second demo"]
    ]);
    assert.deepEqual(s.structure.tables.map(({ rows, columns, partial }) => [rows, columns, partial]), [[2, 3, false], [1, 1, true]]);
    assert.match(s.html, /<img[^>]*src="https:\/\/example.test\/a.jpg"/);
    assert.match(s.html, /<code>agent.run\(\)<\/code>/);
    assert.match(s.html, /  const x = 1;\n  run\(x\);/);
    assert.doesNotMatch(s.html, /<video|<source|Not article|Navigation/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("static chart labels become inert spans; labels containing controls are omitted", { skip: !chrome }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "scout-label-test-"));
  try {
    const extractor = readFileSync(new URL("../extractor.js", import.meta.url), "utf8")
      .replace("export function extractArticleSnapshot", "function extractArticleSnapshot");
    // Synthetic structure from two rejected chart articles: plain label[for] siblings.
    // No real article text, identifiers or chart measurements are retained.
    const article = `<article><h1>Synthetic chart</h1><p>${"Synthetic context about chart tradeoffs. ".repeat(12)}</p>
<figure><label for="chart-a">Synthetic axis</label><label for="chart-b"><strong>Synthetic series</strong></label></figure></article>`;
    const path = join(root, "fixture.html");
    writeFileSync(path, `<!doctype html><html><head><title>Synthetic chart</title></head><body>${article}</body><script>
${extractor}
const raw = document.documentElement.outerHTML;
const snapshot = extractArticleSnapshot();
const cases = ['input', 'select', 'textarea', 'button', 'fieldset', 'datalist', 'output', 'object'];
const controlled = cases.map(tag => {
 document.body.innerHTML = ${JSON.stringify(article)};
 const label = document.createElement('label'); label.textContent = 'CONTROL_SENTINEL';
 label.append(document.createElement(tag)); document.querySelector('article').append(label);
 return extractArticleSnapshot().html;
});
document.documentElement.setAttribute('data-result', encodeURIComponent(JSON.stringify({raw,snapshot,controlled})));
</script></html>`);
    const result = JSON.parse(decodeURIComponent(await runFixture(chrome, join(root, "profile"), pathToFileURL(path).href)));
    assert.match(result.snapshot.html, /<span>Synthetic axis<\/span>/);
    assert.match(result.snapshot.html, /<span><strong>Synthetic series<\/strong><\/span>/);
    assert.doesNotMatch(result.snapshot.html, /<label|\bfor=|chart-a|chart-b/);
    for (const html of result.controlled) assert.doesNotMatch(html, /CONTROL_SENTINEL|<label/);
    if (process.env.COLLECT_CLI_BIN) {
      for (const [name, html] of [["before", result.raw], ["after", result.snapshot.html]]) {
        const { body } = await buildCapture({ ...result.snapshot, sourceUrl: "https://synthetic.invalid/chart", html }, new Date(), { webSnapshot: true });
        const binary = join(root, `${name}.bin`);
        writeFileSync(binary, Buffer.from(await body.arrayBuffer()));
        const check = spawnSync(process.env.COLLECT_CLI_BIN, ["web", "collect", "--snapshot", binary, "--library", join(root, "no-library"), "--dry-run"], { encoding: "utf8" });
        if (name === "before") {
          assert.notEqual(check.status, 0);
          assert.match(check.stderr, /interactive_control_detected/);
        } else {
          assert.equal(check.status, 0, check.stderr);
          assert.equal(JSON.parse(check.stdout).admission.class, "article");
        }
        assert.equal(existsSync(join(root, "no-library")), false);
      }
      t.diagnostic("installed admission dry-run rejected the original synthetic label and admitted the inert snapshot without writes");
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a page whose only content container is div.article (Douban subject) is captured with its rating markup", { skip: !chrome }, async () => {
  const root = mkdtempSync(join(tmpdir(), "scout-douban-test-"));
  try {
    const extractor = readFileSync(new URL("../extractor.js", import.meta.url), "utf8")
      .replace("export function extractArticleSnapshot", "function extractArticleSnapshot");
    const fixture = `<!doctype html><html><head><title>花样年华 (豆瓣)</title></head><body>
<div id="db-nav-movie">导航</div><div id="content"><h1>花样年华 (2000)</h1><div class="grid-16-8 clearfix">
<div class="article"><div id="info">导演: 王家卫</div>
<div id="interest_sectl"><strong class="ll rating_num" property="v:average">8.8</strong>
<span property="v:best" content="10.0"></span><a><span property="v:votes">827934</span>人评价</a></div>
<div class="related-info"><span property="v:summary">${"一九六二年的香港，周慕云与苏丽珍成为邻居。".repeat(12)}</span></div></div>
<div class="aside">推荐</div></div></div><script>
${extractor}
try {
  const s = extractArticleSnapshot();
  document.documentElement.setAttribute('data-result', encodeURIComponent(JSON.stringify(s)));
} catch (e) { document.documentElement.setAttribute('data-result', encodeURIComponent(JSON.stringify({error:e.message}))); }
</script></body></html>`;
    const path = join(root, "fixture.html");
    writeFileSync(path, fixture);
    const s = JSON.parse(decodeURIComponent(await runFixture(chrome, join(root, "profile"), pathToFileURL(path).href)));
    assert.equal(s.error, undefined);
    assert.match(s.html, /property="v:average"[^>]*>8\.8</);
    assert.match(s.html, /property="v:votes"[^>]*>827934</);
    assert.match(s.html, /property="v:best" content="10\.0"/);
    assert.doesNotMatch(s.html, /导航|推荐/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
