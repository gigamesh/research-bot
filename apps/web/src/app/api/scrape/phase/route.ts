import { NextResponse } from "next/server";
import { ScrapePhaseRequestSchema } from "@research-bot/shared";
import { SCRAPE_CORS, setPhase } from "@/lib/scrape-session";

export const dynamic = "force-dynamic";

export async function OPTIONS(): Promise<Response> {
  return new Response(null, { status: 204, headers: SCRAPE_CORS });
}

/// Content script (via SW) → server. Updates the live "phase" string
/// shown in the CLI heartbeat so the user can see what the scraper is
/// currently doing without opening DevTools.
export async function POST(request: Request): Promise<Response> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400, headers: SCRAPE_CORS });
  }
  const parsed = ScrapePhaseRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid payload", issues: parsed.error.issues },
      { status: 400, headers: SCRAPE_CORS },
    );
  }
  const session = await setPhase(parsed.data.phase);
  return NextResponse.json({ session }, { headers: SCRAPE_CORS });
}
