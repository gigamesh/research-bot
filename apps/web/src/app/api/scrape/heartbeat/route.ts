import { NextResponse } from "next/server";
import { SCRAPE_CORS, heartbeat } from "@/lib/scrape-session";

export const dynamic = "force-dynamic";

export async function OPTIONS(): Promise<Response> {
  return new Response(null, { status: 204, headers: SCRAPE_CORS });
}

/// CLI heartbeat. Updates `lastHeartbeat=now` and returns the fresh session
/// snapshot (so the CLI gets state changes in the same round-trip and
/// doesn't need a separate GET).
export async function POST(): Promise<Response> {
  const session = await heartbeat();
  return NextResponse.json({ session }, { headers: SCRAPE_CORS });
}
