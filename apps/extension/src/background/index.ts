import type { UpworkJobItem, IngestPayload, CrawlFailReason } from "@research-bot/shared";
import { getSettings, getStatus, patchStatus } from "@/lib/storage";
import { postBatch } from "@/lib/transport";
import {
  startCrawler,
  stopCrawler,
  handleCrawlStatus,
  noteCapturedExternalIds,
} from "./crawler";

/// Background service worker. Receives scraped items from content scripts,
/// dedupes by externalId, persists the queue across SW restarts, and POSTs
/// in batches with exponential backoff on retriable failures.

const QUEUE_KEY = "queue";
const MAX_BATCH = 25;
const FLUSH_INTERVAL_MS = 5000;
const MAX_BACKOFF_MS = 60_000;

type QueueState = { items: UpworkJobItem[]; backoffMs: number };

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

async function enqueue(items: UpworkJobItem[]): Promise<void> {
  if (items.length === 0) return;
  const q = await readQueue();
  const seen = new Set(q.items.map((i) => i.externalId + ":" + i.capturedFrom));
  for (const it of items) {
    const key = it.externalId + ":" + it.capturedFrom;
    if (seen.has(key)) continue;
    q.items.push(it);
    seen.add(key);
  }
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
  const payload: IngestPayload = { items: batch, capturedAt: new Date().toISOString() };
  const result = await postBatch(settings.endpoint, payload);

  if (result.ok) {
    const remaining = q.items.slice(batch.length);
    await writeQueue({ items: remaining, backoffMs: 0 });
    const status = await getStatus();
    await patchStatus({
      pendingInQueue: remaining.length,
      lastFlushAt: Date.now(),
      lastError: null,
      capturedThisSession:
        status.capturedThisSession + result.response.created + result.response.updated,
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
  // user can fix their token / payload and the next captured item flushes cleanly.
  await writeQueue({ items: q.items.slice(batch.length), backoffMs: 0 });
  await patchStatus({
    pendingInQueue: Math.max(0, q.items.length - batch.length),
    lastError: `${result.status}: ${result.message.slice(0, 200)}`,
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "upwork:items" && Array.isArray(msg.items)) {
    const items = msg.items as UpworkJobItem[];
    noteCapturedExternalIds(sender, items.map((i) => i.externalId));
    void enqueue(items).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg?.type === "upwork:flush") {
    scheduleFlush(0);
    sendResponse({ ok: true });
    return true;
  }
  if (msg?.type === "crawl:status") {
    if (msg.ok === true && Array.isArray(msg.externalIds)) {
      handleCrawlStatus(sender, {
        ok: true,
        externalIds: msg.externalIds as string[],
        itemsCaptured: typeof msg.itemsCaptured === "number" ? msg.itemsCaptured : 0,
      });
    } else if (msg.ok === false && typeof msg.reason === "string") {
      handleCrawlStatus(sender, {
        ok: false,
        reason: msg.reason as CrawlFailReason,
        error: typeof msg.error === "string" ? msg.error : undefined,
      });
    }
    sendResponse({ ok: true });
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
startCrawler();
void stopCrawler; // keep export reachable for popup wiring

// Periodic safety net so a queued batch always flushes even without new traffic.
chrome.alarms?.create("flush-tick", { periodInMinutes: 1 });
chrome.alarms?.onAlarm.addListener((alarm) => {
  if (alarm.name === "flush-tick") scheduleFlush(0);
});

void scheduleFlush(FLUSH_INTERVAL_MS);
