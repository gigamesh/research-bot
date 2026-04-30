import { NextResponse } from "next/server";
import { ScrapeFailRequestSchema } from "@research-bot/shared";
import { SCRAPE_CORS, setStatus } from "@/lib/scrape-session";

export const dynamic = "force-dynamic";

export async function OPTIONS(): Promise<Response> {
  return new Response(null, { status: 204, headers: SCRAPE_CORS });
}

/// Content script → SW → server when the scrape hits a wall (CAPTCHA,
/// login redirect, selector drift, etc). Marks status=failed and records
/// the reason so the CLI prints something actionable.
export async function POST(request: Request): Promise<Response> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json(
      { error: "invalid json" },
      { status: 400, headers: SCRAPE_CORS },
    );
  }
  const parsed = ScrapeFailRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid payload", issues: parsed.error.issues },
      { status: 400, headers: SCRAPE_CORS },
    );
  }

  const session = await setStatus("failed", {
    failReason: parsed.data.reason,
    errorMessage: parsed.data.error ?? null,
  });
  console.warn(
    `[scrape] FAIL reason=${parsed.data.reason}` +
      (parsed.data.error ? ` error=${parsed.data.error.slice(0, 200)}` : ""),
  );
  return NextResponse.json({ session }, { headers: SCRAPE_CORS });
}
