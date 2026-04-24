/// Greedy cosine-threshold clustering. For each signal not yet linked to an
/// Opportunity (via Evidence), find the best existing centroid above the
/// threshold and attach it. If none, create a new candidate Opportunity with
/// that signal as its seed.
///
/// This is deliberately simple — no HDBSCAN, no refinement passes. At <100k
/// signals it runs in-memory in a few seconds, and any clustering mistake gets
/// corrected on re-run since we never "lock" a signal to a cluster permanently
/// (we just skip already-linked signals).
///
/// Run: `pnpm pipeline:cluster [--threshold 0.82]`

import "dotenv/config";
import { prisma } from "@/lib/db";
import { cosine, floatsFromBuffer, buffersFromFloats, updatedCentroid } from "@/lib/similarity";

async function run() {
  const threshArg = process.argv.indexOf("--threshold");
  const threshold = threshArg >= 0 ? Number(process.argv[threshArg + 1] ?? 0.82) : 0.82;

  // Load existing opportunities w/ centroid + member count
  const opportunities = await prisma.opportunity.findMany({
    where: { centroid: { not: null } },
    include: { _count: { select: { evidence: true } } },
  });

  const clusters = opportunities
    .filter((o) => o.centroid)
    .map((o) => ({
      id: o.id,
      centroid: floatsFromBuffer(o.centroid!),
      memberCount: o._count.evidence,
    }));

  // Load signals with embeddings that are not yet linked to any opportunity.
  const signals = await prisma.signal.findMany({
    where: {
      embedding: { not: null },
      evidence: { none: {} },
    },
    include: { rawPost: true },
    orderBy: { createdAt: "asc" },
  });
  console.log(`[cluster] ${signals.length} unlinked signals; ${clusters.length} existing clusters`);

  let attached = 0;
  let created = 0;

  for (const sig of signals) {
    const vec = floatsFromBuffer(sig.embedding!);
    let best: { idx: number; sim: number } | null = null;
    for (let i = 0; i < clusters.length; i++) {
      const sim = cosine(vec, clusters[i]!.centroid);
      if (sim > (best?.sim ?? -Infinity)) best = { idx: i, sim };
    }

    if (best && best.sim >= threshold) {
      // Attach + recompute centroid.
      const c = clusters[best.idx]!;
      const newCentroid = updatedCentroid(c.centroid, c.memberCount, vec);
      await prisma.$transaction([
        prisma.evidence.create({
          data: { opportunityId: c.id, signalId: sig.id, weight: best.sim },
        }),
        prisma.opportunity.update({
          where: { id: c.id },
          data: { centroid: buffersFromFloats(newCentroid) },
        }),
      ]);
      clusters[best.idx] = {
        id: c.id,
        centroid: newCentroid,
        memberCount: c.memberCount + 1,
      };
      attached++;
    } else {
      // New candidate opportunity.
      const title = sig.summary.slice(0, 80);
      const tags = sig.nicheTags.split(",").filter(Boolean);
      const niche = tags[0] ?? null;
      const opp = await prisma.opportunity.create({
        data: {
          title,
          oneLiner: sig.summary,
          niche,
          centroid: buffersFromFloats(vec),
        },
      });
      await prisma.evidence.create({
        data: { opportunityId: opp.id, signalId: sig.id, weight: 1.0 },
      });
      clusters.push({ id: opp.id, centroid: vec, memberCount: 1 });
      created++;
    }
  }

  console.log(`[cluster] attached=${attached} created=${created}`);
  await prisma.$disconnect();
}

run().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
