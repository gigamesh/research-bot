import type { IngestPayload, IngestResponse } from "@research-bot/shared";

export type PostResult =
  | { ok: true; response: IngestResponse }
  | { ok: false; status: number; message: string; retriable: boolean };

/// POST a batch of Upwork items to the local web app's ingest endpoint.
/// 5xx and network errors are retriable; 4xx errors are not.
export async function postBatch(
  endpoint: string,
  payload: IngestPayload,
): Promise<PostResult> {
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (res.ok) {
      const body = (await res.json()) as IngestResponse;
      return { ok: true, response: body };
    }

    const message = await res.text().catch(() => res.statusText);
    return {
      ok: false,
      status: res.status,
      message,
      retriable: res.status >= 500 || res.status === 0,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      message: (err as Error).message,
      retriable: true,
    };
  }
}
