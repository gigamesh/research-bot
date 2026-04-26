import type { UpworkJobItem } from "@research-bot/shared";
import { parseCardListPage } from "./job-search";

/// Most-recent / Best-matches feeds use the same card layout as search.
export function parseCategoryFeedPage(doc: Document): UpworkJobItem[] {
  return parseCardListPage(doc, "category-feed");
}
