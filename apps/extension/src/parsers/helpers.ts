/// Small parsing utilities shared across the page-type parsers.

/// Upwork's job ids look like `~02<19-digit-number>` in current URLs (older
/// listings used `~01...`). The leading `~0\d` anchor handles both. In job
/// tiles the bare numeric id is also exposed as `data-ev-opening_uid` on the
/// outer section — `extractJobIdFromTile` prefers that since it's faster and
/// can't drift from a slug change.
const JOB_ID = /(~0\d[a-zA-Z0-9]+)/;

export function extractJobId(href: string | null | undefined): string | null {
  if (!href) return null;
  return href.match(JOB_ID)?.[1] ?? null;
}

/// Pull the externalId from a job tile element. Prefers the analytics
/// attribute (numeric, stable) and falls back to parsing the title-link href.
export function extractJobIdFromTile(tile: Element): string | null {
  const uid = tile.getAttribute("data-ev-opening_uid");
  if (uid && /^\d+$/.test(uid)) return `~02${uid}`;
  const link = tile.querySelector("a[data-ev-label='link'], h3.job-tile-title a, h2 a, h3 a");
  return extractJobId(link?.getAttribute("href") ?? null);
}

export function absoluteUrl(href: string | null | undefined): string | null {
  if (!href) return null;
  try {
    return new URL(href, "https://www.upwork.com").toString();
  } catch {
    return null;
  }
}

export function text(el: Element | null | undefined): string {
  return el?.textContent?.replace(/\s+/g, " ").trim() ?? "";
}

export function textList(els: NodeListOf<Element> | Element[] | null | undefined): string[] {
  if (!els) return [];
  return Array.from(els)
    .map((el) => text(el))
    .filter((s) => s.length > 0);
}

/// Parse Upwork's budget label, which appears in many forms:
///   "Fixed-price" + "$500-$1,500"   → fixed, 500, 1500
///   "Hourly: $25-$50"               → hourly, 25, 50
///   "$25.00/hr"                     → hourly, 25
export function parseBudget(label: string): {
  budgetType?: "fixed" | "hourly";
  budgetMin?: number;
  budgetMax?: number;
} {
  if (!label) return {};
  const lower = label.toLowerCase();

  let budgetType: "fixed" | "hourly" | undefined;
  if (lower.includes("hour") || lower.includes("/hr") || lower.includes("hourly"))
    budgetType = "hourly";
  else if (lower.includes("fixed") || lower.includes("budget"))
    budgetType = "fixed";

  const numbers = Array.from(label.matchAll(/\$\s*([\d,]+(?:\.\d+)?)/g))
    .map((m) => Number(m[1].replace(/,/g, "")))
    .filter((n) => !Number.isNaN(n));

  const result: { budgetType?: "fixed" | "hourly"; budgetMin?: number; budgetMax?: number } = {};
  if (budgetType) result.budgetType = budgetType;
  if (numbers.length === 1) result.budgetMin = numbers[0];
  if (numbers.length >= 2) {
    result.budgetMin = Math.min(...numbers);
    result.budgetMax = Math.max(...numbers);
  }
  return result;
}

/// Convert a relative timestamp ("2 hours ago", "yesterday") to an ISO string.
/// Falls back to the raw string-as-postedAt-undefined pattern: callers should
/// drop the field if this returns null.
export function parseRelativeTime(label: string, now: Date = new Date()): string | null {
  if (!label) return null;
  const lower = label.trim().toLowerCase();
  if (lower.includes("just now") || lower.includes("seconds ago")) return now.toISOString();
  if (lower === "yesterday") {
    const d = new Date(now); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString();
  }
  const match = lower.match(/(\d+)\s*(minute|hour|day|week|month|year)s?\s+ago/);
  if (!match) return null;
  const n = Number(match[1]);
  const unit = match[2];
  const ms: Record<string, number> = {
    minute: 60_000,
    hour: 3_600_000,
    day: 86_400_000,
    week: 604_800_000,
    month: 2_592_000_000,
    year: 31_536_000_000,
  };
  return new Date(now.getTime() - n * ms[unit]).toISOString();
}

/// Upwork's `data-test="duration"` field combines two pieces:
///   "3 to 6 months, 30+ hrs/week"      → projectLength + hoursPerWeek
///   "Less than 1 month, Less than 30 hrs/week"
///   "More than 6 months, 30+ hrs/week"
/// The parts are comma-separated; treat anything matching /hr|week/ as hours.
export function parseDuration(label: string): {
  projectLength?: string;
  hoursPerWeek?: string;
} {
  if (!label) return {};
  const parts = label.split(",").map((s) => s.trim()).filter(Boolean);
  const result: { projectLength?: string; hoursPerWeek?: string } = {};
  for (const part of parts) {
    if (/hr|hour|week/i.test(part)) result.hoursPerWeek = part;
    else if (!result.projectLength) result.projectLength = part;
  }
  return result;
}

/// Read client rating from the screen-reader-only label that Upwork keeps
/// up to date alongside the visual stars: `<span class="sr-only">Rating is
/// 4.7 out of 5.</span>`. More reliable than parsing the foreground bar
/// width.
export function parseRating(text: string): number | undefined {
  const m = text.match(/rating is (\d+(?:\.\d+)?)\s*out of\s*5/i);
  if (!m) return undefined;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : undefined;
}
