import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync, utimesSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const zip = path.join(dist, "lots-scout-chrome-mv3.zip");
const files = ["LICENSE", "README.md", "background.js", "batch.html", "batch.js", "capture.js", "destination.js", "extractor.js", "image-capture.js", "snapshot-queue.js", "web-batch.js", "i18n.js", "jobs.js", "manifest.json",
  "options.html", "options.js", "panel.js", "popup.html", "popup.js", "progress.html", "progress.js", "progress-model.js", "reveal.js", "saved-index.js", "runner.js", "sniff.js", "ui.css", "icons/icon-16.png", "icons/icon-32.png", "icons/icon-48.png", "icons/icon-128.png",
  "_locales/en/messages.json", "_locales/zh_CN/messages.json", "_locales/zh_TW/messages.json"];
rmSync(dist, { recursive: true, force: true });
const stage = path.join(dist, "stage");
mkdirSync(stage, { recursive: true });
const epoch = new Date("2000-01-01T00:00:00Z");
for (const file of files) {
  mkdirSync(path.dirname(path.join(stage, file)), { recursive: true });
  copyFileSync(path.join(root, file), path.join(stage, file));
  utimesSync(path.join(stage, file), epoch, epoch);
}
execFileSync("zip", ["-X", "-q", zip, ...files], { cwd: stage, env: { ...process.env, TZ: "UTC" } });
rmSync(stage, { recursive: true, force: true });
console.log(path.relative(root, zip));
