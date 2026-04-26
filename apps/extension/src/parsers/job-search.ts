import type { UpworkJobItem } from "@research-bot/shared";
import { SELECTORS, type SelectorMap } from "@/lib/selectors";
import { absoluteUrl, extractJobId, parseBudget, parseRelativeTime, text, textList } from "./helpers";

/// Parses a job-search OR category-feed results page. Both share the same
/// card structure on Upwork; the only difference is which route surfaced them.
export function parseCardListPage(
  doc: Document,
  capturedFrom: "job-search" | "category-feed",
): UpworkJobItem[] {
  const map: SelectorMap = SELECTORS[capturedFrom];
  if (!map.itemList || !map.card) return [];

  const cards = doc.querySelectorAll(map.itemList);
  const items: UpworkJobItem[] = [];

  for (const card of cards) {
    const titleEl = card.querySelector(map.card.titleLink);
    const href = titleEl?.getAttribute("href") ?? null;
    const externalId = extractJobId(href);
    const url = absoluteUrl(href);
    if (!externalId || !url) continue;

    const skillEls = map.card.skills ? card.querySelectorAll(map.card.skills) : null;
    const budget = parseBudget(text(map.card.budget ? card.querySelector(map.card.budget) : null));

    items.push({
      externalId,
      url,
      capturedFrom,
      title: text(titleEl) || "(untitled)",
      body: text(map.card.snippet ? card.querySelector(map.card.snippet) : null),
      postedAt:
        parseRelativeTime(text(map.card.postedAt ? card.querySelector(map.card.postedAt) : null)) ??
        undefined,
      ...budget,
      budgetCurrency: "USD",
      proposalsBand:
        text(map.card.proposalsBand ? card.querySelector(map.card.proposalsBand) : null) ||
        undefined,
      skills: textList(skillEls),
      client: {
        country:
          text(map.card.clientCountry ? card.querySelector(map.card.clientCountry) : null) ||
          undefined,
        spentBand:
          text(map.card.clientSpentBand ? card.querySelector(map.card.clientSpentBand) : null) ||
          undefined,
      },
      screeningQuestions: [],
    });
  }

  return items;
}
