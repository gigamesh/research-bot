/// Read-only diagnostic for the clustering stage. Dumps:
///   - cluster size distribution (how many opps have 1 signal vs 2 vs N)
///   - histogram of each singleton's nearest-neighbor similarity
///   - sample of N random singletons with their top-3 nearest clusters
///
/// Use this to decide whether your data is genuinely diverse (fix: more
/// volume in fewer niches) or the threshold is too tight (fix: lower
/// threshold + re-cluster).
///
/// Run: `pnpm inspect:clusters [--samples 20] [--only-singletons]`
///
/// Zero DB writes. Zero Claude calls.

import "dotenv/config";
import { prisma } from "@/lib/db";
import { cosine, floatsFromBuffer } from "@/lib/similarity";

type Loaded = {
  id: string;
  title: string;
  oneLiner: string;
  niche: string | null;
  centroid: Float32Array;
  evidenceCount: number;
};

const SIM_BUCKETS: Array<[number, number]> = [
  [0.0, 0.3],
  [0.3, 0.4],
  [0.4, 0.5],
  [0.5, 0.6],
  [0.6, 0.65],
  [0.65, 0.7],
  [0.7, 0.74],
  [0.74, 0.78],
  [0.78, 0.8],
  [0.8, 0.82],
  [0.82, 0.85],
  [0.85, 1.0],
];

function bucketFor(sim: number): number {
  for (let i = 0; i < SIM_BUCKETS.length; i++) {
    const [lo, hi] = SIM_BUCKETS[i]!;
    if (sim >= lo && sim < hi) return i;
  }
  return SIM_BUCKETS.length - 1;
}

function bar(count: number, max: number, width = 40): string {
  if (max === 0) return "";
  const filled = Math.round((count / max) * width);
  return "█".repeat(filled) + "░".repeat(Math.max(0, width - filled));
}

function pickRandom<T>(arr: T[], n: number): T[] {
  const copy = [...arr];
  const out: T[] = [];
  while (out.length < n && copy.length > 0) {
    const i = Math.floor(Math.random() * copy.length);
    out.push(copy.splice(i, 1)[0]!);
  }
  return out;
}

async function run() {
  const samplesArg = process.argv.indexOf("--samples");
  const samples = samplesArg >= 0 ? Number(process.argv[samplesArg + 1] ?? 20) : 20;

  const opps = await prisma.opportunity.findMany({
    where: { centroid: { not: null } },
    include: { _count: { select: { evidence: true } } },
  });

  const loaded: Loaded[] = opps.map((o) => ({
    id: o.id,
    title: o.title,
    oneLiner: o.oneLiner,
    niche: o.niche,
    centroid: floatsFromBuffer(o.centroid!),
    evidenceCount: o._count.evidence,
  }));

  if (loaded.length === 0) {
    console.log("No opportunities with centroids found. Run the pipeline first.");
    await prisma.$disconnect();
    return;
  }

  // ── Cluster size distribution ───────────────────────────────────────────
  const sizeHist = new Map<number, number>();
  for (const o of loaded) sizeHist.set(o.evidenceCount, (sizeHist.get(o.evidenceCount) ?? 0) + 1);
  const sortedSizes = [...sizeHist.entries()].sort((a, b) => a[0] - b[0]);
  const maxSizeCount = Math.max(...sizeHist.values());

  const singletons = loaded.filter((o) => o.evidenceCount === 1);
  const multi = loaded.filter((o) => o.evidenceCount > 1);
  const meanMulti =
    multi.length === 0
      ? 0
      : multi.reduce((s, o) => s + o.evidenceCount, 0) / multi.length;
  const maxSize = Math.max(0, ...loaded.map((o) => o.evidenceCount));

  console.log("━".repeat(72));
  console.log("Cluster size distribution");
  console.log("━".repeat(72));
  console.log(
    `total opportunities    : ${loaded.length}`,
  );
  console.log(
    `singletons             : ${singletons.length}  (${((singletons.length / loaded.length) * 100).toFixed(1)}%)`,
  );
  console.log(
    `multi-signal clusters  : ${multi.length}  (avg size ${meanMulti.toFixed(2)}, max ${maxSize})`,
  );
  console.log("");
  console.log("signals/cluster  count     bar");
  for (const [size, count] of sortedSizes) {
    console.log(
      `  ${String(size).padStart(4)} signal${size === 1 ? " " : "s"}  ${String(count).padStart(5)}  ${bar(count, maxSizeCount, 40)}`,
    );
  }

  // ── Nearest-neighbor similarity histogram for singletons ───────────────
  console.log("");
  console.log("━".repeat(72));
  console.log("Nearest-neighbor cosine similarity for singletons");
  console.log("━".repeat(72));
  console.log(
    `For each singleton, computed cosine vs every OTHER opportunity's centroid`,
  );
  console.log(`and took the max. Peak location tells you about clustering behavior:`);
  console.log(`  peak in [0.5-0.7) → data is diverse, threshold is fine`);
  console.log(`  peak in [0.74-0.82) → threshold too tight, many near-misses`);
  console.log("");

  const singletonNearest: { opp: Loaded; bestSim: number; bestMatch: Loaded | null }[] = [];
  for (const s of singletons) {
    let best = { sim: -Infinity, match: null as Loaded | null };
    for (const other of loaded) {
      if (other.id === s.id) continue;
      const sim = cosine(s.centroid, other.centroid);
      if (sim > best.sim) best = { sim, match: other };
    }
    singletonNearest.push({ opp: s, bestSim: best.sim, bestMatch: best.match });
  }

  const histogram = new Array(SIM_BUCKETS.length).fill(0);
  for (const n of singletonNearest) histogram[bucketFor(n.bestSim)]++;
  const maxBucket = Math.max(...histogram);

  for (let i = 0; i < SIM_BUCKETS.length; i++) {
    const [lo, hi] = SIM_BUCKETS[i]!;
    const label = `[${lo.toFixed(2)}-${hi.toFixed(2)})`;
    const count = histogram[i];
    const mark =
      lo >= 0.74 && lo < 0.82 ? "  ← near-miss band" : lo >= 0.82 ? "  ← above threshold (shouldn't exist!)" : "";
    console.log(
      `  ${label.padEnd(14)}  ${String(count).padStart(5)}  ${bar(count, maxBucket, 40)}${mark}`,
    );
  }

  // ── Sample random singletons with their top-3 neighbors ────────────────
  console.log("");
  console.log("━".repeat(72));
  console.log(`Random sample: ${Math.min(samples, singletons.length)} singletons with top-3 nearest clusters`);
  console.log("━".repeat(72));
  console.log(
    "Eyeball these. If the top-1 neighbor is clearly the SAME underlying pain",
  );
  console.log(
    "(especially for sim >= 0.74), that's evidence the threshold is too tight.",
  );

  const picked = pickRandom(singletons, samples);
  for (let i = 0; i < picked.length; i++) {
    const s = picked[i]!;
    const scored = loaded
      .filter((o) => o.id !== s.id)
      .map((o) => ({ o, sim: cosine(s.centroid, o.centroid) }))
      .sort((a, b) => b.sim - a.sim)
      .slice(0, 3);

    console.log("");
    console.log(`──── ${i + 1}/${picked.length}  ${s.id.slice(0, 8)}  niche=${s.niche ?? "—"} ────`);
    console.log(`  signal : ${s.oneLiner}`);
    for (let j = 0; j < scored.length; j++) {
      const { o, sim } = scored[j]!;
      const flag = sim >= 0.82 ? " ★" : sim >= 0.74 ? " ⚠" : "";
      console.log(
        `  near-${j + 1} : sim=${sim.toFixed(3)}${flag}  (${o.evidenceCount} sig${o.evidenceCount === 1 ? " " : "s"}, niche=${o.niche ?? "—"})`,
      );
      console.log(`           ${o.oneLiner}`);
    }
  }

  console.log("");
  console.log(`(★ = above current 0.82 threshold, shouldn't be singletons)`);
  console.log(`(⚠ = in near-miss band 0.74-0.82, candidates for threshold loosening)`);
  await prisma.$disconnect();
}

run().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
