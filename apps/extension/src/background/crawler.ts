import type {
  CrawlJobView,
  CrawlNextResponse,
  CrawlFailReason,
} from "@research-bot/shared";
import { getSettings, patchStatus } from "@/lib/storage";
import { fetchNext, reportDone, reportFail } from "@/lib/crawl-transport";

/// Crawler. Polls the local web app for pending CrawlJobs, drives a single
/// managed Chrome tab through each URL, and reports done/fail. The capture
/// itself still flows through the existing `upwork:items` → `/api/ingest/upwork`
/// path — this module only orchestrates *when* the user's session visits a URL.

const POLL_IDLE_MS = 5000;       // poll cadence when no job is in flight
const JOB_TIMEOUT_MS = 90_000;   // give a page up to 90s to render + capture

type JobContext = {
  job: CrawlJobView;
  externalIds: Set<string>;
  startedAt: number;
  timeoutHandle: ReturnType<typeof setTimeout> | null;
  resolve: () => void;
};

let managedTabId: number | null = null;
let active: JobContext | null = null;
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let running = false;

function jitter(min: number, max: number): number {
  if (max <= min) return Math.max(0, min);
  return min + Math.floor(Math.random() * (max - min));
}

async function ensureManagedTab(url: string): Promise<number> {
  if (managedTabId !== null) {
    try {
      const tab = await chrome.tabs.get(managedTabId);
      if (tab) {
        await chrome.tabs.update(managedTabId, { url, active: false });
        return managedTabId;
      }
    } catch {
      // stale id; fall through
    }
  }
  const tab = await chrome.tabs.create({ url, active: false });
  managedTabId = tab.id ?? null;
  if (managedTabId === null) throw new Error("Could not create managed tab");
  return managedTabId;
}

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === managedTabId) managedTabId = null;
});

/// Content scripts call back here at end-of-page with a status. We correlate by
/// tab id so a passive (non-managed) capture in another tab doesn't accidentally
/// complete the active job.
export function handleCrawlStatus(
  sender: chrome.runtime.MessageSender,
  status:
    | { ok: true; externalIds: string[]; itemsCaptured: number }
    | { ok: false; reason: CrawlFailReason; error?: string },
): void {
  if (!active) return;
  if (sender.tab?.id !== managedTabId) return;

  if (status.ok) {
    active.externalIds = new Set(status.externalIds);
    completeActive("done", status.itemsCaptured);
  } else {
    completeActive("fail", 0, status.reason, status.error);
  }
}

/// Some captures are emitted before the final status (e.g. card lists). Track
/// the externalIds opportunistically so a timeout still ships a partial result.
export function noteCapturedExternalIds(
  sender: chrome.runtime.MessageSender,
  ids: string[],
): void {
  if (!active) return;
  if (sender.tab?.id !== managedTabId) return;
  for (const id of ids) active.externalIds.add(id);
}

function completeActive(
  outcome: "done" | "fail",
  itemsCaptured: number,
  reason?: CrawlFailReason,
  error?: string,
): void {
  if (!active) return;
  const ctx = active;
  active = null;
  if (ctx.timeoutHandle) clearTimeout(ctx.timeoutHandle);

  const finish = async () => {
    const settings = await getSettings();
    if (outcome === "done") {
      const res = await reportDone(settings.endpoint, ctx.job.id, {
        itemsCaptured,
        capturedExternalIds: Array.from(ctx.externalIds),
      });
      await patchStatus({
        lastError: null,
        capturedThisSession: (await sumCaptured(itemsCaptured)),
      });
      console.log(`[crawler] done ${ctx.job.id.slice(0, 8)} items=${itemsCaptured} children=${res?.childrenCreated ?? 0}`);
    } else {
      const res = await reportFail(settings.endpoint, ctx.job.id, {
        reason: reason ?? "other",
        error,
      });
      await patchStatus({
        lastError: `${reason ?? "other"}: ${error ?? "(no detail)"}`,
      });
      console.warn(`[crawler] fail ${ctx.job.id.slice(0, 8)} reason=${reason} paused=${res?.paused}`);
    }
    ctx.resolve();
  };
  void finish();
}

async function sumCaptured(delta: number): Promise<number> {
  const got = await chrome.storage.local.get({ status: { capturedThisSession: 0 } });
  const current = (got.status as { capturedThisSession: number }).capturedThisSession ?? 0;
  return current + delta;
}

async function runJob(job: CrawlJobView): Promise<void> {
  await new Promise<void>(async (resolve) => {
    const ctx: JobContext = {
      job,
      externalIds: new Set(),
      startedAt: Date.now(),
      timeoutHandle: null,
      resolve,
    };
    active = ctx;

    ctx.timeoutHandle = setTimeout(() => {
      if (active === ctx) {
        completeActive("fail", ctx.externalIds.size, "timeout", `no response in ${JOB_TIMEOUT_MS}ms`);
      }
    }, JOB_TIMEOUT_MS);

    try {
      await ensureManagedTab(job.url);
    } catch (err) {
      completeActive("fail", 0, "navigation_error", (err as Error).message);
    }
  });
}

async function tick(): Promise<void> {
  if (!running) return;
  pollTimer = null;

  const settings = await getSettings();
  if (!settings.enabled) {
    schedulePoll(POLL_IDLE_MS);
    return;
  }

  const next: CrawlNextResponse | null = await fetchNext(settings.endpoint);
  if (!next) {
    schedulePoll(POLL_IDLE_MS);
    return;
  }

  if (next.paused) {
    await patchStatus({ lastError: `paused: ${next.pauseReason ?? ""}` });
    schedulePoll(POLL_IDLE_MS);
    return;
  }

  if (!next.job) {
    schedulePoll(POLL_IDLE_MS);
    return;
  }

  await runJob(next.job);

  // Throttle between jobs to avoid burst patterns.
  schedulePoll(jitter(next.throttleMinMs, next.throttleMaxMs));
}

function schedulePoll(delayMs: number): void {
  if (pollTimer !== null) clearTimeout(pollTimer);
  pollTimer = setTimeout(() => void tick(), delayMs);
}

export function startCrawler(): void {
  if (running) return;
  running = true;
  schedulePoll(0);
  console.log("[crawler] started");
}

export function stopCrawler(): void {
  running = false;
  if (pollTimer !== null) clearTimeout(pollTimer);
  pollTimer = null;
  console.log("[crawler] stopped");
}

export function crawlerStatus(): { running: boolean; managedTabId: number | null; activeJobId: string | null } {
  return {
    running,
    managedTabId,
    activeJobId: active?.job.id ?? null,
  };
}
