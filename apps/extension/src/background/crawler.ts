import type { ScrapeFailReason, ScrapeSession } from "@research-bot/shared";
import { getSettings, patchStatus } from "@/lib/storage";
import {
  fetchCurrent,
  postCancel,
  reportComplete,
  reportFail,
} from "@/lib/scrape-transport";

/// Session-driven scraper. Polls /api/scrape/current every POLL_INTERVAL_MS.
/// While the session is `running`, drives a single managed Chrome tab to
/// the feed URL and lets the content script work. When the session goes
/// terminal — by user cancel, server watchdog, or content-script done —
/// closes the tab.
///
/// The CLI owns the lifecycle. The SW is a simple state-follower.

const FEED_URL = "https://www.shannonjean.info/products/communities/v2/xmm/home";
const POLL_INTERVAL_MS = 1500;

// chrome.storage.local key for the persisted managed tab id (so the SW can
// recover after MV3 hibernation).
const STORAGE_TAB_KEY = "managedTabId";

let managedTabId: number | null = null;
let running = false;
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let lastSeenStartedAt: string | null = null;
let lastReportedStatus: ScrapeSession["status"] | "absent" | null = null;
let completionInFlight = false;

// One-time content-script tally for the active session, indexed by post UUID.
const sessionExternalIds = new Set<string>();

async function loadPersistedTabId(): Promise<void> {
  try {
    const got = await chrome.storage.local.get({ [STORAGE_TAB_KEY]: null });
    const id = (got as Record<string, unknown>)[STORAGE_TAB_KEY];
    if (typeof id === "number") {
      try {
        const tab = await chrome.tabs.get(id);
        if (tab) {
          managedTabId = id;
          return;
        }
      } catch {
        /* tab no longer exists */
      }
    }
  } catch {
    /* ignore */
  }
  managedTabId = null;
}

async function persistTabId(id: number | null): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_TAB_KEY]: id });
}

async function ensureManagedTab(url: string): Promise<number> {
  // Mid-session recovery only: if the SW just respawned but a session
  // is still running, reuse the persisted tab so we don't spawn a
  // duplicate scraper into a new tab. Validate it's still on the host
  // before trusting it.
  if (managedTabId !== null) {
    try {
      const tab = await chrome.tabs.get(managedTabId);
      const onHost =
        typeof tab?.url === "string" && tab.url.startsWith("https://www.shannonjean.info/");
      if (tab && onHost) {
        return managedTabId;
      }
      // Persisted tab was reused by Chrome for something else, or moved
      // off-host. Discard and create fresh.
      managedTabId = null;
      await persistTabId(null);
    } catch {
      managedTabId = null;
      await persistTabId(null);
    }
  }

  // Default behavior: each scrape session opens its own fresh tab.
  const tab = await chrome.tabs.create({ url, active: false });
  managedTabId = tab.id ?? null;
  if (managedTabId === null) throw new Error("Could not create managed tab");
  await persistTabId(managedTabId);
  console.log(`[crawler] created managed tab ${managedTabId} window=${tab.windowId}`);
  return managedTabId;
}

function stripFragment(u: string): string {
  const i = u.indexOf("#");
  return i < 0 ? u : u.slice(0, i);
}

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === managedTabId) {
    managedTabId = null;
    void persistTabId(null);
  }
});

/// Used by content scripts to ask "am I being driven by the scraper?".
/// Returns true when the calling tab is the managed tab AND we observed
/// `running` state on the last poll.
export function isManagedTab(tabId: number | undefined): boolean {
  if (tabId === undefined) return false;
  return managedTabId !== null && tabId === managedTabId && lastReportedStatus === "running";
}

/// Content scripts emit `kajabi:items` with each captured post; track the
/// running tally so the completion path can report it accurately.
export function noteCapturedExternalIds(
  sender: chrome.runtime.MessageSender,
  ids: string[],
): void {
  if (sender.tab?.id !== managedTabId) return;
  for (const id of ids) sessionExternalIds.add(id);
}

/// Content script → SW completion message. Drains the SW's ingest queue
/// (so all in-flight items reach the DB before we report done), then
/// POSTs /api/scrape/complete. The CLI's status loop then sees `done`
/// and exits cleanly.
export async function handleScriptComplete(
  sender: chrome.runtime.MessageSender,
  flushAndDrain: () => Promise<void>,
): Promise<void> {
  if (sender.tab?.id !== managedTabId) return;
  if (completionInFlight) return;
  completionInFlight = true;
  const captured = sessionExternalIds.size;
  console.log(`[crawler] content script reported complete; draining queue (${captured} posts)`);
  try {
    await flushAndDrain();
    const settings = await getSettings();
    await reportComplete(settings.endpoint, captured);
    console.log("[crawler] reported complete to server");
  } finally {
    completionInFlight = false;
  }
}

export async function handleScriptFail(
  sender: chrome.runtime.MessageSender,
  reason: ScrapeFailReason,
  error: string | undefined,
): Promise<void> {
  if (sender.tab?.id !== managedTabId) return;
  console.warn(`[crawler] content script reported fail: ${reason} ${error ?? ""}`);
  const settings = await getSettings();
  await reportFail(settings.endpoint, reason, error);
}

async function tick(): Promise<void> {
  if (!running) return;
  pollTimer = null;

  const settings = await getSettings();
  if (!settings.enabled) {
    schedulePoll(POLL_INTERVAL_MS);
    return;
  }

  const session = await fetchCurrent(settings.endpoint);
  if (!session) {
    if (lastReportedStatus !== "absent") {
      console.log("[crawler] session endpoint unreachable; will retry");
      lastReportedStatus = "absent";
    }
    schedulePoll(POLL_INTERVAL_MS);
    return;
  }

  // New session detected — reset state and drop any prior managed
  // tab. Each scrape session opens its own fresh tab; reusing tabs
  // across sessions caused too many edge cases (stale state, Apollo
  // cache corruption, wrong-window confusion).
  if (session.startedAt && session.startedAt !== lastSeenStartedAt) {
    if (lastSeenStartedAt !== null) {
      console.log(`[crawler] new session detected (${session.startedAt})`);
    }
    lastSeenStartedAt = session.startedAt;
    sessionExternalIds.clear();
    completionInFlight = false;
    // Close any old tab so we don't leave stale ones lying around.
    if (managedTabId !== null) {
      const stale = managedTabId;
      managedTabId = null;
      await persistTabId(null);
      try {
        await chrome.tabs.remove(stale);
        console.log(`[crawler] closed previous managed tab ${stale}`);
      } catch {
        /* tab already gone */
      }
    }
  }

  if (session.status !== lastReportedStatus) {
    console.log(`[crawler] session status: ${lastReportedStatus} → ${session.status}`);
    lastReportedStatus = session.status;
    await patchStatus({
      lastError:
        session.status === "failed"
          ? `${session.failReason ?? "unknown"}${session.errorMessage ? `: ${session.errorMessage}` : ""}`
          : null,
    });
  }

  switch (session.status) {
    case "running":
      try {
        await ensureManagedTab(FEED_URL);
      } catch (err) {
        console.error("[crawler] failed to open managed tab:", err);
        await postCancel(settings.endpoint, "navigation_error", (err as Error).message);
      }
      break;
    case "canceled":
    case "done":
    case "failed":
      // Leave the managed tab open on terminal transitions so the user
      // can still read the content script's console logs after the CLI
      // exits. Releasing the tab from this side just clears our local
      // reference; ensureManagedTab on the next session will reuse it
      // (same URL → reload) or open a fresh one.
      if (managedTabId !== null) {
        console.log(
          `[crawler] terminal status (${session.status}); releasing managed tab (kept open for log review)`,
        );
        managedTabId = null;
        await persistTabId(null);
      }
      break;
    case "idle":
      // Nothing to do. If a tab is open from a prior session, leave it —
      // the user might still be reading it.
      break;
  }

  schedulePoll(POLL_INTERVAL_MS);
}

function schedulePoll(delayMs: number): void {
  if (pollTimer !== null) clearTimeout(pollTimer);
  pollTimer = setTimeout(() => void tick(), delayMs);
}

export function startCrawler(): void {
  if (running) return;
  running = true;
  void loadPersistedTabId().then(() => schedulePoll(0));
  console.log("[crawler] started");
}

export function stopCrawler(): void {
  running = false;
  if (pollTimer !== null) clearTimeout(pollTimer);
  pollTimer = null;
  console.log("[crawler] stopped");
}

export function crawlerStatus(): {
  running: boolean;
  managedTabId: number | null;
  lastStatus: string | null;
} {
  return {
    running,
    managedTabId,
    lastStatus: lastReportedStatus,
  };
}
