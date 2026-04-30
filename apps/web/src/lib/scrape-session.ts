import { prisma } from "@/lib/db";
import type {
  ScrapeFailReason,
  ScrapeSession as ScrapeSessionWire,
  ScrapeStatus,
} from "@research-bot/shared";

const ALLOWED_ORIGIN = "https://www.shannonjean.info";

export const SCRAPE_CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
  Vary: "Origin",
};

/// Watchdog threshold. The CLI heartbeats every ~1s; if the SW polls and
/// finds the heartbeat older than this, it cancels the session itself
/// (assumes the CLI was killed) and closes the managed tab.
export const HEARTBEAT_STALE_MS = 5_000;

export async function ensureSession(): Promise<ScrapeSessionWire> {
  const row = await prisma.scrapeSession.upsert({
    where: { id: "singleton" },
    create: { id: "singleton" },
    update: {},
  });
  return wire(row);
}

export async function startSession(kind = "feed"): Promise<ScrapeSessionWire> {
  const row = await prisma.scrapeSession.upsert({
    where: { id: "singleton" },
    create: {
      id: "singleton",
      status: "running",
      kind,
      startedAt: new Date(),
      finishedAt: null,
      lastHeartbeat: new Date(),
      failReason: null,
      errorMessage: null,
    },
    update: {
      status: "running",
      kind,
      startedAt: new Date(),
      finishedAt: null,
      lastHeartbeat: new Date(),
      failReason: null,
      errorMessage: null,
    },
  });
  return wire(row);
}

export async function heartbeat(): Promise<ScrapeSessionWire> {
  const row = await prisma.scrapeSession.upsert({
    where: { id: "singleton" },
    create: {
      id: "singleton",
      status: "idle",
      lastHeartbeat: new Date(),
    },
    update: { lastHeartbeat: new Date() },
  });
  return wire(row);
}

export async function setStatus(
  status: ScrapeStatus,
  patch: { failReason?: ScrapeFailReason | null; errorMessage?: string | null } = {},
): Promise<ScrapeSessionWire> {
  const finished = status === "done" || status === "canceled" || status === "failed";
  const row = await prisma.scrapeSession.upsert({
    where: { id: "singleton" },
    create: {
      id: "singleton",
      status,
      finishedAt: finished ? new Date() : null,
      failReason: patch.failReason ?? null,
      errorMessage: patch.errorMessage ?? null,
    },
    update: {
      status,
      finishedAt: finished ? new Date() : null,
      failReason: patch.failReason ?? undefined,
      errorMessage: patch.errorMessage ?? undefined,
    },
  });
  return wire(row);
}

type DbRow = Awaited<ReturnType<typeof prisma.scrapeSession.findFirst>>;

export function wire(row: NonNullable<DbRow>): ScrapeSessionWire {
  return {
    id: row.id,
    status: row.status as ScrapeStatus,
    kind: row.kind,
    startedAt: row.startedAt ? row.startedAt.toISOString() : null,
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
    lastHeartbeat: row.lastHeartbeat ? row.lastHeartbeat.toISOString() : null,
    failReason: (row.failReason as ScrapeFailReason | null) ?? null,
    errorMessage: row.errorMessage ?? null,
    phase: row.phase ?? null,
  };
}

export async function setPhase(phase: string): Promise<ScrapeSessionWire> {
  const row = await prisma.scrapeSession.upsert({
    where: { id: "singleton" },
    create: { id: "singleton", phase: phase.slice(0, 200) },
    update: { phase: phase.slice(0, 200) },
  });
  return wire(row);
}
