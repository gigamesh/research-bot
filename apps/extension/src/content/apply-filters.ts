import type {
  FilterSpec,
  ApplyFiltersPayload,
  CrawlFailReason,
  ExperienceLevel,
  JobType,
  FixedPriceBand,
  ProjectLength,
  HoursPerWeek,
  ClientHistory,
  ProposalsBand,
} from "@research-bot/shared";
import { ApplyFiltersPayloadSchema } from "@research-bot/shared";
import { FILTER_DIALOG_SELECTORS as SEL } from "@/lib/selectors";

/// Outcome of an apply-filters run, mapped 1:1 to the crawl:status message
/// the SW expects.
export type ApplyFiltersResult =
  | { ok: true; appliedSections: string[] }
  | { ok: false; reason: CrawlFailReason; error: string };

const STEP_DELAY_MIN_MS = 250;
const STEP_DELAY_MAX_MS = 600;

/// Decode the JSON payload the SW stashed in chrome.storage. Returns null on
/// any decode/parse failure — caller should treat that as a hard failure.
export function decodePayload(payloadJson: string): ApplyFiltersPayload | null {
  if (!payloadJson) return null;
  try {
    const parsed = ApplyFiltersPayloadSchema.safeParse(JSON.parse(payloadJson));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Label maps — translate FilterSpec enum values to the visible label text
// the dialog renders (lowercased + whitespace-normalized for matching).
// ---------------------------------------------------------------------------

const EXPERIENCE_LEVEL_LABELS: Record<ExperienceLevel, string> = {
  entry: "entry level",
  intermediate: "intermediate",
  expert: "expert",
};

const JOB_TYPE_LABELS: Record<JobType, string> = {
  hourly: "hourly",
  fixed: "fixed-price",
};

const FIXED_PRICE_BAND_LABELS: Record<FixedPriceBand, string> = {
  "less-than-100": "less than $100",
  "100-to-500": "$100 to $500",
  "500-to-1000": "$500 to $1,000",
  "1000-to-5000": "$1,000 to $5,000",
  "5000-plus": "$5,000+",
};

const PROJECT_LENGTH_LABELS: Record<ProjectLength, string> = {
  "less-than-1-month": "less than one month",
  "1-to-3-months": "1 to 3 months",
  "3-to-6-months": "3 to 6 months",
  "more-than-6-months": "more than 6 months",
};

const HOURS_PER_WEEK_LABELS: Record<HoursPerWeek, string> = {
  "less-than-30": "less than 30 hrs/week",
  "30-plus": "more than 30 hrs/week",
};

const CLIENT_HISTORY_LABELS: Record<ClientHistory, string> = {
  "no-hires": "no hires",
  "1-to-9-hires": "1 to 9 hires",
  "10-plus-hires": "10+ hires",
};

const PROPOSALS_LABELS: Record<ProposalsBand, string> = {
  "less-than-5": "less than 5",
  "5-to-10": "5 to 10",
  "10-to-15": "10 to 15",
  "15-to-20": "15 to 20",
  "20-to-50": "20 to 50",
};

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

/// Run the click sequence to set Upwork's account-tied filter set to `spec`.
///
/// Strategy: open dialog → click "Clear" (idempotent reset) → check the
/// boxes the spec asks for → click "Apply" → wait for dialog close.
export async function applyFilters(spec: FilterSpec): Promise<ApplyFiltersResult> {
  const opened = await openDialog();
  if (!opened) return fail("Filters dialog did not open within 4s");

  // Always clear first so the recipe controls the full state, not a diff.
  await clickIfPresent(SEL.clearButton);
  await sleep(jitter(STEP_DELAY_MIN_MS, STEP_DELAY_MAX_MS));

  const applied: string[] = [];

  if (spec.usOnly) {
    if (await checkSingle(SEL.usOnlyCheckbox)) applied.push("usOnly");
  }

  if (spec.experienceLevels?.length) {
    const labels = spec.experienceLevels.map((v) => EXPERIENCE_LEVEL_LABELS[v]);
    if (await checkInSection(SEL.experienceLevelSection, labels)) {
      applied.push("experienceLevels");
    }
  }

  if (spec.jobTypes?.length) {
    const labels = spec.jobTypes.map((v) => JOB_TYPE_LABELS[v]);
    if (await checkInSection(SEL.jobTypeSection, labels)) {
      applied.push("jobTypes");
    }
    // Fixed-Price sub-bands are only meaningful when "fixed" is selected.
    if (spec.jobTypes.includes("fixed") && spec.fixedPriceBands?.length) {
      // The sub-band wrapper is `display:none` until Fixed-Price is checked;
      // give it a frame to render before targeting.
      await sleep(STEP_DELAY_MIN_MS);
      const bandLabels = spec.fixedPriceBands.map((v) => FIXED_PRICE_BAND_LABELS[v]);
      if (await checkInSection(SEL.jobTypeSection, bandLabels)) {
        applied.push("fixedPriceBands");
      }
    }
    if (spec.jobTypes.includes("fixed") && spec.fixedPriceCustom) {
      let touched = false;
      if (spec.fixedPriceCustom.min !== undefined) {
        touched = (await setNumberInput(SEL.fixedPriceMinInput, spec.fixedPriceCustom.min)) || touched;
      }
      if (spec.fixedPriceCustom.max !== undefined) {
        touched = (await setNumberInput(SEL.fixedPriceMaxInput, spec.fixedPriceCustom.max)) || touched;
      }
      if (touched) applied.push("fixedPriceCustom");
    }
  }

  if (spec.proposals?.length) {
    const labels = spec.proposals.map((v) => PROPOSALS_LABELS[v]);
    if (await checkInSection(SEL.proposalsSection, labels)) applied.push("proposals");
  }

  // Client info combines paymentVerified + myPreviousClients into one section.
  const clientInfoLabels: string[] = [];
  if (spec.paymentVerified) clientInfoLabels.push("payment verified");
  if (spec.myPreviousClients) clientInfoLabels.push("my previous clients");
  if (clientInfoLabels.length) {
    if (await checkInSection(SEL.clientInfoSection, clientInfoLabels)) {
      applied.push("clientInfo");
    }
  }

  if (spec.clientHistory?.length) {
    const labels = spec.clientHistory.map((v) => CLIENT_HISTORY_LABELS[v]);
    if (await checkInSection(SEL.clientHistorySection, labels)) applied.push("clientHistory");
  }

  if (spec.projectLengths?.length) {
    const labels = spec.projectLengths.map((v) => PROJECT_LENGTH_LABELS[v]);
    if (await checkInSection(SEL.projectLengthSection, labels)) applied.push("projectLengths");
  }

  if (spec.hoursPerWeek?.length) {
    const labels = spec.hoursPerWeek.map((v) => HOURS_PER_WEEK_LABELS[v]);
    if (await checkInSection(SEL.hoursPerWeekSection, labels)) applied.push("hoursPerWeek");
  }

  if (spec.contractToHire) {
    if (await checkInSection(SEL.jobDurationSection, ["contract-to-hire"])) {
      applied.push("contractToHire");
    }
  }

  // Apply, wait for dialog to close.
  const apply = document.querySelector<HTMLElement>(SEL.applyButton);
  if (!apply) return fail("Apply button not found");
  apply.click();
  const closed = await waitForGone(SEL.dialogContainer, 5000);
  if (!closed) return fail("Apply clicked but dialog did not close within 5s");

  return { ok: true, appliedSections: applied };
}

// ---------------------------------------------------------------------------
// Click helpers
// ---------------------------------------------------------------------------

async function openDialog(): Promise<boolean> {
  const button = document.querySelector<HTMLElement>(SEL.openButton);
  if (!button) return false;
  button.click();
  return waitFor(SEL.dialogContainer, 4000);
}

async function clickIfPresent(selector: string): Promise<boolean> {
  const el = document.querySelector<HTMLElement>(selector);
  if (!el) return false;
  el.click();
  return true;
}

/// Tick a single checkbox label if it isn't already checked. Returns true if
/// the click was issued (or state was already correct), false if the element
/// wasn't found.
async function checkSingle(labelSelector: string): Promise<boolean> {
  const label = document.querySelector<HTMLLabelElement>(labelSelector);
  if (!label) return false;
  const input = label.querySelector<HTMLInputElement>("input[type='checkbox']");
  if (!input) return false;
  if (!input.checked) {
    label.click();
    await sleep(jitter(STEP_DELAY_MIN_MS, STEP_DELAY_MAX_MS));
  }
  return true;
}

/// Within `sectionSelector`, find every option whose visible label text
/// matches one of `wantedLabelsLower` (case-insensitive substring match) and
/// ensure each is checked. Returns false if the section couldn't be found.
async function checkInSection(
  sectionSelector: string,
  wantedLabelsLower: string[],
): Promise<boolean> {
  const section = document.querySelector(sectionSelector);
  if (!section) return false;
  if (wantedLabelsLower.length === 0) return true;

  const wanted = wantedLabelsLower.map(normalize);
  const options = Array.from(
    section.querySelectorAll<HTMLLabelElement>(SEL.optionLabelInSection),
  );
  for (const label of options) {
    const visible = normalize(extractLabelText(label));
    const matches = wanted.some((w) => visible.includes(w));
    if (!matches) continue;

    const input = label.querySelector<HTMLInputElement>("input[type='checkbox']");
    if (!input) continue;
    if (input.checked) continue;

    label.click();
    await sleep(jitter(STEP_DELAY_MIN_MS, STEP_DELAY_MAX_MS));
  }
  return true;
}

async function setNumberInput(
  selector: string,
  value: number | undefined,
): Promise<boolean> {
  if (value === undefined) return false;
  const input = document.querySelector<HTMLInputElement>(selector);
  if (!input) return false;
  // React/Vue-controlled inputs require setting the native value descriptor
  // and dispatching synthetic events so the framework picks up the change.
  const proto = window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  setter?.call(input, String(value));
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await sleep(jitter(STEP_DELAY_MIN_MS, STEP_DELAY_MAX_MS));
  return true;
}

function fail(error: string): ApplyFiltersResult {
  return { ok: false, reason: "selector_drift", error };
}

// ---------------------------------------------------------------------------
// Small DOM utilities
// ---------------------------------------------------------------------------

/// Pull the visible label text for an option, stripping the trailing count
/// in parentheses ("Entry level (3)" → "Entry level").
function extractLabelText(label: Element): string {
  const raw = label.textContent ?? "";
  return raw.replace(/\s*\(\s*\d+\s*\)\s*$/m, "").replace(/\s+/g, " ").trim();
}

function normalize(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

function waitFor(selector: string, timeoutMs: number): Promise<boolean> {
  if (document.querySelector(selector)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      if (document.querySelector(selector)) return resolve(true);
      if (Date.now() - start > timeoutMs) return resolve(false);
      requestAnimationFrame(tick);
    };
    tick();
  });
}

function waitForGone(selector: string, timeoutMs: number): Promise<boolean> {
  if (!document.querySelector(selector)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      if (!document.querySelector(selector)) return resolve(true);
      if (Date.now() - start > timeoutMs) return resolve(false);
      requestAnimationFrame(tick);
    };
    tick();
  });
}

function jitter(min: number, max: number): number {
  if (max <= min) return Math.max(0, min);
  return min + Math.floor(Math.random() * (max - min));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
