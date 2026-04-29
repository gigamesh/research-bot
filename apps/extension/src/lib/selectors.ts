/// Single source of truth for Upwork DOM selectors.
///
/// Selectors verified against real Upwork HTML on 2026-04-25 — the
/// `/nx/find-work/best-matches` feed, which shares its tile DOM with the
/// search-results page. When scraping breaks, this is the file to update.
///
/// Stability strategy: prefer `data-ev-*`, `data-test`, ARIA, and semantic
/// selectors over class names. Upwork's "air3" design-system class names
/// (e.g. `air3-card-section`) are also reasonably stable but can change in
/// redesigns — keep them as fallbacks, not primary anchors.
///
/// `job-detail` selectors are still stubs (no real HTML sample yet) — the
/// detail-page parser will return null for missing fields and the search
/// snippet will be used instead.

export type SelectorMap = {
  /// A stable container the parser can wait for before scraping (proves the
  /// React tree has hydrated). Used by the MutationObserver gate.
  pageReady: string;

  /// Multiple-element selector returning each item card on the page.
  itemList?: string;

  /// Per-card selectors (run within each itemList match).
  card?: {
    titleLink: string;
    snippet?: string;
    postedAt?: string;
    /// Combined "Hourly: $25-$30" or "Fixed-price" header line.
    jobType?: string;
    /// Fixed-price total when shown (e.g. "$500" or "$1,500").
    budget?: string;
    contractorTier?: string;
    /// Combined "3 to 6 months, 30+ hrs/week" line — split via parseDuration.
    duration?: string;
    proposalsBand?: string;
    skills?: string;
    paymentVerification?: string;
    clientRatingSrOnly?: string;
    clientCountry?: string;
    clientSpentBand?: string;
    locationRequirement?: string;
  };

  /// Detail-page selectors (single match each). Stubs until real detail-page
  /// HTML lands — confirmed selectors will replace these.
  detail?: {
    title: string;
    body: string;
    budget?: string;
    budgetType?: string;
    postedAt?: string;
    skills?: string;
    experienceLevel?: string;
    projectLength?: string;
    hoursPerWeek?: string;
    clientCountry?: string;
    clientTotalSpent?: string;
    clientHires?: string;
    clientHireRate?: string;
    clientRating?: string;
    clientReviews?: string;
    screeningQuestions?: string;
  };
};

const CARD_SELECTORS: NonNullable<SelectorMap["card"]> = {
  titleLink: "h3.job-tile-title a, a[data-ev-label='link'], h2 a[href*='/jobs/']",
  snippet: "[data-test='job-description-text']",
  postedAt: "[data-test='posted-on']",
  jobType: "[data-test='job-type']",
  budget: "[data-test='budget']",
  contractorTier: "[data-test='contractor-tier']",
  duration: "[data-test='duration']",
  proposalsBand: "[data-test='proposals']",
  skills: "a[data-test='attr-item']",
  paymentVerification: "[data-test='payment-verification-status']",
  clientRatingSrOnly: ".air3-rating .sr-only",
  clientCountry: "[data-test='client-country']",
  clientSpentBand: "[data-test='client-spendings'] [data-test='formatted-amount']",
  locationRequirement: "[data-test='location-requirement']",
};

const TILE_LIST_SELECTOR = "[data-test='job-tile-list']";
const TILE_ITEM_SELECTOR =
  "section[data-ev-sublocation='job_feed_tile'], article[data-ev-sublocation='job_feed_tile']";

export const SELECTORS: Record<"job-search" | "job-detail" | "category-feed", SelectorMap> = {
  "job-search": {
    pageReady: TILE_LIST_SELECTOR,
    itemList: TILE_ITEM_SELECTOR,
    card: CARD_SELECTORS,
  },
  "job-detail": {
    pageReady: "section[data-test='Description'], [data-test='job-description'], main",
    detail: {
      title: "h1[data-test='Title'], h1.job-title, h1",
      body: "section[data-test='Description'] [data-test='Description'], [data-test='job-description']",
      budget: "[data-test='BudgetAmount'], [data-test='budget-amount']",
      budgetType: "[data-test='BudgetType'], [data-test='hourly'], [data-test='fixed']",
      postedAt: "[data-test='PostedOn'], [data-test='posted-on']",
      skills: "a[data-test='attr-item'], [data-test='Skills'] a",
      experienceLevel: "[data-test='Features'] li[data-test*='experience'] strong",
      projectLength: "[data-test='Features'] li[data-test*='duration'] strong",
      hoursPerWeek: "[data-test='Features'] li[data-test*='workload'] strong",
      clientCountry: "[data-test='LocationLabel'], [data-test='client-country']",
      clientTotalSpent: "[data-test='ClientStats'] [data-test='spent'], [data-qa='client-spent']",
      clientHires: "[data-test='ClientStats'] [data-test='hires']",
      clientHireRate: "[data-test='ClientStats'] [data-test='hire-rate']",
      clientRating: "[data-test='Rating'] [data-test='rating-value']",
      clientReviews: "[data-test='Rating'] [data-test='reviews-count']",
      screeningQuestions: "[data-test='Questions'] li, [data-test='screening-question']",
    },
  },
  "category-feed": {
    pageReady: TILE_LIST_SELECTOR,
    itemList: TILE_ITEM_SELECTOR,
    card: CARD_SELECTORS,
  },
};

/// Selectors for the **Filters dialog** that opens from the find-work feed
/// when you click the "Filters" button. Confirmed against real HTML on
/// 2026-04-26.
///
/// The dialog is Vue-driven (`data-v-*` scope attributes throughout). Each
/// option is a `<label data-test='filter-checkbox-item'>` wrapping a hidden
/// `<input type='checkbox' class='sr-only'>`. Clicking the label toggles the
/// input via the standard label-input association — Vue picks up the change
/// event automatically.
///
/// Sections have stable Vue-generated IDs (`#filter-section-content-X`); use
/// those as the section roots. Within a section, options are matched by
/// visible label text — `apply-filters.ts` carries a mapping table from
/// FilterSpec enum values to the label substrings to look for.
export const FILTER_DIALOG_SELECTORS = {
  // --- outer chrome ---
  openButton: "[data-test='filters-button']",
  dialogContainer: ".air3-modal:has([data-test='filters-list'])",
  applyButton: "[data-test='filters-apply-btn']",
  clearButton: "[data-test='filters-clear-btn']",
  closeButton: ".air3-modal-close",

  // --- top-level checkbox (above all sections) ---
  /// "U.S. only" — the first filter-item in the list, outside any section.
  usOnlyCheckbox:
    "[data-test='filters-list-content'] > [data-test='filter-item']:first-child label[data-test='filter-checkbox-item']",

  // --- section roots (Vue id contracts) ---
  experienceLevelSection: "#filter-section-content-experienceLevel",
  jobTypeSection: "#filter-section-content-job-type",
  proposalsSection: "#filter-section-content-proposals",
  clientInfoSection: "#filter-section-content-clientInfo",
  clientHistorySection: "#filter-section-content-clientHistory",
  projectLengthSection: "#filter-section-content-projectLength",
  hoursPerWeekSection: "#filter-section-content-hoursPerWeek",
  jobDurationSection: "#filter-section-content-jobDuration",

  // --- fixed-price custom range inputs (revealed only when Fixed-Price is ticked) ---
  fixedPriceMinInput: "#fixed-price-min-input",
  fixedPriceMaxInput: "#fixed-price-max-input",

  /// Within any section, the per-option `<label>` selector.
  optionLabelInSection: "label[data-test='filter-checkbox-item']",
};

/// Path-prefix → page kind. Order matters: longest-prefix-wins via Array.find.
export const PAGE_KIND_ROUTES: { prefix: RegExp; kind: keyof typeof SELECTORS }[] = [
  { prefix: /^\/jobs\/.*~0\d/, kind: "job-detail" },
  { prefix: /^\/nx\/jobs\/search/, kind: "job-search" },
  { prefix: /^\/nx\/find-work/, kind: "category-feed" },
  { prefix: /^\/ab\/find-work/, kind: "category-feed" },
];

export function detectPageKind(pathname: string): keyof typeof SELECTORS | null {
  return PAGE_KIND_ROUTES.find((r) => r.prefix.test(pathname))?.kind ?? null;
}
