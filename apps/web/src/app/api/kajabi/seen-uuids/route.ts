import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

const ALLOWED_ORIGIN = "https://www.shannonjean.info";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
  Vary: "Origin",
};

const SOURCE_NAME = "kajabi-shannonjean";

export async function OPTIONS(): Promise<Response> {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

/// Returns the set of post UUIDs we already have stored. The extension's
/// feed-scroll loop reads this on every scrape so it can stop early when it
/// hits a run of already-ingested posts (incremental scraping).
///
/// Returns an empty list (not 404) when the source row doesn't exist yet —
/// the first scrape is allowed to walk the full feed.
export async function GET(): Promise<Response> {
  const source = await prisma.source.findUnique({
    where: { name: SOURCE_NAME },
    select: { id: true },
  });
  if (!source) {
    return NextResponse.json({ uuids: [] }, { headers: CORS_HEADERS });
  }
  const rows = await prisma.rawPost.findMany({
    where: { sourceId: source.id },
    select: { externalId: true },
  });
  return NextResponse.json(
    { uuids: rows.map((r) => r.externalId) },
    { headers: CORS_HEADERS },
  );
}
