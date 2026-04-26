import { NextResponse } from "next/server";
import { CrawlDoneRequestSchema, type CrawlDoneResponse } from "@research-bot/shared";
import { prisma } from "@/lib/db";
import { CRAWL_CORS, spawnDetailChildren } from "@/lib/crawl";

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
  const parsed = CrawlDoneRequestSchema.safeParse(raw);
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
      status: "done",
      finishedAt: new Date(),
      itemsCaptured: parsed.data.itemsCaptured,
      error: null,
      errorReason: null,
    },
  });

  let childrenCreated = 0;
  const isListPage = job.kind === "search-page" || job.kind === "category-feed";
  if (isListPage && job.expandToDetail && parsed.data.capturedExternalIds.length > 0) {
    childrenCreated = await spawnDetailChildren(id, parsed.data.capturedExternalIds);
  }

  return NextResponse.json<CrawlDoneResponse>(
    { childrenCreated },
    { headers: CRAWL_CORS },
  );
}
