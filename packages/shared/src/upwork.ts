import { z } from "zod";

/**
 * Upwork item shapes captured by the Chrome extension.
 *
 * The extension scrapes pages the user actively browses and POSTs batches to
 * the local web app at /api/ingest/upwork. These zod schemas are the contract
 * between the extension and the web app — keep them in sync on both sides.
 */

const BudgetTypeSchema = z.enum(["fixed", "hourly"]);

/// Numeric or banded ranges seen on Upwork (some fields are exposed only as bands).
const NumericOrBandSchema = z.union([z.number(), z.string()]);

const ClientStatsSchema = z
  .object({
    country: z.string().optional(),
    totalSpent: NumericOrBandSchema.optional(),
    spentBand: z.string().optional(),
    hires: z.number().int().nonnegative().optional(),
    hireRate: z.number().min(0).max(1).optional(),
    rating: z.number().min(0).max(5).optional(),
    reviewsCount: z.number().int().nonnegative().optional(),
    paymentVerified: z.boolean().optional(),
  })
  .partial();

/// One Upwork job, captured either from a search-results card (lighter) or the
/// detail page (richer). The web app upserts on (source="upwork", externalId)
/// and the richer detail-page payload overwrites the search-card row.
export const UpworkJobItemSchema = z.object({
  /// "~01..." Upwork job id parsed from the card link / URL.
  externalId: z.string().min(3),

  /// Canonical job URL, e.g. https://www.upwork.com/jobs/~01abc...
  url: z.string().url(),

  /// Which page the parser was run from. Detail beats search beats feed at upsert time.
  capturedFrom: z.enum(["job-search", "job-detail", "category-feed"]),

  title: z.string().min(1),

  /// Full description on the detail page; short snippet on search/feed cards.
  body: z.string(),

  postedAt: z.string().datetime().optional(),

  budgetType: BudgetTypeSchema.optional(),
  budgetMin: z.number().nonnegative().optional(),
  budgetMax: z.number().nonnegative().optional(),
  budgetCurrency: z.string().default("USD"),

  proposalsBand: z.string().optional(),
  experienceLevel: z.string().optional(),
  projectLength: z.string().optional(),
  hoursPerWeek: z.string().optional(),

  skills: z.array(z.string()).default([]),
  category: z.string().optional(),

  client: ClientStatsSchema.optional(),

  screeningQuestions: z.array(z.string()).default([]),
});

export type UpworkJobItem = z.infer<typeof UpworkJobItemSchema>;
export type UpworkClientStats = z.infer<typeof ClientStatsSchema>;

export const IngestPayloadSchema = z.object({
  items: z.array(UpworkJobItemSchema).min(1).max(100),
  /// Extension-side capture timestamp; useful for debugging clock skew.
  capturedAt: z.string().datetime().optional(),
});

export type IngestPayload = z.infer<typeof IngestPayloadSchema>;

export const IngestResponseSchema = z.object({
  created: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
});

export type IngestResponse = z.infer<typeof IngestResponseSchema>;

/**
 * Build the structured prefix prepended to RawPost.body for Upwork jobs.
 * Gives the signals LLM a clean numeric handle on monetization without any
 * downstream plumbing changes.
 */
export function formatUpworkBodyPrefix(item: UpworkJobItem): string {
  const parts: string[] = [];
  if (item.budgetType) {
    const range =
      item.budgetMin !== undefined && item.budgetMax !== undefined
        ? `$${item.budgetMin}-${item.budgetMax}`
        : item.budgetMin !== undefined
          ? `$${item.budgetMin}+`
          : item.budgetMax !== undefined
            ? `up to $${item.budgetMax}`
            : "unspecified";
    parts.push(`BUDGET: ${range} ${item.budgetType}`);
  }
  const spent = item.client?.totalSpent ?? item.client?.spentBand;
  if (spent !== undefined) parts.push(`CLIENT_SPENT: ${spent}`);
  if (item.client?.hires !== undefined) parts.push(`CLIENT_HIRES: ${item.client.hires}`);
  if (item.proposalsBand) parts.push(`PROPOSALS: ${item.proposalsBand}`);
  if (item.experienceLevel) parts.push(`LEVEL: ${item.experienceLevel}`);
  if (item.postedAt) parts.push(`POSTED: ${item.postedAt.slice(0, 10)}`);
  return parts.length > 0 ? `[${parts.join(" | ")}]` : "";
}
