import { getSettings, getStatus } from "@/lib/storage";
import { ScrapeSessionSchema, type ScrapeSession } from "@research-bot/shared";

async function fetchSession(endpoint: string): Promise<ScrapeSession | null> {
  try {
    const origin = new URL(endpoint).origin;
    const res = await fetch(`${origin}/api/scrape/current`);
    if (!res.ok) return null;
    const body = (await res.json()) as { session?: unknown };
    const parsed = ScrapeSessionSchema.safeParse(body.session);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function render(): Promise<void> {
  const [settings, status] = await Promise.all([getSettings(), getStatus()]);
  const session = await fetchSession(settings.endpoint);

  $("captured").textContent = String(status.capturedThisSession);
  $("flushed").textContent = status.lastFlushAt
    ? new Date(status.lastFlushAt).toLocaleTimeString()
    : "never";

  if (!session) {
    $("scrape-state").textContent = "disconnected";
    $("scrape-since").textContent = "—";
    $("scrape-heartbeat").textContent = "—";
  } else {
    $("scrape-state").textContent = session.status;
    $("scrape-since").textContent = session.startedAt
      ? `${secondsAgo(session.startedAt)}s ago`
      : "—";
    $("scrape-heartbeat").textContent = session.lastHeartbeat
      ? `${secondsAgo(session.lastHeartbeat)}s ago`
      : "—";
  }

  const dot = $("status-dot");
  dot.classList.remove("on", "off", "err");
  if (session?.status === "failed" || status.lastError) dot.classList.add("err");
  else if (settings.enabled && session?.status === "running") dot.classList.add("on");
  else dot.classList.add("off");

  const errBox = $("error");
  if (status.lastError || session?.status === "failed") {
    errBox.hidden = false;
    $("error-text").textContent =
      status.lastError ??
      `${session?.failReason ?? "unknown"}${session?.errorMessage ? `: ${session.errorMessage}` : ""}`;
  } else {
    errBox.hidden = true;
  }
}

function secondsAgo(iso: string): number {
  return Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
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
  setInterval(() => void render(), 2000);
});
