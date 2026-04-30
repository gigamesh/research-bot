import { NextResponse } from "next/server";
import { ScrapeCompleteRequestSchema } from "@research-bot/shared";
import { SCRAPE_CORS, setStatus } from "@/lib/scrape-session";

export const dynamic = "force-dynamic";

export async function OPTIONS(): Promise<Response> {
  return new Response(null, { status: 204, headers: SCRAPE_CORS });
}

/// Service worker → server when the content script finished its scrape
/// AND the SW finished draining its ingest queue. Marks status=done so the
/// CLI loop exits cleanly.
export async function POST(request: Request): Promise<Response> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    raw = {};
  }
  const parsed = ScrapeCompleteRequestSchema.safeParse(raw ?? {});
  const captured = parsed.success ? parsed.data.postsCaptured : 0;

  const session = await setStatus("done");
  console.log(`[scrape] complete posts=${captured}`);
  return NextResponse.json({ session }, { headers: SCRAPE_CORS });
}
