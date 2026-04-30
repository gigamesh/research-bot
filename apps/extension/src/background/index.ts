import {
  KajabiIngestPayloadSchema,
  ScrapeFailReasonSchema,
  type KajabiIngestPayload,
  type KajabiPostItem,
} from "@research-bot/shared";
import { getSettings, getStatus, patchStatus } from "@/lib/storage";
import { postBatch } from "@/lib/transport";
import { postPhase } from "@/lib/scrape-transport";
import {
  startCrawler,
  stopCrawler,
  isManagedTab,
  noteCapturedExternalIds,
  handleScriptComplete,
  handleScriptFail,
} from "./crawler";

/// Background service worker. Receives scraped items from content scripts,
/// persists a queue across SW restarts, and POSTs in batches with
/// exponential backoff on retriable failures.
///
/// Lifecycle is driven by ScrapeSession (see crawler.ts) — this file
/// owns only the ingest-queue plumbing and the message-bus glue.

const QUEUE_KEY = "queue";
const MAX_BATCH = 25;
const FLUSH_INTERVAL_MS = 5000;
const MAX_BACKOFF_MS = 60_000;
const DRAIN_POLL_MS = 250;
const DRAIN_TIMEOUT_MS = 30_000;

type QueueState = { items: KajabiPostItem[]; backoffMs: number };

const ZERO_QUEUE: QueueState = { items: [], backoffMs: 0 };

async function readQueue(): Promise<QueueState> {
  const got = (await chrome.storage.local.get({ [QUEUE_KEY]: ZERO_QUEUE })) as {
    [QUEUE_KEY]: QueueState;
  };
  return got[QUEUE_KEY];
}

async function writeQueue(q: QueueState): Promise<void> {
  await chrome.storage.local.set({ [QUEUE_KEY]: q });
}

async function enqueue(items: KajabiPostItem[]): Promise<void> {
  if (items.length === 0) return;
  const q = await readQueue();
  // Re-scrapes legitimately overwrite the queued copy with newer comments,
  // so dedupe by UUID and replace.
  const byUuid = new Map(q.items.map((i) => [i.uuid, i]));
  for (const it of items) byUuid.set(it.uuid, it);
  q.items = Array.from(byUuid.values());
  await writeQueue(q);
  await patchStatus({ pendingInQueue: q.items.length });
  scheduleFlush(0);
}

let flushTimer: number | null = null;

function scheduleFlush(delayMs: number): void {
  if (flushTimer !== null) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flush();
  }, delayMs) as unknown as number;
}

async function flush(): Promise<void> {
  const settings = await getSettings();
  const q = await readQueue();
  if (q.items.length === 0) return;
  if (!settings.enabled) return;

  const batch = q.items.slice(0, MAX_BATCH);
  const payload: KajabiIngestPayload = {
    items: batch,
    capturedAt: new Date().toISOString(),
  };
  const result = await postBatch<KajabiIngestPayload>(settings.endpoint, payload);

  if (result.ok) {
    const { created, updated, skipped } = result.response;
    console.log(
      `[bg] flush ${batch.length} → ${created} created, ${updated} updated, ${skipped} skipped`,
    );
    const remaining = q.items.slice(batch.length);
    await writeQueue({ items: remaining, backoffMs: 0 });
    const status = await getStatus();
    await patchStatus({
      pendingInQueue: remaining.length,
      lastFlushAt: Date.now(),
      lastError: null,
      capturedThisSession:
        status.capturedThisSession + created + updated,
    });
    if (remaining.length > 0) scheduleFlush(0);
    return;
  }

  if (result.retriable) {
    const next = Math.min(MAX_BACKOFF_MS, Math.max(2000, q.backoffMs * 2));
    await writeQueue({ ...q, backoffMs: next });
    await patchStatus({
      pendingInQueue: q.items.length,
      lastError: `Retry in ${(next / 1000).toFixed(0)}s — ${result.message.slice(0, 200)}`,
    });
    scheduleFlush(next);
    return;
  }

  // 4xx — drop the offending batch, reset backoff. Surface the error so the
  // user can fix their payload and the next captured item flushes cleanly.
  await writeQueue({ items: q.items.slice(batch.length), backoffMs: 0 });
  await patchStatus({
    pendingInQueue: Math.max(0, q.items.length - batch.length),
    lastError: `${result.status}: ${result.message.slice(0, 200)}`,
  });
}

/// Block until the queue is empty (or the drain timeout elapses). Used by
/// the completion path so the server only sees status=done after all
/// captured items have been ingested.
async function flushAndDrain(): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < DRAIN_TIMEOUT_MS) {
    const q = await readQueue();
    if (q.items.length === 0) return;
    await flush();
    await new Promise((r) => setTimeout(r, DRAIN_POLL_MS));
  }
  console.warn("[bg] drain timeout; some items may still be queued");
}

/// Origin from the current ingest endpoint, used by the seen-uuids fetch
/// so we don't have to ship a second URL.
function originFromIngestEndpoint(ingest: string): string {
  try {
    return new URL(ingest).origin;
  } catch {
    return "http://localhost:3001";
  }
}

async function fetchSeenUuids(): Promise<string[]> {
  const settings = await getSettings();
  const origin = originFromIngestEndpoint(settings.endpoint);
  try {
    const res = await fetch(`${origin}/api/kajabi/seen-uuids`, { method: "GET" });
    if (!res.ok) return [];
    const body = (await res.json()) as { uuids?: string[] };
    return Array.isArray(body.uuids) ? body.uuids : [];
  } catch {
    return [];
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "kajabi:items" && Array.isArray(msg.items)) {
    const parsed = KajabiIngestPayloadSchema.safeParse({
      items: msg.items,
      capturedAt: new Date().toISOString(),
    });
    if (!parsed.success) {
      console.warn("[bg] rejected malformed kajabi:items", parsed.error.issues.slice(0, 3));
      sendResponse({ ok: false });
      return false;
    }
    const items = parsed.data.items;
    noteCapturedExternalIds(sender, items.map((i) => i.uuid));
    void enqueue(items).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg?.type === "kajabi:flush") {
    scheduleFlush(0);
    sendResponse({ ok: true });
    return true;
  }
  if (msg?.type === "kajabi:seen-uuids") {
    void fetchSeenUuids().then((uuids) => sendResponse({ uuids }));
    return true;
  }
  if (msg?.type === "scrape:am-i-managed") {
    sendResponse({ managed: isManagedTab(sender.tab?.id) });
    return true;
  }
  if (msg?.type === "scrape:reload-tab") {
    // Content script asks us to reload the managed tab — typically to
    // flush Apollo's pagination cache after Kajabi stops responding.
    // After reload, the content script reruns and continues scraping.
    if (sender.tab?.id !== undefined) {
      void chrome.tabs.reload(sender.tab.id).catch(() => {});
      console.log(`[bg] reloading managed tab ${sender.tab.id} on script request`);
    }
    sendResponse({ ok: true });
    return true;
  }
  if (msg?.type === "kajabi:phase" && typeof msg.phase === "string") {
    void getSettings().then((settings) => postPhase(settings.endpoint, msg.phase as string));
    sendResponse({ ok: true });
    return true;
  }
  if (msg?.type === "kajabi:complete") {
    void handleScriptComplete(sender, flushAndDrain).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg?.type === "kajabi:fail") {
    const reasonParse = ScrapeFailReasonSchema.safeParse(msg.reason);
    const reason = reasonParse.success ? reasonParse.data : "other";
    const error = typeof msg.error === "string" ? msg.error : undefined;
    void handleScriptFail(sender, reason, error).then(() => sendResponse({ ok: true }));
    return true;
  }
  return false;
});

chrome.runtime.onStartup.addListener(() => {
  scheduleFlush(0);
  startCrawler();
});
chrome.runtime.onInstalled.addListener(() => {
  scheduleFlush(0);
  startCrawler();
});

// Cold-start: SWs wake on event, not at install — kick the crawler now too.
console.log(`[bg] service worker live  build=${__BUILD_MARKER__}`);
startCrawler();
void stopCrawler; // keep export reachable for popup wiring

// Periodic safety net so a queued batch always flushes even without new traffic.
chrome.alarms?.create("flush-tick", { periodInMinutes: 1 });
chrome.alarms?.onAlarm.addListener((alarm) => {
  if (alarm.name === "flush-tick") scheduleFlush(0);
});

void scheduleFlush(FLUSH_INTERVAL_MS);
