/// Pure ROI scoring. Combines four 0-10 subscores from the research agent into a
/// single rank score. Kept outside the DB so we can tweak weights without a
/// migration and recompute on-read in the dashboard.

export type ScoreInput = {
  soloDevScore: number;      // higher = easier for one person
  demandScore: number;       // higher = stronger evidence of demand
  monetizationScore: number; // higher = stronger willingness-to-pay evidence
  competitionScore: number;  // higher = MORE competition (penalty)
};

export type ScoreWeights = {
  demand: number;
  monetization: number;
  soloDev: number;
  competitionPenalty: number;
};

/// Weights roughly favor monetization + demand. Competition is subtracted with
/// a mild coefficient — saturated markets aren't disqualifying, just penalized.
export const defaultWeights: ScoreWeights = {
  demand: 0.35,
  monetization: 0.35,
  soloDev: 0.30,
  competitionPenalty: 0.40,
};

export function computeScore(
  input: ScoreInput,
  weights: ScoreWeights = defaultWeights,
): number {
  const positive =
    input.demandScore * weights.demand +
    input.monetizationScore * weights.monetization +
    input.soloDevScore * weights.soloDev;
  const penalty = input.competitionScore * weights.competitionPenalty;
  return Math.max(0, positive - penalty);
}

export function clamp(value: number, min = 0, max = 10): number {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}
