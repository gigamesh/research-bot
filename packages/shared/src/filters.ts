import { z } from "zod";

/**
 * Upwork filter spec — declarative description of the filter set the
 * extension should apply on `/nx/find-work/*` via the Filters dialog.
 *
 * Fields here mirror the **current** Filters dialog (verified 2026-04-26).
 * The driver always clicks "Clear" before applying, so a missing/false field
 * means "leave that filter unchecked"; you don't have to enumerate every
 * filter you don't care about.
 *
 * Adding a new field: define the enum here, add a label-text map in the
 * click driver (`apps/extension/src/content/apply-filters.ts`), wire a new
 * call site in `applyFilters()`. The selector for the section itself goes
 * in `apps/extension/src/lib/selectors.ts → FILTER_DIALOG_SELECTORS`.
 */

export const ExperienceLevelSchema = z.enum(["entry", "intermediate", "expert"]);
export type ExperienceLevel = z.infer<typeof ExperienceLevelSchema>;

export const JobTypeSchema = z.enum(["hourly", "fixed"]);
export type JobType = z.infer<typeof JobTypeSchema>;

export const FixedPriceBandSchema = z.enum([
  "less-than-100",
  "100-to-500",
  "500-to-1000",
  "1000-to-5000",
  "5000-plus",
]);
export type FixedPriceBand = z.infer<typeof FixedPriceBandSchema>;

export const ProjectLengthSchema = z.enum([
  "less-than-1-month",
  "1-to-3-months",
  "3-to-6-months",
  "more-than-6-months",
]);
export type ProjectLength = z.infer<typeof ProjectLengthSchema>;

export const HoursPerWeekSchema = z.enum(["less-than-30", "30-plus"]);
export type HoursPerWeek = z.infer<typeof HoursPerWeekSchema>;

export const ClientHistorySchema = z.enum([
  "no-hires",
  "1-to-9-hires",
  "10-plus-hires",
]);
export type ClientHistory = z.infer<typeof ClientHistorySchema>;

export const ProposalsBandSchema = z.enum([
  "less-than-5",
  "5-to-10",
  "10-to-15",
  "15-to-20",
  "20-to-50",
]);
export type ProposalsBand = z.infer<typeof ProposalsBandSchema>;

export const FilterSpecSchema = z.object({
  /// Top-level "U.S. only" checkbox (above all sections).
  usOnly: z.boolean().optional(),

  /// "Client info" → Payment verified.
  paymentVerified: z.boolean().optional(),

  /// "Client info" → My previous clients.
  myPreviousClients: z.boolean().optional(),

  /// "Experience level" — multi-select.
  experienceLevels: z.array(ExperienceLevelSchema).optional(),

  /// "Job type" — multi-select. Hourly + Fixed-Price are independent boxes.
  jobTypes: z.array(JobTypeSchema).optional(),

  /// "Job type" → Fixed-Price → preset bands. Only relevant when "fixed" is
  /// in `jobTypes`. Leave empty to apply no band-level constraint.
  fixedPriceBands: z.array(FixedPriceBandSchema).optional(),

  /// "Job type" → Fixed-Price → custom range. Sets the min/max inputs and
  /// (if either is provided) ticks the "custom range" checkbox.
  fixedPriceCustom: z
    .object({
      min: z.number().int().nonnegative().optional(),
      max: z.number().int().nonnegative().optional(),
    })
    .optional(),

  /// "Number of proposals" — multi-select.
  proposals: z.array(ProposalsBandSchema).optional(),

  /// "Client history" — multi-select.
  clientHistory: z.array(ClientHistorySchema).optional(),

  /// "Project length" — multi-select.
  projectLengths: z.array(ProjectLengthSchema).optional(),

  /// "Hours per week" — multi-select.
  hoursPerWeek: z.array(HoursPerWeekSchema).optional(),

  /// "Job duration" → Contract-to-hire roles (single checkbox).
  contractToHire: z.boolean().optional(),
});

export type FilterSpec = z.infer<typeof FilterSpecSchema>;

/// Apply-filters job payload as it travels through CrawlJob.payload (JSON).
export const ApplyFiltersPayloadSchema = z.object({
  /// Name of the recipe used to build this spec — purely for traceability
  /// in /queue and `pnpm crawl status`.
  recipe: z.string(),
  spec: FilterSpecSchema,
});

export type ApplyFiltersPayload = z.infer<typeof ApplyFiltersPayloadSchema>;
