/// Single source of truth for Upwork DOM selectors.
///
/// Upwork's React app renames hashed class names regularly, so prefer
/// `data-test`, `data-cy`, ARIA, and semantic selectors. When scraping breaks,
/// THIS is the file to update — confirm against fresh HTML the user provides
/// and mark anything brittle with the date you last verified it.
///
/// All selectors are stubs until real Upwork HTML samples land.

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
    budget?: string;
    proposalsBand?: string;
    skills?: string;
    clientCountry?: string;
    clientSpentBand?: string;
  };

  /// Detail-page selectors (single match each).
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

export const SELECTORS: Record<"job-search" | "job-detail" | "category-feed", SelectorMap> = {
  "job-search": {
    pageReady: "[data-test='JobsList'], section[aria-label*='job' i], main",
    itemList: "article[data-test='JobTile'], [data-ev-sublocation='job_feed_tile']",
    card: {
      titleLink: "a[data-test='job-tile-title-link'], h2 a[href*='/jobs/~01']",
      snippet: "[data-test='UpCLineClamp'] p, [data-test='job-description-text']",
      postedAt: "[data-test='JobInfo'] [data-test='posted-on'], small[title*='ago']",
      budget: "[data-test='budget'], [data-test='hourly-rate'], [data-test='fixed-price']",
      proposalsBand: "[data-test='proposals'], [data-test='proposals-tier']",
      skills: "[data-test='TokenClamp JobAttrs'] a, .air3-token",
      clientCountry: "[data-test='client-country']",
      clientSpentBand: "[data-test='client-spendings'], [data-test='formatted-amount']",
    },
  },
  "job-detail": {
    pageReady: "section[data-test='Description'], [data-test='job-description'], main",
    detail: {
      title: "h1[data-test='Title'], h1.job-title, h1",
      body: "section[data-test='Description'] [data-test='Description'], [data-test='job-description']",
      budget: "[data-test='BudgetAmount'], [data-test='budget-amount']",
      budgetType: "[data-test='BudgetType'], [data-test='hourly'], [data-test='fixed']",
      postedAt: "[data-test='PostedOn'], [data-test='posted-on']",
      skills: "[data-test='Skills'] a, .air3-token",
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
    pageReady: "[data-test='JobsList'], main",
    itemList: "article[data-test='JobTile'], [data-ev-sublocation='job_feed_tile']",
    card: {
      titleLink: "a[data-test='job-tile-title-link'], h2 a[href*='/jobs/~01']",
      snippet: "[data-test='UpCLineClamp'] p, [data-test='job-description-text']",
      postedAt: "[data-test='JobInfo'] [data-test='posted-on'], small[title*='ago']",
      budget: "[data-test='budget'], [data-test='hourly-rate'], [data-test='fixed-price']",
      proposalsBand: "[data-test='proposals'], [data-test='proposals-tier']",
      skills: "[data-test='TokenClamp JobAttrs'] a, .air3-token",
      clientCountry: "[data-test='client-country']",
      clientSpentBand: "[data-test='client-spendings'], [data-test='formatted-amount']",
    },
  },
};

/// Path-prefix → page kind. Order matters: longest-prefix-wins via Array.find.
export const PAGE_KIND_ROUTES: { prefix: RegExp; kind: keyof typeof SELECTORS }[] = [
  { prefix: /^\/jobs\/~01/, kind: "job-detail" },
  { prefix: /^\/nx\/jobs\/search/, kind: "job-search" },
  { prefix: /^\/nx\/find-work/, kind: "category-feed" },
  { prefix: /^\/ab\/find-work/, kind: "category-feed" },
];

export function detectPageKind(pathname: string): keyof typeof SELECTORS | null {
  return PAGE_KIND_ROUTES.find((r) => r.prefix.test(pathname))?.kind ?? null;
}
