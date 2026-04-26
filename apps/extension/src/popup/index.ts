import { getSettings, getStatus } from "@/lib/storage";
import { z } from "zod";

const StatusSchema = z.object({
  paused: z.boolean(),
  pauseReason: z.string().nullable(),
  throttleMinMs: z.number(),
  throttleMaxMs: z.number(),
  counts: z.object({
    pending: z.number(),
    running: z.number(),
    done: z.number(),
    failed: z.number(),
  }),
});

async function fetchCrawlStatus(endpoint: string) {
  try {
    const origin = new URL(endpoint).origin;
    const res = await fetch(`${origin}/api/crawl/status`);
    if (!res.ok) return null;
    const parsed = StatusSchema.safeParse(await res.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function render(): Promise<void> {
  const [settings, status] = await Promise.all([getSettings(), getStatus()]);
  const crawl = await fetchCrawlStatus(settings.endpoint);

  $("captured").textContent = String(status.capturedThisSession);
  $("flushed").textContent = status.lastFlushAt
    ? new Date(status.lastFlushAt).toLocaleTimeString()
    : "never";

  if (!crawl) {
    $("crawl-state").textContent = "disconnected";
    $("crawl-pending").textContent = "—";
    $("crawl-tally").textContent = "—";
  } else {
    const state = crawl.paused
      ? `paused${crawl.pauseReason ? ` (${crawl.pauseReason})` : ""}`
      : crawl.counts.running > 0
        ? "running"
        : crawl.counts.pending > 0
          ? "queued"
          : "idle";
    $("crawl-state").textContent = state;
    $("crawl-pending").textContent = String(crawl.counts.pending + crawl.counts.running);
    $("crawl-tally").textContent = `${crawl.counts.done} / ${crawl.counts.failed}`;
  }

  const dot = $("status-dot");
  dot.classList.remove("on", "off", "err");
  if ((crawl?.paused) || status.lastError) dot.classList.add("err");
  else if (settings.enabled && crawl !== null) dot.classList.add("on");
  else dot.classList.add("off");

  const errBox = $("error");
  if (status.lastError || crawl?.paused) {
    errBox.hidden = false;
    $("error-text").textContent = status.lastError ??
      `crawler is paused (${crawl?.pauseReason ?? "unknown reason"})`;
  } else {
    errBox.hidden = true;
  }
}

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} not found`);
  return el;
}

document.addEventListener("DOMContentLoaded", () => {
  void render();
  $("open-options").addEventListener("click", () => chrome.runtime.openOptionsPage());
  chrome.storage.onChanged.addListener(() => void render());
  setInterval(() => void render(), 4000);
});
