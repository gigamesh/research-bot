/// A named bundle of (kind + payload) targeting a specific high-LTV/CAC
/// pattern on Upwork. Two flavors:
///   - `kind: "search"` — payload is `terms[]`; each term × page expands into
///     one search-page CrawlJob (`/nx/jobs/search/?q=…&page=N`).
///   - `kind: "urls"` — payload is `urls[]`; each URL is enqueued verbatim
///     once (--pages is ignored). Use for account-tied feeds whose filtering
///     is configured in Upwork's Filters dialog, not in the URL.
export type Preset =
  | {
      name: string;
      description: string;
      kind: "search";
      terms: string[];
    }
  | {
      name: string;
      description: string;
      kind: "urls";
      urls: string[];
    };

/// Initial preset library. Edit freely — preset *names* are the contract,
/// contents evolve weekly. Add a new preset by adding an entry to PRESETS.
export const PRESETS: Record<string, Preset> = {
  /// The user's account-tied job feeds. Filtering is configured in Upwork's
  /// Filters dialog (verified clients, hourly, ongoing, $X+ spend, etc.) and
  /// applies server-side to every page these URLs return. Pair this preset
  /// with the scroll-to-load behavior in the content script to capture more
  /// than the first ~30 visible tiles per visit.
  feeds: {
    name: "feeds",
    description:
      "The three personalized find-work feeds (Best Matches, Most Recent, U.S. Only). Filters from your Upwork Filters dialog apply to all of them.",
    kind: "urls",
    urls: [
      "https://www.upwork.com/nx/find-work/best-matches",
      "https://www.upwork.com/nx/find-work/most-recent",
      "https://www.upwork.com/nx/find-work/domestic",
    ],
  },

  "glue-integration": {
    name: "glue-integration",
    description:
      "Glue between two existing tools. Customers already pay humans monthly to copy data; a Zapier-shaped product captures that spend.",
    kind: "search",
    terms: [
      "sync between",
      "reconcile",
      "import from",
      "between shopify and",
      "between stripe and",
      "quickbooks reconciliation",
      "API integration",
      "webhook integration",
      "data entry from",
      "export to spreadsheet",
    ],
  },

  "verticals-ops": {
    name: "verticals-ops",
    description:
      "Non-tech verticals are SaaS demand, not freelancer supply. Low CAC because each audience is reachable through narrow industry channels.",
    kind: "search",
    terms: [
      "dental practice operations",
      "HVAC dispatch",
      "real estate transaction coordinator",
      "law firm intake",
      "salon booking",
      "restaurant scheduling",
      "property management ops",
      "medical billing",
      "veterinary practice",
      "auto repair shop ops",
    ],
  },

  "recurring-ops-roles": {
    name: "recurring-ops-roles",
    description:
      "Job titles that exist because software hasn't caught up. High-LTV (well-funded teams hire for these); the work is structured enough to automate.",
    kind: "search",
    terms: [
      "marketing operations",
      "revenue operations",
      "RevOps",
      "MarketingOps",
      "data operations",
      "integration specialist",
      "SDR ops",
      "billing operations",
      "sales ops",
      "customer success ops",
    ],
  },

  "spreadsheet-abuse": {
    name: "spreadsheet-abuse",
    description:
      "A spreadsheet maintained weekly by a paid human is the loudest possible signal of a missing product.",
    kind: "search",
    terms: [
      "automate spreadsheet",
      "google sheets automation",
      "excel macro",
      "spreadsheet to dashboard",
      "weekly excel report",
      "monthly reporting spreadsheet",
      "convert spreadsheet to app",
      "google sheets reporting",
    ],
  },

  "non-tech-saas-gaps": {
    name: "non-tech-saas-gaps",
    description:
      "Vertical SaaS adjacencies where existing tools have known sharp edges. Customers actively pay around the limitations.",
    kind: "search",
    terms: [
      "mindbody integration",
      "servicetitan workaround",
      "shopify backoffice",
      "etsy seller automation",
      "patient intake automation",
      "jobber integration",
      "housecall pro export",
      "clio law firm integration",
    ],
  },
};

export function getPreset(name: string): Preset | null {
  return PRESETS[name] ?? null;
}

export function listPresets(): Preset[] {
  return Object.values(PRESETS);
}
