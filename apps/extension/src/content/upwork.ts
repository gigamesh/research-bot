import { detectPageKind, SELECTORS } from "@/lib/selectors";
import { parseCardListPage } from "@/parsers/job-search";
import { parseCategoryFeedPage } from "@/parsers/category-feed";
import { parseDetailPage } from "@/parsers/job-detail";
import type { UpworkJobItem, CrawlFailReason } from "@research-bot/shared";

/// Upwork capture. Runs on every upwork.com page load. Two flavors:
///   - Passive: user browses normally, items get scraped + sent to the SW.
///   - Crawler-driven: the SW navigates a managed tab to a URL, this script
///     scrapes, then emits a final `crawl:status` so the SW can mark the
///     CrawlJob done/fail. The SW correlates by sender.tab.id.

const PARSED_FOR_HREF = new Set<string>();

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

  if (!kind) return;
  if (!settings.enabled) return;
  if (settings.capture && settings.capture[kind] === false) return;

  const containerFound = await waitForContainer(SELECTORS[kind].pageReady);
  await waitForReactSettle();

  // Even if the container never showed up, run the parser once — better to
  // ship a partial result than fail the whole crawl on a flaky selector.
  const captured = scrapeAndSend(kind);

  if (!containerFound && captured.length === 0) {
    // The pageReady selector never appeared AND we got nothing — most likely
    // selector drift from an Upwork redesign.
    sendCrawlStatus({
      ok: false,
      reason: "selector_drift",
      error: `pageReady selector ${SELECTORS[kind].pageReady} never matched`,
    });
  } else {
    sendCrawlStatus({
      ok: true,
      externalIds: captured.map((c) => c.externalId),
      itemsCaptured: captured.length,
    });
  }

  // Keep watching for SPA navigation so passive users still get re-scraped
  // (the crawler navigates whole new tabs, so passive-only here).
  const observer = new MutationObserver(() => {
    if (!PARSED_FOR_HREF.has(window.location.href + ":" + getResultCount())) {
      scrapeAndSend(detectPageKind(window.location.pathname) ?? kind);
    }
  });
  observer.observe(document.body, { subtree: true, childList: true });
}

function scrapeAndSend(kind: ReturnType<typeof detectPageKind>): UpworkJobItem[] {
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

  if (items.length === 0) return [];
  PARSED_FOR_HREF.add(dedupKey);

  chrome.runtime.sendMessage({ type: "upwork:items", items }).catch(() => {
    // Service worker can be asleep — message will retry on next scrape.
  });
  return items;
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

  const text = doc.body?.textContent ?? "";
  if (/please verify you are a human|are you a robot|access denied|rate limit/i.test(text)) {
    return { reason: "rate_limit", detail: text.slice(0, 200).replace(/\s+/g, " ") };
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
