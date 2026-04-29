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
import { buildSearchUrl } from "@/lib/upwork-search";
import { getPreset, listPresets } from "./crawl-presets";
import { getFilterRecipe, listFilterRecipes } from "./crawl-filters";
import type { ApplyFiltersPayload } from "@research-bot/shared";

const FILTER_TARGET_URL = "https://www.upwork.com/nx/find-work/best-matches";

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

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/// Live-stream queue progress to the terminal until the jobs the caller just
/// enqueued (and any auto-spawned children) are all terminal. Runs entirely
/// off the local SQLite DB — no network round-trips.
///
/// Exit conditions:
///   - all tracked jobs are `done` or `failed`
///   - the crawler is paused (printed loudly so the user knows to resume)
///   - Ctrl-C (default Node SIGINT) — leaves jobs running in the background
async function streamProgress(startedAt: Date): Promise<void> {
  const seen = new Map<string, string>();

  const initial = await prisma.crawlJob.findMany({
    where: { enqueuedAt: { gte: startedAt } },
    orderBy: { enqueuedAt: "asc" },
    select: { id: true, kind: true, url: true, preset: true, status: true },
  });
  if (initial.length === 0) return;

  console.log("");
  for (const j of initial) {
    const tag = j.preset ? ` [${j.preset}]` : "";
    console.log(`  + ${j.kind.padEnd(13)} ${j.id.slice(0, 8)}${tag}  ${truncate(j.url, 80)}`);
    seen.set(j.id, j.status);
  }
  console.log("");
  console.log("  watching queue (ctrl-c to detach; jobs keep running)");
  console.log("");

  while (true) {
    await sleep(1000);

    const ids = [...seen.keys()];
    const jobs = await prisma.crawlJob.findMany({
      where: {
        OR: [
          { enqueuedAt: { gte: startedAt } },
          { parentId: { in: ids } },
        ],
      },
      orderBy: { enqueuedAt: "asc" },
      select: {
        id: true, kind: true, url: true, preset: true, status: true, parentId: true,
        attempts: true, itemsCaptured: true, errorReason: true, error: true,
      },
    });

    for (const j of jobs) {
      const prev = seen.get(j.id);
      if (prev === j.status) continue;
      seen.set(j.id, j.status);
      const tag = j.kind.padEnd(13);
      const id = j.id.slice(0, 8);
      if (!prev) {
        const parent = j.parentId ? ` (child of ${j.parentId.slice(0, 8)})` : "";
        console.log(`  + ${tag} ${id}${parent}  ${truncate(j.url, 80)}`);
      } else if (j.status === "running") {
        const att = j.attempts > 1 ? ` (attempt ${j.attempts})` : "";
        console.log(`  > ${tag} ${id} running${att}`);
      } else if (j.status === "done") {
        const items = j.itemsCaptured != null ? ` items=${j.itemsCaptured}` : "";
        console.log(`  v ${tag} ${id} done${items}`);
      } else if (j.status === "failed") {
        console.log(`  x ${tag} ${id} FAILED  reason=${j.errorReason ?? "unknown"}`);
        if (j.error) {
          for (const line of wrap(j.error, 96)) console.log(`     | ${line}`);
        }
      } else if (j.status === "pending" && prev === "running") {
        console.log(`  ~ ${tag} ${id} lease expired, requeued`);
      }
    }

    const cfg = await prisma.crawlConfig.findUnique({ where: { id: "singleton" } });
    if (cfg?.paused) {
      console.log("");
      console.log(`  !! crawler paused: ${cfg.pauseReason ?? "(no reason)"}`);
      console.log(`     resume with: pnpm crawl resume`);
      break;
    }

    const remaining = jobs.filter(
      (j) => j.status === "pending" || j.status === "running",
    ).length;
    if (jobs.length > 0 && remaining === 0) break;
  }

  const final = await prisma.crawlJob.findMany({
    where: { id: { in: [...seen.keys()] } },
    select: { status: true },
  });
  const done = final.filter((j) => j.status === "done").length;
  const failed = final.filter((j) => j.status === "failed").length;
  const open = final.filter((j) => j.status === "pending" || j.status === "running").length;
  console.log("");
  console.log(
    `  summary: ${done} done, ${failed} failed${open > 0 ? `, ${open} still open` : ""}`,
  );
}

/// Wrap a long error string into width-bounded lines for terminal output.
function wrap(s: string, width: number): string[] {
  const out: string[] = [];
  const collapsed = s.replace(/\s+/g, " ").trim();
  for (let i = 0; i < collapsed.length; i += width) {
    out.push(collapsed.slice(i, i + width));
    if (out.length >= 4) {
      out[out.length - 1] += " …";
      break;
    }
  }
  return out;
}

function takeOption(args: string[], name: string): string | null {
  const i = args.indexOf(name);
  if (i < 0) return null;
  const value = args[i + 1] ?? null;
  args.splice(i, 2);
  return value;
}

/// Pull `--filter <recipe>` out of args and, if present, enqueue an
/// apply-filters job. Earlier `enqueuedAt` means it'll be claimed before any
/// crawl jobs the caller is about to enqueue, so the dialog gets configured
/// before the harvest starts. Returns the recipe name (for logging) or null.
async function maybePrependFilterJob(args: string[]): Promise<string | null> {
  const name = takeOption(args, "--filter");
  if (!name) return null;
  const recipe = getFilterRecipe(name);
  if (!recipe) {
    console.error(`unknown filter recipe: ${name}`);
    console.error(`available: ${listFilterRecipes().map((r) => r.name).join(", ")}`);
    process.exit(2);
  }
  await ensureConfig();
  const payload: ApplyFiltersPayload = { recipe: recipe.name, spec: recipe.spec };
  await prisma.crawlJob.create({
    data: {
      kind: "apply-filters",
      url: FILTER_TARGET_URL,
      payload: JSON.stringify(payload),
      expandToDetail: false,
      preset: `filters:${recipe.name}`,
    },
  });
  return recipe.name;
}

async function cmdSearch(args: string[]): Promise<void> {
  const noWait = takeFlag(args, "--no-wait");
  const startedAt = new Date();
  const filterApplied = await maybePrependFilterJob(args);
  const noExpand = takeFlag(args, "--no-expand-detail");
  const pagesRaw = takeOption(args, "--pages") ?? "1";
  const pages = Math.max(1, Math.min(20, Number(pagesRaw) || 1));
  const query = args.join(" ").trim();
  if (!query) {
    console.error("usage: pnpm crawl search \"<query>\" [--pages N] [--filter <recipe>] [--no-expand-detail] [--no-wait]");
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
  const filterPrefix = filterApplied ? `filter "${filterApplied}" + ` : "";
  console.log(`enqueued ${filterPrefix}${created.length} search-page job(s) for "${query}" (pages 1..${pages}, expandToDetail=${!noExpand})`);
  if (!noWait) await streamProgress(startedAt);
}

async function cmdUrl(args: string[]): Promise<void> {
  const noWait = takeFlag(args, "--no-wait");
  const startedAt = new Date();
  const filterApplied = await maybePrependFilterJob(args);
  const noExpand = takeFlag(args, "--no-expand-detail");
  const url = args[0];
  if (!url) {
    console.error("usage: pnpm crawl url <url> [--filter <recipe>] [--no-expand-detail] [--no-wait]");
    process.exit(2);
  }
  await ensureConfig();
  const kind = classifyUrl(url);
  const row = await prisma.crawlJob.create({
    data: { kind, url, expandToDetail: !noExpand },
  });
  const filterPrefix = filterApplied ? `filter "${filterApplied}" + ` : "";
  console.log(`enqueued ${filterPrefix}${kind} job ${row.id.slice(0, 8)} → ${url}`);
  if (!noWait) await streamProgress(startedAt);
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
        id: true, kind: true, status: true, url: true, preset: true,
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
      const preset = j.preset ? ` [${j.preset}]` : "";
      console.log(`  ${tag} ${j.kind.padEnd(13)} ${j.id.slice(0, 8)}${preset} ${j.url.slice(0, 90)}${captured}${err}`);
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

async function cmdPreset(args: string[]): Promise<void> {
  const sub = args.shift();

  if (sub === "list" || sub === undefined) {
    const presets = listPresets();
    console.log(`available presets (${presets.length}):\n`);
    for (const p of presets) {
      const size = p.kind === "search" ? `${p.terms.length} terms` : `${p.urls.length} urls`;
      console.log(`  ${p.name}  [${p.kind}, ${size}]`);
      console.log(`    ${p.description}`);
      console.log("");
    }
    console.log(`use: pnpm crawl preset <name> [--pages N] [--filter <recipe>] [--no-expand-detail]`);
    return;
  }

  const preset = getPreset(sub);
  if (!preset) {
    console.error(`unknown preset: ${sub}`);
    console.error(`available: ${listPresets().map((p) => p.name).join(", ")}`);
    process.exit(2);
  }

  const noWait = takeFlag(args, "--no-wait");
  const startedAt = new Date();
  const filterApplied = await maybePrependFilterJob(args);
  const noExpand = takeFlag(args, "--no-expand-detail");
  const pagesRaw = takeOption(args, "--pages") ?? "1";
  const pages = Math.max(1, Math.min(20, Number(pagesRaw) || 1));

  await ensureConfig();

  let created = 0;
  const filterPrefix = filterApplied ? `filter "${filterApplied}" + ` : "";
  if (preset.kind === "search") {
    for (const term of preset.terms) {
      for (let p = 1; p <= pages; p += 1) {
        const url = buildSearchUrl(term, p);
        await prisma.crawlJob.create({
          data: {
            kind: "search-page",
            url,
            expandToDetail: !noExpand,
            preset: preset.name,
          },
        });
        created += 1;
      }
    }
    console.log(
      `enqueued ${filterPrefix}${created} search-page job(s) for preset "${preset.name}"\n` +
        `  terms: ${preset.terms.length}  pages each: ${pages}  expandToDetail: ${!noExpand}`,
    );
  } else {
    // urls preset — pages is ignored (find-work feeds use infinite scroll, not ?page=N)
    if (pagesRaw !== "1") {
      console.warn(`note: --pages ignored for url presets (use scroll-to-load instead)`);
    }
    for (const url of preset.urls) {
      await prisma.crawlJob.create({
        data: {
          kind: "category-feed",
          url,
          expandToDetail: !noExpand,
          preset: preset.name,
        },
      });
      created += 1;
    }
    console.log(
      `enqueued ${filterPrefix}${created} category-feed job(s) for preset "${preset.name}"\n` +
        `  urls: ${preset.urls.length}  expandToDetail: ${!noExpand}`,
    );
  }
  if (!noWait) await streamProgress(startedAt);
}

async function cmdFilters(args: string[]): Promise<void> {
  const sub = args.shift();

  if (sub === "list" || sub === undefined) {
    const recipes = listFilterRecipes();
    console.log(`available filter recipes (${recipes.length}):\n`);
    for (const r of recipes) {
      console.log(`  ${r.name}`);
      console.log(`    ${r.description}`);
      console.log("");
    }
    console.log("use: pnpm crawl filters apply <name>");
    console.log("     pnpm crawl filters show <name>");
    return;
  }

  if (sub === "show") {
    const name = args[0];
    const recipe = name ? getFilterRecipe(name) : null;
    if (!recipe) {
      console.error(`unknown recipe: ${name ?? "(missing)"}`);
      console.error(`available: ${listFilterRecipes().map((r) => r.name).join(", ")}`);
      process.exit(2);
    }
    console.log(`# ${recipe.name}`);
    console.log(`# ${recipe.description}`);
    console.log(JSON.stringify(recipe.spec, null, 2));
    return;
  }

  if (sub === "apply") {
    const argsRest = args.slice();
    const noWait = takeFlag(argsRest, "--no-wait");
    const startedAt = new Date();
    const name = argsRest[0];
    const recipe = name ? getFilterRecipe(name) : null;
    if (!recipe) {
      console.error(`unknown recipe: ${name ?? "(missing)"}`);
      console.error(`available: ${listFilterRecipes().map((r) => r.name).join(", ")}`);
      process.exit(2);
    }
    await ensureConfig();
    const payload: ApplyFiltersPayload = { recipe: recipe.name, spec: recipe.spec };
    const row = await prisma.crawlJob.create({
      data: {
        kind: "apply-filters",
        url: FILTER_TARGET_URL,
        payload: JSON.stringify(payload),
        expandToDetail: false,
        preset: `filters:${recipe.name}`,
      },
    });
    console.log(`enqueued apply-filters job ${row.id.slice(0, 8)} for recipe "${recipe.name}"`);
    if (!noWait) await streamProgress(startedAt);
    return;
  }

  console.error(`unknown filters subcommand: ${sub}`);
  console.error(`use: pnpm crawl filters [list|apply <name>|show <name>]`);
  process.exit(2);
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

  preset list                                         show curated search strategies
  preset <name> [--pages N] [--filter <recipe>] [--no-expand-detail] [--no-wait]
                                                      run a curated strategy (recommended)
  filters list                                        show named filter recipes
  filters show <name>                                 print a recipe's resolved FilterSpec
  filters apply <name> [--no-wait]                    set Upwork account filters via the dialog
  search "<query>" [--pages N] [--filter <recipe>] [--no-expand-detail] [--no-wait]
                                                      enqueue N search-page jobs for a free-text query
  url <url> [--filter <recipe>] [--no-expand-detail] [--no-wait]
                                                      enqueue a single URL job

  By default the enqueueing commands stream live progress to the terminal
  until the work drains. Pass --no-wait to detach immediately.
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
      case "preset":      await cmdPreset(rest); break;
      case "filters":     await cmdFilters(rest); break;
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
