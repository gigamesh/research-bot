import { NextResponse } from "next/server";
import type { CrawlNextResponse, CrawlJobView, CrawlKind } from "@research-bot/shared";
import { CRAWL_CORS, claimNextJob, ensureCrawlConfig } from "@/lib/crawl";

export const dynamic = "force-dynamic";

export async function OPTIONS(): Promise<Response> {
  return new Response(null, { status: 204, headers: CRAWL_CORS });
}

export async function GET(): Promise<Response> {
  const cfg = await ensureCrawlConfig();
  const base = {
    paused: cfg.paused,
    pauseReason: cfg.pauseReason,
    throttleMinMs: cfg.throttleMinMs,
    throttleMaxMs: cfg.throttleMaxMs,
  };

  if (cfg.paused) {
    return NextResponse.json<CrawlNextResponse>(
      { ...base, job: null },
      { headers: CRAWL_CORS },
    );
  }

  const claimed = await claimNextJob();
  const job: CrawlJobView | null = claimed
    ? {
        id: claimed.id,
        kind: claimed.kind as CrawlKind,
        url: claimed.url,
        expandToDetail: claimed.expandToDetail,
        attempts: claimed.attempts,
        leaseUntil: (claimed.leaseUntil ?? new Date()).toISOString(),
      }
    : null;

  return NextResponse.json<CrawlNextResponse>(
    { ...base, job },
    { headers: CRAWL_CORS },
  );
}
