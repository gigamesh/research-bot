/// Scrape CLI: drives one Kajabi feed scrape and stays attached for the
/// whole run. The only command — there is no separate status or cancel
/// subcommand because:
///   - this process is always printing live progress while attached
///   - Ctrl-C is the cancel signal (sends /api/scrape/cancel, waits for
///     the SW to settle, then exits)
///   - if this process is killed (-9), the server's heartbeat watchdog
///     auto-cancels after 5s and the SW closes the tab
///
/// Usage:
///   pnpm scrape             # start a scrape; stays attached until done
///
/// The CLI talks to the local web app (default http://localhost:3001).

import "dotenv/config";
import { spawn, type ChildProcess } from "node:child_process";
import { prisma } from "@/lib/db";
import {
  isTerminalStatus,
  type ScrapeSession,
} from "@research-bot/shared";

const ENDPOINT = process.env.RB_SCRAPE_ENDPOINT ?? "http://localhost:3001";
const HEARTBEAT_MS = 1_000;
const POLL_MS = 400;
/// If this many milliseconds elapse without a new RawPost arriving, print
/// a "still working" heartbeat so the user knows the script is alive
/// while the content script is inside a single post's modal.
const SILENCE_HEARTBEAT_MS = 5_000;

const KAJABI_SOURCE = "kajabi-shannonjean";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postJson<T>(path: string, body: unknown = {}): Promise<T | null> {
  try {
    const res = await fetch(`${ENDPOINT}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.error(`  ! ${path} → HTTP ${res.status}`);
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    console.error(`  ! ${path} → ${(err as Error).message}`);
    return null;
  }
}

type RowChange = {
  id: string;
  externalId: string;
  author: string | null;
  title: string | null;
  body: string;
  rawJson: string | null;
  fetchedAt: Date;
  updatedAt: Date;
  isNew: boolean;
};

async function getKajabiSourceId(): Promise<string | null> {
  const source = await prisma.source.findUnique({
    where: { name: KAJABI_SOURCE },
    select: { id: true },
  });
  return source?.id ?? null;
}

/// Pull every RawPost row that was created or updated since `cursor` (the
/// caller's last seen `updatedAt`). Returns the rows in chronological
/// order so the CLI can print them as live progress.
async function fetchRowChanges(
  cursor: Date,
  sourceId: string,
): Promise<RowChange[]> {
  const rows = await prisma.rawPost.findMany({
    where: { sourceId, updatedAt: { gt: cursor } },
    select: {
      id: true,
      externalId: true,
      author: true,
      title: true,
      body: true,
      rawJson: true,
      fetchedAt: true,
      updatedAt: true,
    },
    orderBy: { updatedAt: "asc" },
    take: 100,
  });
  return rows.map((r) => ({
    ...r,
    // fetchedAt and updatedAt are equal on a fresh create (within a few ms).
    isNew: Math.abs(r.fetchedAt.getTime() - r.updatedAt.getTime()) < 250,
  }));
}

async function totalRows(sourceId: string): Promise<number> {
  return prisma.rawPost.count({ where: { sourceId } });
}

type StoredComment = {
  uuid: string;
  parentUuid: string | null;
  author?: { name?: string };
  bodyText?: string;
};

type StoredItem = {
  commentCount?: number;
  comments?: StoredComment[];
};

function parseStoredItem(rawJson: string | null): StoredItem | null {
  if (!rawJson) return null;
  try {
    return JSON.parse(rawJson) as StoredItem;
  } catch {
    return null;
  }
}

function preview(text: string, n: number): string {
  const compact = (text ?? "").replace(/\s+/g, " ").trim();
  if (compact.length <= n) return compact;
  return `${compact.slice(0, n - 1)}…`;
}

function formatRowLines(r: RowChange): string[] {
  const out: string[] = [];
  const marker = r.isNew ? "+" : "*";
  const author = (r.author ?? "?").padEnd(18).slice(0, 18);
  const head = preview(r.title || r.body, 60);

  const stored = parseStoredItem(r.rawJson);
  const comments = stored?.comments ?? [];
  const cc =
    typeof stored?.commentCount === "number" ? stored.commentCount : comments.length;
  const ccLabel = cc === 0 ? "0 comments" : `${cc} comment${cc === 1 ? "" : "s"}`;

  out.push(`  ${marker} [${author}] "${head}" (${ccLabel})`);

  // Per-comment lines, indented by reply depth. Tree is rebuilt by
  // following parentUuid; siblings stay in the order they were captured
  // (which mirrors Kajabi's chronological DOM order).
  if (comments.length > 0) {
    const byParent = new Map<string | null, StoredComment[]>();
    for (const c of comments) {
      const key = c.parentUuid ?? null;
      const arr = byParent.get(key) ?? [];
      arr.push(c);
      byParent.set(key, arr);
    }
    const walk = (parentUuid: string | null, depth: number) => {
      for (const c of byParent.get(parentUuid) ?? []) {
        const indent = "      " + "  ".repeat(depth);
        const cAuthor = c.author?.name ?? "?";
        const cText = preview(c.bodyText ?? "", 60);
        out.push(`${indent}↳ [${cAuthor}] ${cText}`);
        walk(c.uuid, depth + 1);
      }
    };
    walk(null, 0);
  }

  return out;
}

/// macOS-only system-stay-awake during scrape. The screen-lock setting
/// only handles the screen; idle sleep can still suspend the process.
/// `caffeinate -dim` keeps display, idle, and disk awake. We launch it
/// as a child process and kill it on any exit path.
let caffeinateProc: ChildProcess | null = null;
function startCaffeinate(): void {
  if (process.platform !== "darwin") return;
  try {
    caffeinateProc = spawn("caffeinate", ["-dim"], {
      stdio: "ignore",
      detached: false,
    });
    caffeinateProc.on("error", () => {
      caffeinateProc = null;
    });
    console.log("[scrape] caffeinate -dim started — display + idle sleep suppressed");
  } catch {
    /* not fatal; user can manually use caffeinate / Amphetamine */
  }
}
function stopCaffeinate(): void {
  if (caffeinateProc && !caffeinateProc.killed) {
    try {
      caffeinateProc.kill();
    } catch {
      /* ignore */
    }
  }
  caffeinateProc = null;
}

async function cmdFeed(): Promise<number> {
  console.log("[scrape] starting feed session…");
  const startResp = await postJson<{ session: ScrapeSession }>("/api/scrape/start");
  if (!startResp) {
    console.error("[scrape] failed to reach the local web app at " + ENDPOINT);
    console.error("        is `pnpm dev` running?");
    return 2;
  }
  startCaffeinate();

  let session = startResp.session;
  console.log(
    `[scrape] session started at ${session.startedAt}\n         driving the extension; ctrl-c to cancel`,
  );

  const startedAt = session.startedAt ? new Date(session.startedAt) : new Date();

  // SIGINT → cancel and wait for the session to settle. We don't kill the
  // process abruptly; we let the SW close the tab cleanly.
  let canceling = false;
  const cancelHandler = async () => {
    if (canceling) return;
    canceling = true;
    console.log("\n[scrape] caught ctrl-c — canceling session…");
    await postJson("/api/scrape/cancel", { reason: "other", error: "user canceled (ctrl-c)" });
    stopCaffeinate();
  };
  process.on("SIGINT", () => void cancelHandler());
  process.on("SIGTERM", () => void cancelHandler());
  process.on("exit", () => stopCaffeinate());

  let lastStatus = session.status;
  let lastHeartbeatAt = Date.now();
  let cursor = startedAt; // updatedAt cursor — start from the session start
  let totalNew = 0;
  let totalUpdated = 0;
  let lastRowAt = Date.now();
  let lastSilenceLogAt = 0;

  // Resolve sourceId once. May be null on the very first run (the source
  // row is created lazily on the first ingest). Re-resolve until found.
  let sourceId = await getKajabiSourceId();

  // Heartbeat runs on its own interval — independent of the row poll —
  // so a slow Prisma read can't starve the CLI's keep-alive signal.
  let lastSentHeartbeatAt = 0;

  while (true) {
    if (Date.now() - lastSentHeartbeatAt >= HEARTBEAT_MS) {
      lastSentHeartbeatAt = Date.now();
      const hbResp = await postJson<{ session: ScrapeSession }>("/api/scrape/heartbeat");
      if (hbResp) {
        session = hbResp.session;
        lastHeartbeatAt = Date.now();
      } else if (Date.now() - lastHeartbeatAt > 10_000) {
        console.error("[scrape] lost contact with the web app for >10s; bailing");
        return 4;
      }
    }

    if (!sourceId) sourceId = await getKajabiSourceId();
    if (sourceId) {
      const rows = await fetchRowChanges(cursor, sourceId);
      for (const r of rows) {
        for (const line of formatRowLines(r)) console.log(line);
        if (r.isNew) totalNew += 1;
        else totalUpdated += 1;
      }
      if (rows.length > 0) {
        cursor = rows[rows.length - 1]!.updatedAt;
        lastRowAt = Date.now();
      }

      // Silence heartbeat: every ~5s with no new rows, print a single
      // line including the content script's last reported phase so the
      // user can tell whether we're stuck scrolling vs grinding through
      // a thread vs something else.
      if (
        session.status === "running" &&
        Date.now() - lastRowAt > SILENCE_HEARTBEAT_MS &&
        Date.now() - lastSilenceLogAt > SILENCE_HEARTBEAT_MS
      ) {
        const total = await totalRows(sourceId);
        const elapsed = Math.round((Date.now() - lastRowAt) / 1000);
        const phase = session.phase ?? "(no phase reported)";
        console.log(`  · still working… (${elapsed}s, ${total} in DB) [${phase}]`);
        lastSilenceLogAt = Date.now();
      }
    }

    if (session.status !== lastStatus) {
      console.log(`  · status: ${lastStatus} → ${session.status}`);
      lastStatus = session.status;
    }

    if (isTerminalStatus(session.status)) break;
    await sleep(POLL_MS);
  }

  // One last drain after status went terminal — the SW's flushAndDrain
  // may have written a final batch right before reporting done.
  if (sourceId) {
    const tail = await fetchRowChanges(cursor, sourceId);
    for (const r of tail) {
      for (const line of formatRowLines(r)) console.log(line);
      if (r.isNew) totalNew += 1;
      else totalUpdated += 1;
    }
  }

  const total = sourceId ? await totalRows(sourceId) : 0;
  stopCaffeinate();
  console.log("");
  switch (session.status) {
    case "done":
      console.log(
        `[scrape] done. ${totalNew} new post${totalNew === 1 ? "" : "s"}, ${totalUpdated} updated. ${total} total in DB.`,
      );
      return 0;
    case "canceled":
      console.log(
        `[scrape] canceled. reason=${session.failReason ?? "(unspecified)"}. ${totalNew} new, ${totalUpdated} updated before stop.`,
      );
      return 130;
    case "failed":
      console.error(
        `[scrape] failed. reason=${session.failReason ?? "(unspecified)"}` +
          (session.errorMessage ? ` — ${session.errorMessage}` : ""),
      );
      return 1;
    default:
      return 0;
  }
}

const HELP = `usage: pnpm scrape

  Starts a Kajabi feed scrape and stays attached, printing progress, until
  the extension reports done. Press ctrl-c to cancel.

env:
  RB_SCRAPE_ENDPOINT    web-app origin (default http://localhost:3001)
`;

async function main(): Promise<void> {
  const [, , subcommand] = process.argv;
  let code = 0;
  try {
    if (subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
      process.stdout.write(HELP);
    } else if (subcommand === undefined || subcommand === "feed") {
      // Accept `feed` for muscle-memory; it's a no-op alias for the bare command.
      code = await cmdFeed();
    } else {
      console.error(`unknown subcommand: ${subcommand}\n`);
      process.stdout.write(HELP);
      code = 2;
    }
  } finally {
    await prisma.$disconnect();
  }
  process.exit(code);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
