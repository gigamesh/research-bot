import {
  CrawlNextResponseSchema,
  type CrawlNextResponse,
  type CrawlDoneRequest,
  type CrawlDoneResponse,
  type CrawlFailRequest,
  type CrawlFailResponse,
} from "@research-bot/shared";

/// Resolve the base URL of the local web app from the configured ingest endpoint
/// so we don't store a second URL. Strips trailing path so /api/crawl/* lines up.
function originFromIngestEndpoint(ingest: string): string {
  try {
    return new URL(ingest).origin;
  } catch {
    return "http://localhost:3000";
  }
}

export async function fetchNext(ingestEndpoint: string): Promise<CrawlNextResponse | null> {
  const origin = originFromIngestEndpoint(ingestEndpoint);
  try {
    const res = await fetch(`${origin}/api/crawl/next`, { method: "GET" });
    if (!res.ok) return null;
    const body = await res.json();
    const parsed = CrawlNextResponseSchema.safeParse(body);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function reportDone(
  ingestEndpoint: string,
  jobId: string,
  payload: CrawlDoneRequest,
): Promise<CrawlDoneResponse | null> {
  const origin = originFromIngestEndpoint(ingestEndpoint);
  try {
    const res = await fetch(`${origin}/api/crawl/jobs/${encodeURIComponent(jobId)}/done`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) return null;
    return (await res.json()) as CrawlDoneResponse;
  } catch {
    return null;
  }
}

export async function reportFail(
  ingestEndpoint: string,
  jobId: string,
  payload: CrawlFailRequest,
): Promise<CrawlFailResponse | null> {
  const origin = originFromIngestEndpoint(ingestEndpoint);
  try {
    const res = await fetch(`${origin}/api/crawl/jobs/${encodeURIComponent(jobId)}/fail`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) return null;
    return (await res.json()) as CrawlFailResponse;
  } catch {
    return null;
  }
}
