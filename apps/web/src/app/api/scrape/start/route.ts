import { NextResponse } from "next/server";
import { SCRAPE_CORS, startSession } from "@/lib/scrape-session";

export const dynamic = "force-dynamic";

export async function OPTIONS(): Promise<Response> {
  return new Response(null, { status: 204, headers: SCRAPE_CORS });
}

/// Idempotently (re-)start a scrape session. Replaces any prior state — the
/// caller (the CLI) is the lifecycle owner, so an explicit start always
/// wins. Returns the fresh session snapshot.
export async function POST(): Promise<Response> {
  const session = await startSession("feed");
  console.log(`[scrape] start session=${session.startedAt}`);
  return NextResponse.json({ session }, { headers: SCRAPE_CORS });
}
