// Resource sniffing for the toolbar click and the "batch sniff" menu. collectPageLinks is injected only
// after an explicit click (activeTab); the rest is pure so it runs in node tests and in the popup.
import { isPodcastEpisode, MAX_BATCH } from "./jobs.js";

// Self-contained (serialized by chrome.scripting). Reads only this page's DOM: link URLs, the text of
// repeated item blocks (cards / list items) that hold them, and whether a link sits in page chrome.
// No cookies, storage, network, clicks or scrolling.
export function collectPageLinks() {
  const CHROME = "nav,header,footer,aside,[role=navigation],[role=banner],[role=contentinfo],[role=complementary]";
  const SHARE = "[class*=share i],[id*=share i],[class*=social i],[aria-label*=share i]";
  const clean = (value) => (value || "").replace(/\s+/g, " ").trim();
  const sig = (el) => `${el.tagName}.${[...el.classList].sort().join(".")}`;
  // The nearest block (the link itself or up to five ancestors) repeated at least three times among its siblings.
  const itemOf = (anchor) => {
    for (let el = anchor, depth = 0; el && el !== document.body && depth < 6; el = el.parentElement, depth += 1) {
      const parent = el.parentElement;
      if (!parent) break;
      const s = sig(el);
      let same = 0;
      for (const child of parent.children) if (sig(child) === s && ++same >= 3) return el;
    }
    return null;
  };
  const durationOf = (item) => {
    const time = item.querySelector("time[datetime^='PT' i]");
    if (time) return clean(time.textContent) || time.getAttribute("datetime");
    return (clean(item.innerText || item.textContent).match(/(?<![\d:])(?:\d{1,2}:)?\d{1,2}:\d{2}(?![\d:])/) || [null])[0];
  };
  // Thumbnail cards carry the title only in the image's alt text.
  const titleOf = (item, anchor) => clean(item?.querySelector("h1,h2,h3,h4,[class*=title i]")?.textContent) ||
    clean(anchor.querySelector("img[alt]")?.getAttribute("alt")) || clean(anchor.textContent);
  const roots = [...document.querySelectorAll("article,[itemprop=articleBody],.prose,.entry-content,.post-content")]
    .filter((node) => !node.closest("nav,footer,aside,form,[contenteditable],#comments,.comments"))
    .sort((a, b) => (b.textContent || "").length - (a.textContent || "").length);
  const article = roots[0];
  const contexts = new Map();
  let heading = null;
  if (article) for (const node of [...article.querySelectorAll("h1,h2,h3,h4,h5,h6,a[href]")].slice(0, 5000)) {
    if (node.closest("form,[contenteditable],#comments,.comments")) continue;
    if (node.localName !== "a") { heading = clean(node.textContent); continue; }
    contexts.set(node, { role: /^learn more/i.test(heading || "") ? "learn_more" : "citation", heading });
  }
  const identity = (value) => {
    const url = new URL(value); url.hash = "";
    for (const key of [...url.searchParams.keys()]) if (/^utm_/i.test(key) || /^(fbclid|gclid|msclkid)$/i.test(key)) url.searchParams.delete(key);
    return url.href;
  };
  const links = new Map();
  const taken = new Set();
  const anchors = document.querySelectorAll("a[href]");
  for (let index = 0; index < anchors.length && index < 5000 && links.size < 600; index += 1) {
    const anchor = anchors[index];
    if (!/^https?:/i.test(anchor.href)) continue;
    const zone = anchor.closest(SHARE) ? "share" : anchor.closest(CHROME) ? "chrome" : "body";
    // `listed`: part of a repeated block, also inside nav/aside (e.g. an "all episodes" sidebar).
    const block = zone === "share" ? null : itemOf(anchor);
    // One main link per item block in the page body: the first one wins.
    const main = zone === "body" && Boolean(block) && !taken.has(block);
    if (main) taken.add(block);
    const item = main || zone === "chrome" ? block : null;
    const title = titleOf(item, anchor).slice(0, 200);
    const duration = item ? durationOf(item) : null;
    const related = anchor.closest("#feed,.related-posts,[aria-label='Related posts']");
    const context = related ? { role: "related", heading: null } : contexts.get(anchor);
    const occurrence = context ? { ...context, href: anchor.href, text: clean(anchor.textContent).slice(0, 4096) } : null;
    let key;
    try { key = identity(anchor.href); } catch { continue; }
    // Sites often render the same list twice (mobile and desktop copies): merge them.
    const known = links.get(key);
    if (known) {
      if (main && !known.item) Object.assign(known, { item: true, zone });
      known.listed ||= Boolean(block);
      if (!known.title) known.title = title;
      if (!known.duration) known.duration = duration;
      if (occurrence) (known.occurrences ||= []).push(occurrence);
      continue;
    }
    links.set(key, { url: key, zone, item: main || Boolean(context), listed: Boolean(block), title, duration,
      ...(occurrence ? { occurrences: [occurrence] } : {}) });
  }
  const articles = [...document.querySelectorAll("article")];
  return {
    pageUrl: location.href, title: clean(document.title).slice(0, 200),
    ogType: document.querySelector("meta[property='og:type']")?.content || null,
    articleCount: articles.length,
    articleChars: Math.max(article ? clean(article.textContent).length : 0, ...articles.map((el) => clean(el.textContent).length)),
    links: [...links.values()]
  };
}

const SOCIAL = /(?:^|\.)(?:twitter\.com|x\.com|facebook\.com|linkedin\.com|instagram\.com|youtube\.com|youtu\.be|github\.com|discord\.gg|discord\.com|t\.me|reddit\.com|threads\.net|bsky\.app|mastodon\.social|weibo\.com|tiktok\.com|bilibili\.com)$/i;
const NOT_ARTICLE = /^\/(?:(?:login|signin|sign-in|signup|sign-up|register|logout|account|settings|search|tags?|categor(?:y|ies)|topics?|authors?|about|contact|privacy|terms|legal|pricing|careers|jobs|feed|rss|sitemap|cart|help|faq)(?:\/|$))/i;
const FILE = /\.(?:xml|rss|atom|json|png|jpe?g|gif|svg|webp|pdf|zip|mp3|m4a|mp4|css|js)$/i;
const host = (name) => name.replace(/^www\./i, "").toLowerCase();
const EPISODE = /\/podcast\/(?:season-(\d{2})\/)?episode-(\d{1,3})$/;
// For Amp episodes the season/episode numbers come from the URL itself.
export const episodeOf = (url) => {
  const match = isPodcastEpisode(url) && url.match(EPISODE);
  return match ? { season: match[1] ? Number(match[1]) : 1, episode: Number(match[2]) } : null;
};

// Candidates in page order. Checked by default: Amp episodes in the body or in a repeated list (the
// site shows its episode list in a <nav> sidebar), and same-site item links in the page body.
// Navigation, footers, share/social, other sites and non-article paths stay listed but unchecked.
// The current page is kept when it is an episode, so an episode page lists the whole season list.
export function classifyCandidates(page, { explicit = false } = {}) {
  let base = null;
  try { base = new URL(page?.pageUrl); base.hash = ""; } catch { /* no page context (manual paste, a link) */ }
  const out = [];
  const seen = new Set();
  for (const link of Array.isArray(page?.links) ? page.links : []) {
    let url;
    try { url = new URL(link?.url); } catch { continue; }
    // The Mac queue admits canonical HTTPS without credentials or fragment.
    if (url.protocol !== "https:" || url.username || url.password) continue;
    url.hash = "";
    const href = url.href;
    const podcast = isPodcastEpisode(href);
    if (seen.has(href) || (base && href === base.href && !explicit && !podcast)) continue;
    seen.add(href);
    let why = null;
    if (!explicit) {
      if (link.zone === "share" || SOCIAL.test(url.hostname)) why = "social";
      // The sidebar marks the current episode with its own classes, so it is not seen as repeated.
      else if (link.zone === "chrome" && !(podcast && (link.listed || href === base?.href))) why = "nav";
      else if (base && host(url.hostname) !== host(base.hostname)) why = "offsite";
      else if (!podcast && (url.search || NOT_ARTICLE.test(url.pathname) || FILE.test(url.pathname) || url.pathname === "/")) why = "not_article";
      else if (!podcast && !link.item) why = "not_item";
    }
    out.push({ url: href, title: typeof link.title === "string" ? link.title : "", duration: typeof link.duration === "string" ? link.duration : null,
      kind: podcast ? "podcast" : "article", episode: episodeOf(href), checked: why === null, why,
      ...(Array.isArray(link.occurrences) ? { occurrences: link.occurrences } : {}) });
    if (out.length >= MAX_BATCH) break;
  }
  return out;
}

// Zotero-style decision for a toolbar click: an episode or a long single article is saved directly,
// a page that lists several items opens the item picker.
export function decidePage(page) {
  const candidates = classifyCandidates(page);
  const items = candidates.filter((candidate) => candidate.checked);
  const single = isPodcastEpisode(String(page?.pageUrl || "").replace(/#.*$/, "")) ||
    (page?.articleCount <= 1 && page?.articleChars >= 1500) || (page?.ogType === "article" && page?.articleCount <= 1);
  return { mode: !single && items.length >= 2 ? "list" : "single", candidates };
}
