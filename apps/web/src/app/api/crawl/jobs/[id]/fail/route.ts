import { NextResponse } from "next/server";
import {
  CrawlFailRequestSchema,
  isBotProtectionReason,
  type CrawlFailResponse,
} from "@research-bot/shared";
import { prisma } from "@/lib/db";
import { CRAWL_CORS } from "@/lib/crawl";

export const dynamic = "force-dynamic";

export async function OPTIONS(): Promise<Response> {
  return new Response(null, { status: 204, headers: CRAWL_CORS });
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400, headers: CRAWL_CORS });
  }
  const parsed = CrawlFailRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid payload", issues: parsed.error.issues },
      { status: 400, headers: CRAWL_CORS },
    );
  }

  const job = await prisma.crawlJob.findUnique({ where: { id } });
  if (!job) {
    return NextResponse.json({ error: "not found" }, { status: 404, headers: CRAWL_CORS });
  }

  await prisma.crawlJob.update({
    where: { id },
    data: {
      status: "failed",
      finishedAt: new Date(),
      error: parsed.data.error ?? null,
      errorReason: parsed.data.reason,
    },
  });

  // Bot-protection signals trigger a global pause so the user can intervene
  // (re-login, complete a CAPTCHA in the managed tab, then `pnpm crawl resume`).
  if (isBotProtectionReason(parsed.data.reason)) {
    await prisma.crawlConfig.upsert({
      where: { id: "singleton" },
      create: {
        id: "singleton",
        paused: true,
        pauseReason: `auto: ${parsed.data.reason}`,
      },
      update: { paused: true, pauseReason: `auto: ${parsed.data.reason}` },
    });
    return NextResponse.json<CrawlFailResponse>(
      { paused: true, pauseReason: `auto: ${parsed.data.reason}` },
      { headers: CRAWL_CORS },
    );
  }

  const cfg = await prisma.crawlConfig.findUnique({ where: { id: "singleton" } });
  return NextResponse.json<CrawlFailResponse>(
    { paused: cfg?.paused ?? false, pauseReason: cfg?.pauseReason ?? null },
    { headers: CRAWL_CORS },
  );
}
