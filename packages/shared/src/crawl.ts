import { z } from "zod";

/**
 * Wire format for the crawl-control loop between the web app and the
 * Chrome extension's service worker. The SW polls /api/crawl/next, drives a
 * managed tab to the URL, then reports completion or failure.
 */

export const CrawlKindSchema = z.enum(["search-page", "job-detail", "category-feed"]);
export type CrawlKind = z.infer<typeof CrawlKindSchema>;

/// Shape returned to the SW for the active job slot.
export const CrawlJobViewSchema = z.object({
  id: z.string(),
  kind: CrawlKindSchema,
  url: z.string().url(),
  expandToDetail: z.boolean(),
  attempts: z.number().int().nonnegative(),
  leaseUntil: z.string().datetime(),
});
export type CrawlJobView = z.infer<typeof CrawlJobViewSchema>;

/// Polling response. Bundles config so the SW only needs one round-trip per
/// tick (saves bandwidth + keeps throttle/paused state fresh on every poll).
export const CrawlNextResponseSchema = z.object({
  paused: z.boolean(),
  pauseReason: z.string().nullable(),
  throttleMinMs: z.number().int().nonnegative(),
  throttleMaxMs: z.number().int().nonnegative(),
  job: CrawlJobViewSchema.nullable(),
});
export type CrawlNextResponse = z.infer<typeof CrawlNextResponseSchema>;

/// Reasons the SW can use when failing a job. `captcha`, `login_redirect`,
/// and `rate_limit` automatically pause the whole crawler — the user has to
/// `pnpm crawl resume` after dealing with the obstacle.
export const CrawlFailReasonSchema = z.enum([
  "captcha",
  "login_redirect",
  "rate_limit",
  "selector_drift",
  "timeout",
  "navigation_error",
  "other",
]);
export type CrawlFailReason = z.infer<typeof CrawlFailReasonSchema>;

const BOT_PROTECTION_REASONS: ReadonlySet<CrawlFailReason> = new Set([
  "captcha",
  "login_redirect",
  "rate_limit",
]);

export function isBotProtectionReason(reason: CrawlFailReason): boolean {
  return BOT_PROTECTION_REASONS.has(reason);
}

export const CrawlDoneRequestSchema = z.object({
  itemsCaptured: z.number().int().nonnegative(),
  /// External job ids captured on the page. The server uses these to spawn
  /// follow-up `job-detail` children for search-page jobs.
  capturedExternalIds: z.array(z.string()).default([]),
});
export type CrawlDoneRequest = z.infer<typeof CrawlDoneRequestSchema>;

export const CrawlDoneResponseSchema = z.object({
  childrenCreated: z.number().int().nonnegative(),
});
export type CrawlDoneResponse = z.infer<typeof CrawlDoneResponseSchema>;

export const CrawlFailRequestSchema = z.object({
  reason: CrawlFailReasonSchema,
  error: z.string().max(2000).optional(),
});
export type CrawlFailRequest = z.infer<typeof CrawlFailRequestSchema>;

export const CrawlFailResponseSchema = z.object({
  paused: z.boolean(),
  pauseReason: z.string().nullable(),
});
export type CrawlFailResponse = z.infer<typeof CrawlFailResponseSchema>;
