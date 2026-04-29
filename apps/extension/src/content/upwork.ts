import { detectPageKind, SELECTORS } from "@/lib/selectors";
import { parseCardListPage } from "@/parsers/job-search";
import { parseCategoryFeedPage } from "@/parsers/category-feed";
import { parseDetailPage } from "@/parsers/job-detail";
import { applyFilters, decodePayload } from "./apply-filters";
import { takePendingApplyFilters } from "@/lib/storage";
import type { UpworkJobItem, CrawlFailReason } from "@research-bot/shared";

/// Upwork capture. Runs on every upwork.com page load. Two flavors:
///   - Passive: user browses normally, items get scraped + sent to the SW.
///   - Crawler-driven: the SW navigates a managed tab to a URL, this script
///     scrapes, optionally scrolls to load more tiles on list pages, then
///     emits a final `crawl:status` so the SW can mark the CrawlJob done/fail.
///     The SW correlates by sender.tab.id.

const PARSED_FOR_HREF = new Set<string>();

/// Hard caps for the crawler-driven scroll-to-load loop on list pages.
const SCROLL_MAX_ITERATIONS = 8;       // ≈ 8 viewports of additional tiles
const SCROLL_DELAY_MIN_MS = 1500;
const SCROLL_DELAY_MAX_MS = 3500;
const SCROLL_STALL_LIMIT = 2;          // give up after N scrolls with no growth

void main();

async function main(): Promise<void> {
  const kind = detectPageKind(window.location.pathname);

  const settings = await chrome.storage.sync.get({ enabled: true, capture: {} });

  // Bot-protection check runs even on unknown page kinds — login redirects
  // commonly land on /ab/account-security/login which is otherwise ignored.
  const botSignal = detectBotSignal(document, window.location.href);
  if (botSignal) {
    sendCrawlStatus({ ok: false, reason: botSignal.reason, error: botSignal.detail });
    return;
  }

  // Apply-filters dispatch: if the SW stashed a pending filter task targeting
  // the URL we just landed on, run the click driver instead of the scrape
  // flow. Tighter guards than scraping needs (URL match + recency) so a stale
  // task can't ambush a passive browse session.
  const PENDING_MAX_AGE_MS = 5 * 60_000;
  const managedAtStart = await askIfManaged();
  const pending = await takePendingApplyFilters();
  const pendingFresh = pending && Date.now() - pending.writtenAt < PENDING_MAX_AGE_MS;
  const pendingMatches = pending && urlMatches(pending.url, window.location.href);
  if (pending && pendingFresh && pendingMatches) {
    console.log(
      `[research-bot] apply-filters dispatch: jobId=${pending.jobId.slice(0, 8)} managed=${managedAtStart}`,
    );
    const payload = decodePayload(pending.payloadJson);
    if (!payload) {
      console.warn("[research-bot] apply-filters: payload decode failed");
      sendCrawlStatus({
        ok: false,
        reason: "other",
        error: "apply-filters payload could not be decoded",
      });
      return;
    }
    // Wait for the page to settle so the Filters button is mountable.
    await waitForContainer("body");
    await waitForReactSettle();
    console.log(`[research-bot] apply-filters: running recipe "${payload.recipe}"…`);
    const result = await applyFilters(payload.spec);
    if (result.ok) {
      console.log(
        `[research-bot] apply-filters: OK — applied`,
        result.appliedSections,
      );
      sendCrawlStatus({ ok: true, externalIds: [], itemsCaptured: 0 });
    } else {
      console.warn(
        `[research-bot] apply-filters: FAIL reason=${result.reason} error=${result.error}`,
      );
      sendCrawlStatus({ ok: false, reason: result.reason, error: result.error });
    }
    return;
  } else if (pending) {
    if (!pendingFresh) {
      console.log(
        `[research-bot] discarding stale apply-filters task (age=${Math.round((Date.now() - pending.writtenAt) / 1000)}s)`,
      );
    } else {
      // URL didn't match — put it back for the right page.
      await chrome.storage.local.set({ pendingApplyFilters: pending });
    }
  }

  if (!kind) return;
  if (!settings.enabled) return;
  if (settings.capture && settings.capture[kind] === false) return;

  const containerFound = await waitForContainer(SELECTORS[kind].pageReady);
  await waitForReactSettle();

  // Initial scrape — sends items immediately for live feedback.
  const seenExternalIds = new Set<string>();
  const initial = scrapeAndSend(kind, seenExternalIds);
  initial.forEach((it) => seenExternalIds.add(it.externalId));

  if (!containerFound && seenExternalIds.size === 0) {
    sendCrawlStatus({
      ok: false,
      reason: "selector_drift",
      error: `pageReady selector ${SELECTORS[kind].pageReady} never matched`,
    });
    return;
  }

  // If we're being driven by the crawler AND we're on a list page, scroll
  // through the infinite-scroll feed to capture tiles below the fold. We do
  // NOT do this in passive mode — that'd hijack the user's scroll position.
  const isList = kind === "job-search" || kind === "category-feed";
  if (managedAtStart && isList) {
    await scrollToLoadMore(kind, seenExternalIds);
  }

  sendCrawlStatus({
    ok: true,
    externalIds: Array.from(seenExternalIds),
    itemsCaptured: seenExternalIds.size,
  });

  // Keep watching for SPA navigation so passive users still get re-scraped
  // (the crawler navigates whole new tabs, so passive-only here).
  const observer = new MutationObserver(() => {
    if (!PARSED_FOR_HREF.has(window.location.href + ":" + getResultCount())) {
      scrapeAndSend(detectPageKind(window.location.pathname) ?? kind, seenExternalIds);
    }
  });
  observer.observe(document.body, { subtree: true, childList: true });
}

function scrapeAndSend(
  kind: ReturnType<typeof detectPageKind>,
  seen: Set<string>,
): UpworkJobItem[] {
  if (!kind) return [];
  const dedupKey = window.location.href + ":" + getResultCount();
  if (PARSED_FOR_HREF.has(dedupKey)) return [];

  let items: UpworkJobItem[] = [];
  if (kind === "job-detail") {
    const item = parseDetailPage(document, window.location.href);
    if (item) items = [item];
  } else if (kind === "job-search") {
    items = parseCardListPage(document, "job-search");
  } else if (kind === "category-feed") {
    items = parseCategoryFeedPage(document);
  }

  // Deduplicate against externalIds we've already shipped on this page so
  // the scroll loop doesn't re-send tiles that were visible from the start.
  const fresh = items.filter((it) => !seen.has(it.externalId));
  if (fresh.length === 0) return [];

  PARSED_FOR_HREF.add(dedupKey);
  chrome.runtime.sendMessage({ type: "upwork:items", items: fresh }).catch(() => {});
  return fresh;
}

/// Scroll the page in viewport-sized increments, waiting between each scroll
/// for new tiles to render. Stops when the tile count stops growing or after
/// SCROLL_MAX_ITERATIONS, whichever first.
async function scrollToLoadMore(
  kind: "job-search" | "category-feed",
  seen: Set<string>,
): Promise<void> {
  const itemSel = SELECTORS[kind].itemList;
  if (!itemSel) return;

  let stalls = 0;
  for (let i = 0; i < SCROLL_MAX_ITERATIONS; i += 1) {
    const before = document.querySelectorAll(itemSel).length;
    window.scrollBy({ top: window.innerHeight * 0.9, behavior: "auto" });
    await sleep(jitter(SCROLL_DELAY_MIN_MS, SCROLL_DELAY_MAX_MS));

    const after = document.querySelectorAll(itemSel).length;
    if (after <= before) {
      stalls += 1;
      if (stalls >= SCROLL_STALL_LIMIT) break;
      continue;
    }
    stalls = 0;

    const fresh = scrapeAndSend(kind, seen);
    fresh.forEach((it) => seen.add(it.externalId));
  }
}

async function askIfManaged(): Promise<boolean> {
  try {
    const reply = (await chrome.runtime.sendMessage({ type: "crawl:am-i-managed" })) as
      | { managed?: boolean }
      | undefined;
    return reply?.managed === true;
  } catch {
    return false;
  }
}

/// Compare two URLs for the apply-filters dispatch decision: same origin +
/// same pathname is enough. Query / hash differences are tolerated since
/// Upwork sometimes appends tracking params on navigation.
function urlMatches(expected: string, actual: string): boolean {
  try {
    const a = new URL(expected);
    const b = new URL(actual);
    return a.origin === b.origin && a.pathname === b.pathname;
  } catch {
    return expected === actual;
  }
}

function sendCrawlStatus(
  body:
    | { ok: true; externalIds: string[]; itemsCaptured: number }
    | { ok: false; reason: CrawlFailReason; error?: string },
): void {
  chrome.runtime.sendMessage({ type: "crawl:status", ...body }).catch(() => {});
}

/// Returns null if the page looks normal, or a reason + detail if Upwork's
/// anti-bot defenses or login wall appear to have intercepted the navigation.
///
/// Heuristic, in order of reliability:
///   1. URL-based login-wall redirect — strongest signal, can't false-positive.
///   2. Known CAPTCHA iframe / element selectors — very strong signal.
///   3. Visible-text matching, ONLY when normal page content also failed to
///      render. Earlier we'd scan `textContent` (which includes <script>
///      source + hidden DOM) and tripped on stray phrases on healthy pages.
function detectBotSignal(
  doc: Document,
  href: string,
): { reason: CrawlFailReason; detail: string } | null {
  const url = (() => {
    try {
      return new URL(href);
    } catch {
      return null;
    }
  })();
  if (url && /\/ab\/account-security\/login|\/login|\/freelancers\/login/i.test(url.pathname)) {
    return { reason: "login_redirect", detail: `redirected to ${url.pathname}` };
  }

  const captchaSelectors = [
    "iframe[src*='captcha']",
    "iframe[src*='hcaptcha']",
    "iframe[src*='recaptcha']",
    "iframe[src*='px-captcha']",
    "iframe[title*='captcha' i]",
    "[id*='px-captcha']",
  ];
  for (const s of captchaSelectors) {
    if (doc.querySelector(s)) return { reason: "captcha", detail: `matched ${s}` };
  }

  // If any expected page chrome rendered, this is NOT a CAPTCHA / interstitial.
  // Bail out of the brittle text-based heuristics entirely.
  const expectedPagePresent = !!doc.querySelector(
    "[data-test='job-tile-list'], [data-test='filters-button'], [data-test='Description'], h1, main",
  );
  if (expectedPagePresent) return null;

  // Fall through to user-visible text only (innerText respects CSS visibility
  // and skips <script>/<style>). Cap at 4 kB so giant SPA shells don't slow us.
  const visible = doc.body instanceof HTMLElement ? doc.body.innerText.slice(0, 4000) : "";
  if (/please verify you are a human|are you a robot|verify you'?re human/i.test(visible)) {
    return { reason: "captcha", detail: "human-verification copy detected" };
  }
  if (/access denied|too many requests|you have been rate.?limited/i.test(visible)) {
    return { reason: "rate_limit", detail: "rate-limit copy detected" };
  }
  return null;
}

function getResultCount(): number {
  const kind = detectPageKind(window.location.pathname);
  if (!kind) return 0;
  const sel = SELECTORS[kind].itemList;
  if (!sel) return 1;
  return document.querySelectorAll(sel).length;
}

function jitter(min: number, max: number): number {
  if (max <= min) return Math.max(0, min);
  return min + Math.floor(Math.random() * (max - min));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/// Resolve once a stable container is present. Returns true if found, false on timeout.
function waitForContainer(selector: string, timeoutMs = 8000): Promise<boolean> {
  if (document.querySelector(selector)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      if (document.querySelector(selector)) return resolve(true);
      if (Date.now() - start > timeoutMs) return resolve(false);
      requestAnimationFrame(tick);
    };
    tick();
  });
}

/// Wait for two consecutive idle frames so the React tree settles.
function waitForReactSettle(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}
