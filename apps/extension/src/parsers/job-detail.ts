import type { UpworkJobItem } from "@research-bot/shared";
import { SELECTORS } from "@/lib/selectors";
import { extractJobId, parseBudget, parseRelativeTime, text, textList } from "./helpers";

/// Parse the currently-open Upwork job detail page. Returns one item or null
/// if the detail container hasn't rendered yet (the caller should retry).
export function parseDetailPage(doc: Document, url: string): UpworkJobItem | null {
  const sel = SELECTORS["job-detail"].detail;
  if (!sel) return null;

  const externalId = extractJobId(url);
  if (!externalId) return null;

  const titleEl = doc.querySelector(sel.title);
  const bodyEl = doc.querySelector(sel.body);
  if (!titleEl || !bodyEl) return null;

  const budget = parseBudget(
    [text(doc.querySelector(sel.budget ?? "")), text(doc.querySelector(sel.budgetType ?? ""))]
      .filter(Boolean)
      .join(" "),
  );

  const totalSpentRaw = text(doc.querySelector(sel.clientTotalSpent ?? ""));
  const clientHiresRaw = text(doc.querySelector(sel.clientHires ?? ""));

  return {
    externalId,
    url,
    capturedFrom: "job-detail",
    title: text(titleEl),
    body: text(bodyEl),
    postedAt: parseRelativeTime(text(doc.querySelector(sel.postedAt ?? ""))) ?? undefined,
    ...budget,
    budgetCurrency: "USD",
    experienceLevel: text(doc.querySelector(sel.experienceLevel ?? "")) || undefined,
    projectLength: text(doc.querySelector(sel.projectLength ?? "")) || undefined,
    hoursPerWeek: text(doc.querySelector(sel.hoursPerWeek ?? "")) || undefined,
    skills: textList(sel.skills ? doc.querySelectorAll(sel.skills) : null),
    client: {
      country: text(doc.querySelector(sel.clientCountry ?? "")) || undefined,
      totalSpent: parseAmount(totalSpentRaw) ?? totalSpentRaw ?? undefined,
      hires: Number.parseInt(clientHiresRaw, 10) || undefined,
      hireRate: parsePercent(text(doc.querySelector(sel.clientHireRate ?? ""))),
      rating: Number.parseFloat(text(doc.querySelector(sel.clientRating ?? ""))) || undefined,
      reviewsCount:
        Number.parseInt(text(doc.querySelector(sel.clientReviews ?? "")), 10) || undefined,
    },
    screeningQuestions: textList(
      sel.screeningQuestions ? doc.querySelectorAll(sel.screeningQuestions) : null,
    ),
  };
}

function parseAmount(raw: string): number | undefined {
  if (!raw) return undefined;
  const m = raw.match(/\$\s*([\d,]+(?:\.\d+)?)\s*([KkMm])?/);
  if (!m) return undefined;
  const base = Number(m[1].replace(/,/g, ""));
  if (Number.isNaN(base)) return undefined;
  const suffix = m[2]?.toLowerCase();
  if (suffix === "k") return base * 1_000;
  if (suffix === "m") return base * 1_000_000;
  return base;
}

function parsePercent(raw: string): number | undefined {
  if (!raw) return undefined;
  const m = raw.match(/(\d+(?:\.\d+)?)\s*%/);
  if (!m) return undefined;
  const n = Number(m[1]) / 100;
  return Number.isFinite(n) ? n : undefined;
}
