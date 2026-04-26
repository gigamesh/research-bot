/// Crawl CLI: control the Upwork crawler from the command line.
///
/// Usage:
///   pnpm crawl search "<query>" [--pages N] [--no-expand-detail]
///   pnpm crawl url <url> [--no-expand-detail]
///   pnpm crawl status [--watch]
///   pnpm crawl pause [--reason <text>]
///   pnpm crawl resume
///   pnpm crawl clear [--all | --done | --failed | --pending]
///   pnpm crawl throttle <minMs> <maxMs>
///   pnpm crawl expand-detail on|off
///
/// Writes directly to SQLite via Prisma — the extension polls the same DB
/// through /api/crawl/* endpoints, so the CLI and extension never talk to
/// each other directly.

import "dotenv/config";
import { prisma } from "@/lib/db";

type CrawlKind = "search-page" | "job-detail" | "category-feed";

const SEARCH_BASE = "https://www.upwork.com/nx/jobs/search/";

async function ensureConfig() {
  return prisma.crawlConfig.upsert({
    where: { id: "singleton" },
    create: { id: "singleton" },
    update: {},
  });
}

function classifyUrl(url: string): CrawlKind {
  try {
    const u = new URL(url);
    if (/^\/jobs\/~01/.test(u.pathname)) return "job-detail";
    if (/^\/nx\/jobs\/search/.test(u.pathname)) return "search-page";
    if (/^\/nx\/find-work|^\/ab\/find-work/.test(u.pathname)) return "category-feed";
  } catch {
    // fall through
  }
  return "search-page";
}

function takeFlag(args: string[], name: string): boolean {
  const i = args.indexOf(name);
  if (i < 0) return false;
  args.splice(i, 1);
  return true;
}

function takeOption(args: string[], name: string): string | null {
  const i = args.indexOf(name);
  if (i < 0) return null;
  const value = args[i + 1] ?? null;
  args.splice(i, 2);
  return value;
}

async function cmdSearch(args: string[]): Promise<void> {
  const noExpand = takeFlag(args, "--no-expand-detail");
  const pagesRaw = takeOption(args, "--pages") ?? "1";
  const pages = Math.max(1, Math.min(20, Number(pagesRaw) || 1));
  const query = args.join(" ").trim();
  if (!query) {
    console.error("usage: pnpm crawl search \"<query>\" [--pages N] [--no-expand-detail]");
    process.exit(2);
  }
  await ensureConfig();

  const created: string[] = [];
  for (let p = 1; p <= pages; p += 1) {
    const url = `${SEARCH_BASE}?q=${encodeURIComponent(query)}&page=${p}&per_page=50`;
    const row = await prisma.crawlJob.create({
      data: {
        kind: "search-page",
        url,
        expandToDetail: !noExpand,
      },
    });
    created.push(row.id);
  }
  console.log(`enqueued ${created.length} search-page job(s) for "${query}" (pages 1..${pages}, expandToDetail=${!noExpand})`);
}

async function cmdUrl(args: string[]): Promise<void> {
  const noExpand = takeFlag(args, "--no-expand-detail");
  const url = args[0];
  if (!url) {
    console.error("usage: pnpm crawl url <url> [--no-expand-detail]");
    process.exit(2);
  }
  await ensureConfig();
  const kind = classifyUrl(url);
  const row = await prisma.crawlJob.create({
    data: { kind, url, expandToDetail: !noExpand },
  });
  console.log(`enqueued ${kind} job ${row.id.slice(0, 8)} → ${url}`);
}

async function cmdStatus(args: string[]): Promise<void> {
  const watch = takeFlag(args, "--watch");
  do {
    const cfg = await ensureConfig();
    const counts = await prisma.crawlJob.groupBy({
      by: ["status"],
      _count: { _all: true },
    });
    const total: Record<string, number> = { pending: 0, running: 0, done: 0, failed: 0 };
    for (const row of counts) total[row.status] = row._count._all;

    const recent = await prisma.crawlJob.findMany({
      orderBy: { enqueuedAt: "desc" },
      take: 8,
      select: {
        id: true, kind: true, status: true, url: true,
        itemsCaptured: true, errorReason: true, error: true,
        startedAt: true, finishedAt: true,
      },
    });

    if (watch) console.clear();
    console.log(
      `[crawl] paused=${cfg.paused}${cfg.pauseReason ? ` (${cfg.pauseReason})` : ""}` +
      `  throttle=${cfg.throttleMinMs}..${cfg.throttleMaxMs}ms  expandDefault=${cfg.expandToDetail}`,
    );
    console.log(
      `        pending=${total.pending}  running=${total.running}  done=${total.done}  failed=${total.failed}`,
    );
    console.log("");
    for (const j of recent) {
      const tag = j.status.padEnd(7);
      const captured = j.itemsCaptured != null ? ` items=${j.itemsCaptured}` : "";
      const err = j.errorReason ? ` ⚠ ${j.errorReason}` : "";
      console.log(`  ${tag} ${j.kind.padEnd(13)} ${j.id.slice(0, 8)} ${j.url.slice(0, 90)}${captured}${err}`);
    }
    if (watch) await new Promise((r) => setTimeout(r, 2000));
  } while (watch);
}

async function cmdPause(args: string[]): Promise<void> {
  const reason = takeOption(args, "--reason") ?? "manual";
  await prisma.crawlConfig.upsert({
    where: { id: "singleton" },
    create: { id: "singleton", paused: true, pauseReason: reason },
    update: { paused: true, pauseReason: reason },
  });
  console.log(`paused (${reason})`);
}

async function cmdResume(): Promise<void> {
  await prisma.crawlConfig.upsert({
    where: { id: "singleton" },
    create: { id: "singleton", paused: false, pauseReason: null },
    update: { paused: false, pauseReason: null },
  });
  // Also expire any stale leases so jobs that were claimed by a now-gone SW
  // become claimable again.
  await prisma.crawlJob.updateMany({
    where: { status: "running", leaseUntil: { lt: new Date() } },
    data: { status: "pending", leaseUntil: null },
  });
  console.log("resumed");
}

async function cmdClear(args: string[]): Promise<void> {
  const where: Record<string, unknown> = {};
  if (takeFlag(args, "--all")) {
    // no filter
  } else if (takeFlag(args, "--done")) where.status = "done";
  else if (takeFlag(args, "--failed")) where.status = "failed";
  else if (takeFlag(args, "--pending")) where.status = "pending";
  else {
    where.status = { in: ["done", "failed"] };
  }
  const result = await prisma.crawlJob.deleteMany({ where });
  console.log(`removed ${result.count} job(s)`);
}

async function cmdThrottle(args: string[]): Promise<void> {
  const min = Number(args[0]);
  const max = Number(args[1]);
  if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max < min) {
    console.error("usage: pnpm crawl throttle <minMs> <maxMs>");
    process.exit(2);
  }
  await prisma.crawlConfig.upsert({
    where: { id: "singleton" },
    create: { id: "singleton", throttleMinMs: min, throttleMaxMs: max },
    update: { throttleMinMs: min, throttleMaxMs: max },
  });
  console.log(`throttle set to ${min}..${max} ms`);
}

async function cmdExpandDetail(args: string[]): Promise<void> {
  const v = args[0];
  if (v !== "on" && v !== "off") {
    console.error("usage: pnpm crawl expand-detail on|off");
    process.exit(2);
  }
  await prisma.crawlConfig.upsert({
    where: { id: "singleton" },
    create: { id: "singleton", expandToDetail: v === "on" },
    update: { expandToDetail: v === "on" },
  });
  console.log(`default expandToDetail=${v === "on"}`);
}

const HELP = `usage: pnpm crawl <subcommand> [...args]

  search "<query>" [--pages N] [--no-expand-detail]   enqueue N search-page jobs for a query
  url <url> [--no-expand-detail]                      enqueue a single URL job
  status [--watch]                                    show queue counts + recent jobs
  pause [--reason <text>]                             stop the crawler (extension idles)
  resume                                              resume + reset stale leases
  clear [--all|--done|--failed|--pending]             remove jobs (default: done+failed)
  throttle <minMs> <maxMs>                            set inter-page delay window
  expand-detail on|off                                set the default for new search jobs
`;

async function main(): Promise<void> {
  const [, , subcommand, ...rest] = process.argv;
  try {
    switch (subcommand) {
      case "search":      await cmdSearch(rest); break;
      case "url":         await cmdUrl(rest); break;
      case "status":      await cmdStatus(rest); break;
      case "pause":       await cmdPause(rest); break;
      case "resume":      await cmdResume(); break;
      case "clear":       await cmdClear(rest); break;
      case "throttle":    await cmdThrottle(rest); break;
      case "expand-detail": await cmdExpandDetail(rest); break;
      case undefined:
      case "help":
      case "--help":
      case "-h":
        process.stdout.write(HELP); break;
      default:
        console.error(`unknown subcommand: ${subcommand}\n`);
        process.stdout.write(HELP);
        process.exit(2);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
