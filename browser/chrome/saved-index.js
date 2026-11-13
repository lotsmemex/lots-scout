// The local "already in the library" URL index. Plain data in, plain data out: no DOM, no chrome.*, no
// network, no imports, so a CLI or another runtime can keep the same index in any key-value store.
// Index of URLs known to be in the library, kept apart from the job list so 清理已完成 / 从列表移除
// do not forget them. Each entry is only {url (canonical, no fragment), item_id, at}; no title, no body.
export const SAVED_MAX = 2000;
export function canonicalUrl(url) {
  try { const u = new URL(url); u.hash = ""; return u.href; } catch { return null; }
}
// A job tells us its URL is in the library when it succeeded, or when the Mac's receipt says the item
// already existed (enrichment placement "existing_locations_preserved").
export const savedEntryOf = (job) => (job?.state === "succeeded" || job?.placement === "existing_locations_preserved") && canonicalUrl(job.url)
  ? { url: canonicalUrl(job.url), item_id: typeof job.item_id === "string" ? job.item_id : null, at: Number.isFinite(job.updated_at) ? job.updated_at : 0 } : null;
// Adds entries (newest first, one per URL, at most SAVED_MAX).
export function savedIndexAdd(index, entries) {
  const fresh = entries.map((e) => ({ url: canonicalUrl(e.url), item_id: typeof e.item_id === "string" ? e.item_id : null, at: Number.isFinite(e.at) ? e.at : 0 })).filter((e) => e.url);
  const urls = new Set(fresh.map((e) => e.url));
  const rest = (Array.isArray(index) ? index : []).filter((e) => e && typeof e.url === "string" && !urls.has(e.url))
    .map((e) => ({ url: e.url, item_id: typeof e.item_id === "string" ? e.item_id : null, at: Number.isFinite(e.at) ? e.at : 0 }));
  return [...fresh.reverse(), ...rest].slice(0, SAVED_MAX);
}

