import {
  ScrapeSessionSchema,
  type ScrapeFailReason,
  type ScrapeSession,
} from "@research-bot/shared";

/// Resolve the base origin of the web app from the configured ingest
/// endpoint so we don't store a second URL.
function originFromIngestEndpoint(ingest: string): string {
  try {
    return new URL(ingest).origin;
  } catch {
    return "http://localhost:3001";
  }
}

export async function fetchCurrent(ingestEndpoint: string): Promise<ScrapeSession | null> {
  const origin = originFromIngestEndpoint(ingestEndpoint);
  try {
    const res = await fetch(`${origin}/api/scrape/current`, { method: "GET" });
    if (!res.ok) return null;
    const body = (await res.json()) as { session?: unknown };
    const parsed = ScrapeSessionSchema.safeParse(body.session);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function reportComplete(
  ingestEndpoint: string,
  postsCaptured: number,
): Promise<ScrapeSession | null> {
  const origin = originFromIngestEndpoint(ingestEndpoint);
  try {
    const res = await fetch(`${origin}/api/scrape/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ postsCaptured }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { session?: unknown };
    const parsed = ScrapeSessionSchema.safeParse(body.session);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function reportFail(
  ingestEndpoint: string,
  reason: ScrapeFailReason,
  error?: string,
): Promise<ScrapeSession | null> {
  const origin = originFromIngestEndpoint(ingestEndpoint);
  try {
    const res = await fetch(`${origin}/api/scrape/fail`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason, error }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { session?: unknown };
    const parsed = ScrapeSessionSchema.safeParse(body.session);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function postCancel(
  ingestEndpoint: string,
  reason: ScrapeFailReason,
  error?: string,
): Promise<void> {
  const origin = originFromIngestEndpoint(ingestEndpoint);
  try {
    await fetch(`${origin}/api/scrape/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason, error }),
    });
  } catch {
    /* swallow */
  }
}

export async function postPhase(
  ingestEndpoint: string,
  phase: string,
): Promise<void> {
  const origin = originFromIngestEndpoint(ingestEndpoint);
  try {
    await fetch(`${origin}/api/scrape/phase`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phase }),
    });
  } catch {
    /* swallow */
  }
}
