// This function is injected only after a toolbar click. Keep it self-contained:
// chrome.scripting serializes it without this module's scope.
// With includeComments it also returns the page's already-loaded comment section as a
// separate, identically sanitized and bounded fragment, kept out of the article HTML.
export function extractArticleSnapshot(options = {}) {
  // Keep this guard inside the serialized function, before ANY document reads.
  if (options?.expectedSourceUrl != null) {
    const identity = (value) => { const u = new URL(value); u.pathname = u.pathname.replace(/\/$/, ""); return u.href; };
    try {
      if (identity(location.href) !== identity(options.expectedSourceUrl)) return { ok: false, code: "page_changed" };
    } catch { return { ok: false, code: "page_changed" }; }
  }
  const MAX_HTML_BYTES = 8 * 1024 * 1024;
  const MAX_TEXT = 4096;
  const MAX_ARTICLE_CANDIDATES = 64;
  const MIN_ARTICLE_TEXT = 200;
  const MAX_CANDIDATE_NODES = 20_000;
  const MAX_TOTAL_NODES = 50_000;
  const MAX_TOTAL_ATTRIBUTES = 100_000;
  const MAX_TOTAL_TEXT_CODE_UNITS = 8 * 1024 * 1024;
  const MAX_TOTAL_SERIALIZED_BYTES = 16 * 1024 * 1024;
  const MAX_COMMENT_BYTES = 2 * 1024 * 1024;
  const MAX_COMMENT_NODES = 20_000;
  const COMMENT_ROOTS = "#comments,#comment-section,#respond,.comments,.comment-list,.commentlist,.comments-area," +
    "[itemprop='comment'],[data-testid*='comment' i],section[id*='comment' i],section[class*='comment' i]," +
    "div[id*='comments' i],ol[class*='comment' i],ul[class*='comment' i]";
  const PROHIBITED = "script,style,noscript,iframe,object,embed,input,textarea,select,button,form,label,[contenteditable]";
  const LABEL_CONTROLS = PROHIBITED + ",datalist,fieldset,option,output,[tabindex],[role='button'],[role='textbox']";
  const clean = (value, limit = MAX_TEXT) => {
    if (typeof value !== "string") return null;
    const result = value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, limit);
    return result || null;
  };
  const webUrl = (value) => {
    if (typeof value !== "string" || !value.trim()) return null;
    try {
      const url = new URL(value, location.href);
      if (!/^https?:$/.test(url.protocol) || url.username || url.password) return null;
      return url.href.slice(0, MAX_TEXT);
    } catch { return null; }
  };
  const meta = (selectors) => {
    for (const selector of selectors) {
      const value = document.querySelector(selector)?.getAttribute("content");
      if (clean(value)) return clean(value);
    }
    return null;
  };
  // Embedded YouTube players become an inert watch link in place, so the video survives sanitizing.
  const videos = [];
  const media = [];
  const youtubeWatchUrl = (frame) => {
    try {
      const url = new URL(frame.getAttribute("src") || "", location.href);
      if (url.protocol !== "https:") return null;
      const host = url.hostname.replace(/^www\./, "");
      const match = /^\/embed\/([A-Za-z0-9_-]{6,20})$/.exec(url.pathname);
      if (!match || !["youtube.com", "youtube-nocookie.com", "m.youtube.com"].includes(host)) return null;
      return `https://www.youtube.com/watch?v=${match[1]}`;
    } catch { return null; }
  };
  const stripActiveAttributes = (node) => {
    for (const attribute of [...node.attributes]) {
      if (/^on/i.test(attribute.name) || attribute.name === "srcdoc") {
        node.removeAttribute(attribute.name);
      }
    }
  };

  const includeComments = options && options.includeComments === true;
  const commentRoots = includeComments ? [...document.querySelectorAll(COMMENT_ROOTS)].filter((node) =>
    !node.closest(PROHIBITED) && !node.parentElement?.closest(COMMENT_ROOTS) &&
    node !== document.body && !node.querySelector("h1,main")) : [];
  const insideComments = (node) => commentRoots.some((root) => root.contains(node));
  const commentRoot = commentRoots.find((node) => (node.textContent || "").trim().length >= 20) || null;
  // Copies a subtree with only inert elements and text; `visit` enforces the caller's bounds.
  const copySanitized = (root, visit) => {
    const clone = root.cloneNode(false);
    stripActiveAttributes(clone);
    let source = root.firstChild;
    let destination = clone;
    const parents = [];
    while (source) {
      visit(source);
      const video = source.nodeType === 1 && source.localName === "iframe" ? youtubeWatchUrl(source) : null;
      if (video) {
        const paragraph = document.createElement("p");
        const anchor = document.createElement("a");
        anchor.href = video;
        anchor.textContent = `YouTube: ${video}`;
        paragraph.append(anchor);
        destination.append(paragraph);
        if (!videos.includes(video)) videos.push(video);
      } else if (source.nodeType === 1 && source.localName === "video") {
        const url = webUrl(source.getAttribute("src") || source.querySelector("source[src]")?.getAttribute("src"));
        const poster = webUrl(source.getAttribute("poster"));
        const figure = source.closest("figure");
        const caption = clean(figure?.querySelector("figcaption")?.textContent) || clean(source.getAttribute("aria-label")) || "Video";
        // Prefer a real source anchor. Never invent an ID that the original site cannot resolve.
        const preceding = [...root.querySelectorAll("h2[id],h3[id],h4[id]")]
          .filter((heading) => heading.compareDocumentPosition(source) & Node.DOCUMENT_POSITION_FOLLOWING).at(-1);
        const id = source.id || figure?.id || preceding?.id;
        const page = webUrl(location.href);
        const target = page ? new URL(id ? `#${encodeURIComponent(id)}` : page, page).href : url;
        if (url && target) {
          const paragraph = document.createElement("p");
          const anchor = document.createElement("a");
          anchor.href = target;
          if (poster) {
            const image = document.createElement("img");
            image.src = poster;
            image.alt = caption;
            anchor.append(image);
          }
          anchor.append(document.createTextNode(`Video: ${caption}`));
          paragraph.append(anchor);
          destination.append(paragraph);
          if (!videos.includes(url)) videos.push(url);
          media.push({ url, poster, caption, sourceUrl: target });
        }
      } else if (source.nodeType === 1 && source !== commentRoot &&
          (!source.matches(PROHIBITED) || (source.localName === "label" &&
            !source.matches("[contenteditable],[tabindex],[role='button'],[role='textbox']") && !source.querySelector(LABEL_CONTROLS)))) {
        // Chart captions can use label[for] without any control. Keep their inert
        // subtree, but never retain label semantics or association attributes.
        const retainedNode = source.localName === "label" ? document.createElement("span") : source.cloneNode(false);
        stripActiveAttributes(retainedNode);
        if (source.localName === "img") {
          const src = webUrl(source.currentSrc || source.getAttribute("data-src") || source.getAttribute("src"));
          if (src) retainedNode.setAttribute("src", src);
          else retainedNode.removeAttribute("src");
          retainedNode.removeAttribute("srcset");
        }
        destination.append(retainedNode);
        if (source.firstChild) {
          parents.push({ source: source.nextSibling, destination });
          source = source.firstChild;
          destination = retainedNode;
          continue;
        }
      } else if (source.nodeType === 3) {
        destination.append(source.cloneNode(false));
      }
      source = source.nextSibling;
      while (!source && parents.length > 0) {
        ({ source, destination } = parents.pop());
      }
    }
    return clone;
  };
  const serialize = (clone) => {
    const output = document.implementation.createHTMLDocument("");
    output.body.append(clone);
    output.title = clean(document.title) || "";
    return "<!doctype html>\n" + output.documentElement.outerHTML;
  };

  // Article elements first; pages without any (e.g. many podcast and docs sites) fall back to the
  // outermost main region. Both paths keep the same sanitizing, bounds and ambiguity checks.
  let candidates = [...document.querySelectorAll("article,[role='article']")].filter((node) => !insideComments(node));
  const mainFallback = candidates.length === 0;
  if (mainFallback) {
    candidates = [...document.querySelectorAll("main,[role='main']")].filter((node) =>
      !insideComments(node) && !node.parentElement?.closest("main,[role='main']"));
  }
  // Common explicit publishing containers (including Claude's #body.prose), not the whole body.
  // The same size, score and ambiguity gates below still apply.
  if (candidates.length === 0) {
    const prose = "[itemprop='articleBody'],.prose,.entry-content,.post-content";
    candidates = [...document.querySelectorAll(prose)].filter((node) =>
      !insideComments(node) && !node.parentElement?.closest(prose));
  }
  if (candidates.length === 0 || candidates.length > MAX_ARTICLE_CANDIDATES) {
    throw new Error("article_not_found");
  }
  const encoder = new TextEncoder();
  let best = null;
  let runnerUpScore = 0;
  let totalNodes = 0;
  let totalAttributes = 0;
  let totalTextCodeUnits = 0;
  let totalSerializedBytes = 0;
  for (const candidate of candidates) {
    if (candidate.closest(PROHIBITED)) continue;
    let candidateNodes = 0;
    const account = (node) => {
      candidateNodes += 1;
      totalNodes += 1;
      if (node.nodeType === 1) {
        totalAttributes += node.attributes.length;
        for (const attribute of node.attributes) {
          totalTextCodeUnits += attribute.name.length + (node.getAttribute(attribute.name) || "").length;
        }
      } else if (node.nodeType === 3) {
        totalTextCodeUnits += node.data.length;
      }
      if (candidateNodes > MAX_CANDIDATE_NODES || totalNodes > MAX_TOTAL_NODES ||
          totalAttributes > MAX_TOTAL_ATTRIBUTES || totalTextCodeUnits > MAX_TOTAL_TEXT_CODE_UNITS) {
        throw new Error("article_not_found");
      }
    };
    account(candidate);
    videos.length = 0;
    media.length = 0;
    let clone = copySanitized(candidate, account);
    if (mainFallback) {
      // The selected main region is this page's article; label it so, like an <article> page.
      const article = document.createElement("article");
      article.append(...clone.childNodes);
      clone = article;
    }
    if (clone.localName !== "article") {
      const article = document.createElement("article");
      article.append(clone);
      clone = article;
    }
    clone.setAttribute("data-memex-snapshot", "1");
    const score = (clone.textContent || "").trim().length;
    const html = serialize(clone);
    const htmlBytes = encoder.encode(html).byteLength;
    totalSerializedBytes += htmlBytes;
    if (totalSerializedBytes > MAX_TOTAL_SERIALIZED_BYTES) throw new Error("article_not_found");
    const imageUrls = [...new Set([...clone.querySelectorAll("img[src]")].map((node) => webUrl(node.getAttribute("src"))).filter(Boolean))];
    const retained = { score, html: htmlBytes <= MAX_HTML_BYTES ? html : null, videos: [...videos], media: [...media], imageUrls, root: candidate };
    if (!best || retained.score > best.score) {
      runnerUpScore = best ? Math.max(runnerUpScore, best.score) : runnerUpScore;
      best = retained;
    } else {
      runnerUpScore = Math.max(runnerUpScore, retained.score);
    }
  }
  if (!best || best.score < MIN_ARTICLE_TEXT || best.html === null ||
      (runnerUpScore > 0 && best.score < runnerUpScore * 2)) {
    throw new Error("article_not_found");
  }

  let comments = null;
  if (includeComments) {
    comments = { state: "none_found", html: null };
    if (commentRoot) {
      let commentNodes = 0;
      try {
        const html = serialize(copySanitized(commentRoot, () => {
          commentNodes += 1;
          if (commentNodes > MAX_COMMENT_NODES) throw new Error("comments_too_large");
        }));
        comments = encoder.encode(html).byteLength <= MAX_COMMENT_BYTES
          ? { state: "captured", html } : { state: "too_large", html: null };
      } catch { comments = { state: "too_large", html: null }; }
    } else if ([...document.querySelectorAll("iframe")].some((frame) =>
      /comment|disqus/i.test(`${frame.id} ${frame.className} ${frame.title} ${frame.getAttribute("src") || ""}`))) {
      comments = { state: "in_frame", html: null };
    }
  }

  const canonical = document.querySelector('link[rel~="canonical" i]')?.getAttribute("href");
  // JSON-LD is parsed as data only (never evaluated); Article/NewsArticle/BlogPosting/PodcastEpisode etc.
  const linked = [];
  for (const script of [...document.querySelectorAll('script[type="application/ld+json" i]')].slice(0, 16)) {
    try {
      const parsed = JSON.parse((script.textContent || "").slice(0, 256 * 1024));
      const queue = Array.isArray(parsed) ? [...parsed] : [parsed];
      while (queue.length && linked.length < 64) {
        const node = queue.shift();
        if (!node || typeof node !== "object") continue;
        linked.push(node);
        if (Array.isArray(node["@graph"])) queue.push(...node["@graph"]);
      }
    } catch { /* malformed JSON-LD is ignored */ }
  }
  const ldNames = (input) => (Array.isArray(input) ? input : [input])
    .map((entry) => (typeof entry === "string" ? entry : entry && typeof entry === "object" ? entry.name : null))
    .map((name) => clean(typeof name === "string" ? name : null, 256)).filter(Boolean);
  // Ignore site/navigation authors and metadata belonging to a different article.
  const articleTypes = /^(?:Article|NewsArticle|BlogPosting|TechArticle|ScholarlyArticle|PodcastEpisode)$/;
  const samePage = (value) => {
    const raw = typeof value === "object" ? value?.["@id"] : value;
    const url = webUrl(raw);
    if (!url) return false;
    const a = new URL(url), b = new URL(webUrl(canonical) || location.href);
    a.hash = ""; b.hash = "";
    return a.href === b.href;
  };
  const articles = linked.filter((node) => (Array.isArray(node["@type"]) ? node["@type"] : [node["@type"]]).some((type) => articleTypes.test(type || "")));
  const matched = articles.filter((node) => samePage(node.mainEntityOfPage) || samePage(node.url) || samePage(node["@id"]));
  const bound = matched.length ? matched : articles.length === 1 && !articles[0].url && !articles[0].mainEntityOfPage ? articles : [];
  const ldFirst = (key) => {
    for (const node of bound) {
      const found = node[key];
      if (typeof found === "string" && clean(found)) return clean(found);
    }
    return null;
  };
  const metaAll = (selector) => [...document.querySelectorAll(selector)]
    .map((node) => clean(node.getAttribute("content"), 256)).filter(Boolean);
  const visibleNames = (selector) => [...document.querySelectorAll(selector)]
    .filter((node) => !node.closest(PROHIBITED) && !insideComments(node))
    .map((node) => clean(node.getAttribute("content") || node.textContent || "", 256)).filter(Boolean);
  const creatorList = [];
  for (const name of [
    ...metaAll('meta[name="citation_author" i], meta[name="dc.creator" i]'),
    ...metaAll('meta[name="author" i], meta[property="article:author" i]').filter((name) => !/^https?:/i.test(name)),
    ...bound.flatMap((node) => ldNames(node.author || node.creator || [])),
    ...visibleNames('[itemprop="author"], [rel="author"]')
  ]) {
    if (creatorList.length >= 32) break;
    if (!creatorList.includes(name)) creatorList.push(name);
  }
  const timeInArticle = (() => {
    const time = best.root.querySelector("time[datetime]:not([itemprop='dateModified'])") || document.querySelector("time[itemprop='datePublished']");
    return clean(time?.getAttribute("datetime"), 64);
  })();
  const publisher = bound.map((node) => node.publisher).find(Boolean);
  const retained = (node) => !node.closest(PROHIBITED) && !insideComments(node);
  const headings = [...best.root.querySelectorAll("h1,h2,h3,h4,h5,h6")].filter(retained).slice(0, 512)
    .map((node, index) => ({ level: Number(node.tagName[1]), id: clean(node.id), text: clean(node.textContent), index }));
  const toc = [];
  for (const anchor of [...document.querySelectorAll("a[href*='#']")].slice(0, 5000)) {
    try {
      const url = new URL(anchor.getAttribute("href"), location.href);
      if (url.origin !== location.origin || url.pathname !== location.pathname || url.search !== location.search) continue;
      const id = decodeURIComponent(url.hash.slice(1));
      if (headings.some((heading) => heading.id === id) && !toc.some((entry) => entry.id === id)) toc.push({ id, text: clean(anchor.textContent) });
    } catch { /* malformed anchor */ }
  }
  const tables = [...best.root.querySelectorAll("table,[role='grid']")].filter(retained).slice(0, 64).map((table) => {
    const rows = [...table.querySelectorAll("tr,[role='row']")];
    const declared = Number(table.getAttribute("aria-rowcount"));
    return { rows: rows.length, columns: Math.max(0, ...rows.map((row) => row.querySelectorAll("th,td,[role='gridcell'],[role='columnheader']").length)),
      partial: table.getAttribute("role") === "grid" || declared > rows.length,
      complex: Boolean(table.querySelector("[rowspan]:not([rowspan='1']),[colspan]:not([colspan='1'])")) };
  });
  const structure = { schema_version: 1, headings, toc, media: best.media.slice(0, 16), tables,
    section: ldFirst("articleSection"), modifiedDate: ldFirst("dateModified") || meta(['meta[property="article:modified_time" i]']) };
  // Inert, digest-bound evidence travels inside the existing HTML artifact, not
  // as executable JSON-LD or a second, unauthenticated metadata channel.
  const evidence = document.createElement("meta");
  evidence.name = "memex:web-structure";
  evidence.content = JSON.stringify(structure);
  best.html = best.html.replace("</head>", `${evidence.outerHTML}</head>`);
  if (encoder.encode(best.html).byteLength > MAX_HTML_BYTES) throw new Error("article_not_found");
  return {
    sourceUrl: webUrl(location.href),
    canonicalUrl: webUrl(canonical),
    title: meta(['meta[property="og:title" i]']) || clean(document.title),
    html: best.html,
    imageUrls: best.imageUrls.slice(0, 128),
    videos: best.videos.slice(0, 16),
    structure,
    metadata: {
      creators: creatorList.length ? creatorList : null,
      // A modified date is not evidence of the original publication date or its timezone.
      publishedDate: meta(['meta[property="article:published_time" i]', 'meta[name="citation_publication_date" i]',
        'meta[name="citation_date" i]', 'meta[name="dc.date" i]', 'meta[name="date" i]', 'meta[itemprop="datePublished" i]']) ||
        ldFirst("datePublished") || timeInArticle,
      language: clean(document.documentElement.lang, 128),
      siteName: meta(['meta[property="og:site_name" i]', 'meta[name="application-name" i]',
        'meta[name="apple-mobile-web-app-title" i]']) || ldNames(publisher || []).at(0) || null,
      abstract: meta(['meta[name="description" i]', 'meta[property="og:description" i]'])
    },
    comments
  };
}
