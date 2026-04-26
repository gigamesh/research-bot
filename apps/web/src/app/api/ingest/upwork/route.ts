import { NextResponse } from "next/server";
import {
  IngestPayloadSchema,
  formatUpworkBodyPrefix,
  type UpworkJobItem,
} from "@research-bot/shared";
import { prisma } from "@/lib/db";
import { ensureSource } from "@/lib/source";

export const dynamic = "force-dynamic";

const ALLOWED_ORIGIN = "https://www.upwork.com";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
  Vary: "Origin",
};

export async function OPTIONS(): Promise<Response> {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

/// detail-page captures replace search/feed captures because they carry the full
/// description, client stats, and screening questions. Higher rank wins.
function captureRank(capturedFrom: UpworkJobItem["capturedFrom"]): number {
  return capturedFrom === "job-detail" ? 2 : 1;
}

function buildBody(item: UpworkJobItem): string {
  const prefix = formatUpworkBodyPrefix(item);
  return prefix ? `${prefix}\n\n${item.body}` : item.body;
}

export async function POST(request: Request): Promise<Response> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json(
      { error: "invalid json" },
      { status: 400, headers: CORS_HEADERS },
    );
  }

  const parsed = IngestPayloadSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid payload", issues: parsed.error.issues },
      { status: 400, headers: CORS_HEADERS },
    );
  }

  const sourceId = await ensureSource("upwork", {
    capturedVia: "chrome-extension",
    passive: true,
  });

  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const item of parsed.data.items) {
    const existing = await prisma.rawPost.findUnique({
      where: { sourceId_externalId: { sourceId, externalId: item.externalId } },
      select: { id: true, rawJson: true },
    });

    const body = buildBody(item);
    const rawJson = JSON.stringify(item);
    const postedAt = item.postedAt ? new Date(item.postedAt) : null;

    if (!existing) {
      await prisma.rawPost.create({
        data: {
          sourceId,
          externalId: item.externalId,
          url: item.url,
          title: item.title,
          body,
          postedAt,
          rawJson,
        },
      });
      created += 1;
      continue;
    }

    const existingFrom = readCapturedFrom(existing.rawJson);
    if (existingFrom && captureRank(existingFrom) >= captureRank(item.capturedFrom)) {
      skipped += 1;
      continue;
    }

    await prisma.rawPost.update({
      where: { id: existing.id },
      data: {
        url: item.url,
        title: item.title,
        body,
        postedAt: postedAt ?? undefined,
        rawJson,
        // Reset processedAt so the signals stage re-evaluates the richer body.
        processedAt: null,
      },
    });
    updated += 1;
  }

  return NextResponse.json(
    { created, updated, skipped },
    { status: 200, headers: CORS_HEADERS },
  );
}

function readCapturedFrom(rawJson: string | null): UpworkJobItem["capturedFrom"] | null {
  if (!rawJson) return null;
  try {
    const parsed = JSON.parse(rawJson) as { capturedFrom?: string };
    if (parsed.capturedFrom === "job-detail" || parsed.capturedFrom === "job-search" || parsed.capturedFrom === "category-feed") {
      return parsed.capturedFrom;
    }
    return null;
  } catch {
    return null;
  }
}
