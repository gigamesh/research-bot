import { NextResponse } from "next/server";
import {
  KajabiIngestPayloadSchema,
  flattenCommentsForBody,
  commentThreadFingerprint,
  type KajabiPostItem,
} from "@research-bot/shared";
import { prisma } from "@/lib/db";
import { ensureSource } from "@/lib/source";

export const dynamic = "force-dynamic";

const ALLOWED_ORIGIN = "https://www.shannonjean.info";

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

const SOURCE_NAME = "kajabi-shannonjean";

/// Single-line title derived from the post body. Kajabi posts have no title
/// field; we keep the first ~80 chars of the visible body so the dashboard
/// has something readable above the score.
function buildTitle(item: KajabiPostItem): string {
  const compact = item.bodyText.replace(/\s+/g, " ").trim();
  if (compact.length <= 80) return compact || "(no body)";
  return `${compact.slice(0, 79)}…`;
}

/// `body` is what the signals stage feeds to Claude. Concatenate post text
/// and the depth-first-flattened comment thread so the model sees the whole
/// conversation in one shot.
function buildBody(item: KajabiPostItem): string {
  const post = item.bodyText.trim();
  const author = item.author.name;
  const head = `[${author}] ${post}`;
  if (item.comments.length === 0) return head;
  const thread = flattenCommentsForBody(item);
  return `${head}\n\n--- comments ---\n\n${thread}`;
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

  const parsed = KajabiIngestPayloadSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid payload", issues: parsed.error.issues },
      { status: 400, headers: CORS_HEADERS },
    );
  }

  const sourceId = await ensureSource(SOURCE_NAME, {
    capturedVia: "chrome-extension",
    site: "shannonjean.info",
  });

  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const item of parsed.data.items) {
    const existing = await prisma.rawPost.findUnique({
      where: { sourceId_externalId: { sourceId, externalId: item.uuid } },
      select: { id: true, rawJson: true },
    });

    const body = buildBody(item);
    const title = buildTitle(item);
    const rawJson = JSON.stringify(item);
    const postedAt = item.postedAt ? new Date(item.postedAt) : null;

    if (!existing) {
      await prisma.rawPost.create({
        data: {
          sourceId,
          externalId: item.uuid,
          url: item.url,
          author: item.author.name,
          postedAt,
          title,
          body,
          rawJson,
        },
      });
      created += 1;
      continue;
    }

    // Re-scrape comparison: only reset processedAt + overwrite the body when
    // the conversation has actually changed. Otherwise this is a no-op visit
    // that costs us nothing on the signals stage.
    const oldFingerprint = readFingerprint(existing.rawJson);
    const newFingerprint = commentThreadFingerprint(item);
    if (oldFingerprint === newFingerprint) {
      skipped += 1;
      continue;
    }

    await prisma.rawPost.update({
      where: { id: existing.id },
      data: {
        url: item.url,
        author: item.author.name,
        title,
        body,
        postedAt: postedAt ?? undefined,
        rawJson,
        // New comments arrived → re-extract signals.
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

function readFingerprint(rawJson: string | null): string | null {
  if (!rawJson) return null;
  try {
    const parsed = JSON.parse(rawJson) as KajabiPostItem;
    if (!parsed || typeof parsed !== "object") return null;
    return commentThreadFingerprint(parsed);
  } catch {
    return null;
  }
}
