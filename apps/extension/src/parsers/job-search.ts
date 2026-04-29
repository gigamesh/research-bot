import type { UpworkJobItem } from "@research-bot/shared";
import { SELECTORS, type SelectorMap } from "@/lib/selectors";
import {
  absoluteUrl,
  extractJobIdFromTile,
  parseBudget,
  parseDuration,
  parseRating,
  parseRelativeTime,
  text,
  textList,
} from "./helpers";

/// Parses a job-search OR category-feed results page. Both share the same
/// tile DOM on Upwork — the only difference is which route surfaced them.
export function parseCardListPage(
  doc: Document,
  capturedFrom: "job-search" | "category-feed",
): UpworkJobItem[] {
  const map: SelectorMap = SELECTORS[capturedFrom];
  if (!map.itemList || !map.card) return [];

  const card = map.card;
  const tiles = doc.querySelectorAll(map.itemList);
  const items: UpworkJobItem[] = [];

  for (const tile of tiles) {
    const externalId = extractJobIdFromTile(tile);
    if (!externalId) continue;

    const titleEl = tile.querySelector(card.titleLink);
    const url = absoluteUrl(titleEl?.getAttribute("href") ?? null);
    if (!url) continue;

    const jobTypeText = text(card.jobType ? tile.querySelector(card.jobType) : null);
    const fixedBudgetText = text(card.budget ? tile.querySelector(card.budget) : null);
    const budget = parseBudget([jobTypeText, fixedBudgetText].filter(Boolean).join(" "));

    const duration = parseDuration(
      text(card.duration ? tile.querySelector(card.duration) : null),
    );

    const skillEls = card.skills ? tile.querySelectorAll(card.skills) : null;

    const paymentVerified =
      /verified/i.test(
        text(
          card.paymentVerification
            ? tile.querySelector(card.paymentVerification)
            : null,
        ),
      ) || undefined;

    const ratingSrOnly = text(
      card.clientRatingSrOnly ? tile.querySelector(card.clientRatingSrOnly) : null,
    );
    const rating = parseRating(ratingSrOnly);

    items.push({
      externalId,
      url,
      capturedFrom,
      title: text(titleEl) || "(untitled)",
      body: text(card.snippet ? tile.querySelector(card.snippet) : null),
      postedAt:
        parseRelativeTime(text(card.postedAt ? tile.querySelector(card.postedAt) : null)) ??
        undefined,
      ...budget,
      budgetCurrency: "USD",
      proposalsBand:
        text(card.proposalsBand ? tile.querySelector(card.proposalsBand) : null) || undefined,
      experienceLevel:
        text(card.contractorTier ? tile.querySelector(card.contractorTier) : null) || undefined,
      projectLength: duration.projectLength,
      hoursPerWeek: duration.hoursPerWeek,
      skills: textList(skillEls),
      client: {
        country:
          text(card.clientCountry ? tile.querySelector(card.clientCountry) : null) || undefined,
        spentBand:
          text(card.clientSpentBand ? tile.querySelector(card.clientSpentBand) : null) ||
          undefined,
        rating,
        paymentVerified,
      },
      screeningQuestions: [],
    });
  }

  return items;
}
