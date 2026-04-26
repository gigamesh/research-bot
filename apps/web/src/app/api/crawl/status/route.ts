import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { CRAWL_CORS, ensureCrawlConfig } from "@/lib/crawl";

export const dynamic = "force-dynamic";

/// Read-only crawl status. Used by the extension popup so opening the popup
/// doesn't claim jobs the way /api/crawl/next does.
export async function OPTIONS(): Promise<Response> {
  return new Response(null, { status: 204, headers: CRAWL_CORS });
}

export async function GET(): Promise<Response> {
  const cfg = await ensureCrawlConfig();
  const grouped = await prisma.crawlJob.groupBy({
    by: ["status"],
    _count: { _all: true },
  });
  const counts: Record<"pending" | "running" | "done" | "failed", number> = {
    pending: 0, running: 0, done: 0, failed: 0,
  };
  for (const row of grouped) {
    if (row.status in counts) counts[row.status as keyof typeof counts] = row._count._all;
  }
  return NextResponse.json(
    {
      paused: cfg.paused,
      pauseReason: cfg.pauseReason,
      throttleMinMs: cfg.throttleMinMs,
      throttleMaxMs: cfg.throttleMaxMs,
      counts,
    },
    { headers: CRAWL_CORS },
  );
}
