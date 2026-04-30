import { NextResponse } from "next/server";
import { ScrapeFailReasonSchema } from "@research-bot/shared";
import { SCRAPE_CORS, setStatus } from "@/lib/scrape-session";

export const dynamic = "force-dynamic";

export async function OPTIONS(): Promise<Response> {
  return new Response(null, { status: 204, headers: SCRAPE_CORS });
}

/// Cancel the running session. Either the CLI calls this on Ctrl-C, or the
/// SW's watchdog calls it when it notices the CLI heartbeat went stale.
/// Optional `reason`/`error` fields let the watchdog explain itself
/// (`reason=cli-died`).
export async function POST(request: Request): Promise<Response> {
  const body = await safeJson(request);
  const parsed = ScrapeFailReasonSchema.safeParse(body?.reason);
  const reason = parsed.success ? parsed.data : null;
  const error = typeof body?.error === "string" ? body.error.slice(0, 2000) : null;

  const session = await setStatus("canceled", {
    failReason: reason,
    errorMessage: error,
  });
  console.log(`[scrape] cancel reason=${reason ?? "(unspecified)"}`);
  return NextResponse.json({ session }, { headers: SCRAPE_CORS });
}

async function safeJson(request: Request): Promise<{ reason?: string; error?: string } | null> {
  try {
    return (await request.json()) as { reason?: string; error?: string };
  } catch {
    return null;
  }
}
