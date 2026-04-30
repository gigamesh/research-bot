import { NextResponse } from "next/server";
import {
  ensureSession,
  HEARTBEAT_STALE_MS,
  SCRAPE_CORS,
  setStatus,
} from "@/lib/scrape-session";

export const dynamic = "force-dynamic";

export async function OPTIONS(): Promise<Response> {
  return new Response(null, { status: 204, headers: SCRAPE_CORS });
}

/// Read-only fetch of the current session, with one side-effect: if the
/// session is `running` but `lastHeartbeat` is older than the watchdog
/// threshold, auto-cancel here. This way, even if the SW polls and
/// crashes between the read and the cancel, the next poll re-cancels —
/// idempotently.
export async function GET(): Promise<Response> {
  let session = await ensureSession();

  if (
    session.status === "running" &&
    session.lastHeartbeat &&
    Date.now() - new Date(session.lastHeartbeat).getTime() > HEARTBEAT_STALE_MS
  ) {
    console.warn(
      `[scrape] watchdog: heartbeat stale (${Math.round(
        (Date.now() - new Date(session.lastHeartbeat).getTime()) / 1000,
      )}s), auto-canceling`,
    );
    session = await setStatus("canceled", {
      failReason: "cli-died",
      errorMessage: "CLI heartbeat went stale",
    });
  }

  return NextResponse.json({ session }, { headers: SCRAPE_CORS });
}
