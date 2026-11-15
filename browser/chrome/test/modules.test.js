// Module boundaries: the progress model and the saved-URL index are runtime-free (no DOM, no chrome.*,
// no network) so another shell, a standalone runtime or a CLI can import them as they are.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (name) => readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
// Code only: line comments are dropped before scanning (they may name what the module avoids).
const code = (src) => src.split("\n").filter((line) => !/^\s*\/\//.test(line)).join("\n");
const importsOf = (src) => [...src.matchAll(/^\s*import\s[^;]*?from\s+"([^"]+)"/gms)].map((m) => m[1]);
const RUNTIME = /\bchrome\.|\bdocument\b|\bwindow\b|\blocalStorage\b|\bnavigator\b|\bfetch\s*\(|postJson|XMLHttpRequest/;

test("progress-model.js imports only i18n.js and touches no DOM, chrome.* or network", () => {
  const src = read("progress-model.js");
  assert.deepEqual(importsOf(src), ["./i18n.js"]);
  assert.doesNotMatch(code(src), RUNTIME);
});

test("saved-index.js has no imports and touches no DOM, chrome.* or network", () => {
  const src = read("saved-index.js");
  assert.deepEqual(importsOf(src), []);
  assert.doesNotMatch(code(src), RUNTIME);
});

test("both modules load and work with no browser globals present", async () => {
  assert.equal(typeof globalThis.chrome, "undefined");
  assert.equal(typeof globalThis.document, "undefined");
  const model = await import("../progress-model.js");
  const index = await import("../saved-index.js");
  const jobs = [{ state: "queued" }, { state: "unconfirmed", reason: "request_identity_conflict", request_key: "k" }, { state: "succeeded" }];
  assert.deepEqual(model.filterCounts(jobs), { all: 3, busy: 1, failed: 0, needs: 1, done: 1 });
  assert.deepEqual(model.progressSummary(jobs), { busy: true, attention: true, text: "进行中 1 · 需处理 1" });
  assert.deepEqual(model.conflictKeys(jobs), ["k"]);
  assert.deepEqual(index.savedIndexAdd([], [{ url: "https://a.example/x#y", item_id: "i", at: 1 }]), [{ url: "https://a.example/x", item_id: "i", at: 1 }]);
  // jobs.js keeps re-exporting the job-state predicates from the model, not its own copies.
  const fromJobs = await import("../jobs.js");
  assert.equal(fromJobs.isTerminal, model.isTerminal);
});

test("the package holds every file its pages and modules load", () => {
  const dir = new URL("../", import.meta.url);
  const files = JSON.parse(readFileSync(new URL("scripts/package.js", dir), "utf8").match(/const files = (\[[\s\S]*?\]);/)[1]);
  const missing = [];
  for (const file of files.filter((f) => /\.(js|html)$/.test(f))) {
    const src = readFileSync(new URL(file, dir), "utf8");
    const refs = file.endsWith(".html")
      ? [...src.matchAll(/(?:src|href)="([^":#?]+\.(?:js|css|html))"/g)].map((m) => m[1])
      : [...src.matchAll(/(?:from|import\()\s*["']\.\/([^"']+)["']/g)].map((m) => m[1]);
    for (const ref of refs) if (!files.includes(ref)) missing.push(`${file} -> ${ref}`);
  }
  assert.deepEqual(missing, []);
});
