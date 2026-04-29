import type { FilterSpec } from "@research-bot/shared";

/// Named filter recipes the CLI can apply via `pnpm crawl filters apply <name>`.
/// Each recipe maps to a FilterSpec; the SW + content script translate the
/// spec into the click sequence on Upwork's Filters dialog.
///
/// Edit recipes here to evolve the filter strategy. The recipe *names* are the
/// CLI contract; their contents can change weekly.
///
/// The driver always clicks **Clear** before applying, so each recipe only
/// needs to enumerate what should be CHECKED — anything not listed ends up
/// unchecked.
export type FilterRecipe = {
  name: string;
  description: string;
  spec: FilterSpec;
};

export const FILTERS: Record<string, FilterRecipe> = {
  /// High-LTV bias. Leaves `clientHistory: ["1-to-9-hires", "10-plus-hires"]`
  /// in (excludes "No hires") and biases toward longer, more-than-30-hrs/week
  /// hourly engagements with verified payment.
  "high-ltv": {
    name: "high-ltv",
    description:
      "Verified hourly clients with 1+ past hires + 30+ hrs/week + 3+ month engagements.",
    spec: {
      paymentVerified: true,
      jobTypes: ["hourly"],
      experienceLevels: ["intermediate", "expert"],
      projectLengths: ["3-to-6-months", "more-than-6-months"],
      hoursPerWeek: ["30-plus"],
      clientHistory: ["1-to-9-hires", "10-plus-hires"],
    },
  },

  /// Wider net — keeps just the "verified" must-have. Use when high-ltv
  /// yields too few results for the niche you're sweeping.
  loose: {
    name: "loose",
    description: "Just `Payment verified`. Everything else open.",
    spec: {
      paymentVerified: true,
    },
  },

  /// "Reset" recipe — clears every filter the dialog exposes. Run before
  /// switching strategies if you want a clean slate without ticking the
  /// other recipes' boxes back on.
  clear: {
    name: "clear",
    description: "Clear all filters. Useful as a reset before a different recipe.",
    spec: {},
  },
};

export function getFilterRecipe(name: string): FilterRecipe | null {
  return FILTERS[name] ?? null;
}

export function listFilterRecipes(): FilterRecipe[] {
  return Object.values(FILTERS);
}
