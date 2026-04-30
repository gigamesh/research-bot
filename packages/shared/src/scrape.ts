import { z } from "zod";

/**
 * Wire format for the CLI ↔ web ↔ extension scrape-session control loop.
 *
 * Lifecycle:
 *   CLI:  POST /api/scrape/start          → status=running
 *         loop {
 *           POST /api/scrape/heartbeat    → lastHeartbeat=now
 *           GET  /api/scrape/current      → fetch state, print delta
 *         } until status is terminal
 *   On SIGINT / Ctrl-C:
 *         POST /api/scrape/cancel         → status=canceled
 *
 * Service worker:
 *   loop {
 *     GET /api/scrape/current
 *     if status=running and tab not driven → open managed tab → feed URL
 *     if status=running and now-lastHeartbeat > 5s → POST /api/scrape/cancel
 *       (CLI died, watchdog kicks in)
 *     if status=canceled → close the managed tab
 *   }
 *
 * Content script (managed tab):
 *   On completion:    chrome.runtime.sendMessage({ type: "kajabi:complete" })
 *     → SW drains its ingest queue, then POSTs /api/scrape/complete
 *   On failure:       sendMessage({ type: "kajabi:fail", reason, error })
 *     → SW POSTs /api/scrape/fail
 */

export const ScrapeStatusSchema = z.enum([
  "idle",
  "running",
  "done",
  "canceled",
  "failed",
]);
export type ScrapeStatus = z.infer<typeof ScrapeStatusSchema>;

export const ScrapeFailReasonSchema = z.enum([
  "captcha",
  "login_redirect",
  "rate_limit",
  "selector_drift",
  "timeout",
  "navigation_error",
  "cli-died",
  "other",
]);
export type ScrapeFailReason = z.infer<typeof ScrapeFailReasonSchema>;

const BOT_PROTECTION: ReadonlySet<ScrapeFailReason> = new Set([
  "captcha",
  "login_redirect",
  "rate_limit",
]);

export function isBotProtectionReason(reason: ScrapeFailReason): boolean {
  return BOT_PROTECTION.has(reason);
}

/// Snapshot of the singleton session row sent to the CLI and the SW. The
/// CLI uses `lastHeartbeat` only on cancel-confirmation paths; the SW uses
/// it as a watchdog input.
export const ScrapeSessionSchema = z.object({
  id: z.string(),
  status: ScrapeStatusSchema,
  kind: z.string(),
  startedAt: z.string().datetime().nullable(),
  finishedAt: z.string().datetime().nullable(),
  lastHeartbeat: z.string().datetime().nullable(),
  failReason: ScrapeFailReasonSchema.nullable(),
  errorMessage: z.string().nullable(),
  /// Last phase string reported by the content script. Free-form so the
  /// scraper can describe whatever it's doing without us having to keep
  /// the wire schema and the script's vocabulary in sync.
  phase: z.string().nullable(),
});
export type ScrapeSession = z.infer<typeof ScrapeSessionSchema>;

export const ScrapePhaseRequestSchema = z.object({
  phase: z.string().min(1).max(200),
});
export type ScrapePhaseRequest = z.infer<typeof ScrapePhaseRequestSchema>;

/// CLI → server. The CLI sends this after creating the session and again
/// every ~1s. The server updates `lastHeartbeat=now` and returns the
/// fresh session snapshot in one round-trip.
export const ScrapeHeartbeatRequestSchema = z.object({});
export type ScrapeHeartbeatRequest = z.infer<typeof ScrapeHeartbeatRequestSchema>;

/// Content script (via SW) → server when feed scrape finishes cleanly.
export const ScrapeCompleteRequestSchema = z.object({
  postsCaptured: z.number().int().nonnegative(),
});
export type ScrapeCompleteRequest = z.infer<typeof ScrapeCompleteRequestSchema>;

/// Content script (via SW) → server when scrape hits a wall.
export const ScrapeFailRequestSchema = z.object({
  reason: ScrapeFailReasonSchema,
  error: z.string().max(2000).optional(),
});
export type ScrapeFailRequest = z.infer<typeof ScrapeFailRequestSchema>;

export function isTerminalStatus(s: ScrapeStatus): boolean {
  return s === "done" || s === "canceled" || s === "failed";
}
