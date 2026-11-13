// Injected only after an explicit click with "include comments" on. Self-contained (serialized by
// chrome.scripting). Many sites load comments lazily when the reader scrolls near them, so this
// scrolls toward the comment section in uneven steps with short pauses, as a reader would, waits
// briefly for the page to settle, then restores the reader's scroll position. It never clicks,
// types, opens tabs or reads anything; the extractor runs afterwards. Bounded to about 5 seconds.
export async function revealComments() {
  const ROOTS = "#comments,#comment-section,#respond,.comments,.comment-list,.commentlist,.comments-area," +
    "[itemprop='comment'],[data-testid*='comment' i],section[id*='comment' i],section[class*='comment' i]," +
    "div[id*='comments' i],ol[class*='comment' i],ul[class*='comment' i]";
  const SCROLL_BUDGET_MS = 3500;
  const SETTLE_QUIET_MS = 600;
  const SETTLE_BUDGET_MS = 1500;
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const between = (low, high) => low + Math.random() * (high - low);
  const startX = window.scrollX;
  const startY = window.scrollY;
  let lastMutation = performance.now();
  const observer = new MutationObserver(() => { lastMutation = performance.now(); });
  observer.observe(document.body, { childList: true, subtree: true });
  try {
    const scrollDeadline = performance.now() + SCROLL_BUDGET_MS;
    while (performance.now() < scrollDeadline) {
      const target = document.querySelector(ROOTS);
      const goal = target
        ? target.getBoundingClientRect().top + window.scrollY - window.innerHeight * 0.3
        : document.documentElement.scrollHeight - window.innerHeight;
      const remaining = goal - window.scrollY;
      if (remaining <= 4) break;
      window.scrollTo(window.scrollX, window.scrollY + Math.min(remaining, window.innerHeight * between(0.45, 0.9)));
      await pause(between(220, 650));
    }
    const settleDeadline = performance.now() + SETTLE_BUDGET_MS;
    while (performance.now() < settleDeadline && performance.now() - lastMutation < SETTLE_QUIET_MS) {
      await pause(120);
    }
    return { found: Boolean(document.querySelector(ROOTS)) };
  } finally {
    observer.disconnect();
    window.scrollTo(startX, startY);
  }
}
