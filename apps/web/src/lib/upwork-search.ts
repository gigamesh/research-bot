/// Upwork search URL construction.
///
/// Upwork's filter URL params (`payment_verified_only`, `t`, `duration_v3`,
/// etc.) appear to no longer take effect in the current site — filters are
/// persisted on the user's account via the Filters dialog. So the URL builder
/// only sets the query and page; the LTV/CAC bias is now configured once in
/// Upwork's UI and applies to every captured page.

const SEARCH_BASE = "https://www.upwork.com/nx/jobs/search/";

/// Build a `/nx/jobs/search/` URL for a free-text query.
export function buildSearchUrl(query: string, page: number): string {
  const params = new URLSearchParams();
  params.set("q", query);
  params.set("page", String(Math.max(1, page)));
  params.set("per_page", "50");
  params.set("sort", "recency");
  return `${SEARCH_BASE}?${params.toString()}`;
}
