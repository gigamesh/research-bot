/// Embed all Signals that don't yet have an embedding. Uses Ollama locally.
///
/// Default model: mxbai-embed-large (1024-dim). Better at paraphrase
/// recognition than nomic-embed-text, at the cost of 669 MB vs 274 MB RAM.
/// Install with:
///   brew install ollama && ollama serve
///   ollama pull mxbai-embed-large
///
/// Run:
///   pnpm pipeline:embed                # embed new signals only
///   pnpm pipeline:embed --reset        # wipe ALL embeddings + clusters, re-embed
///
/// --reset semantics: changing embedding models invalidates everything
/// clustering-related (different meaning space, different dimensions), so
/// --reset clears Signal.embedding for every row AND deletes all Opportunity
/// rows (and their Evidence via cascade). Researched opps are exported to a
/// timestamped backup JSON in the repo root before deletion, so you don't
/// silently lose scorecards you invested Claude calls in.

import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { Ollama } from "ollama";
import { prisma } from "@/lib/db";
import { buffersFromFloats } from "@/lib/similarity";

const MODEL = process.env.OLLAMA_EMBED_MODEL ?? "mxbai-embed-large";
const HOST = process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434";

async function backupResearchedOpps(): Promise<string | null> {
  const researched = await prisma.opportunity.findMany({
    where: { researchedAt: { not: null } },
    include: {
      evidence: {
        include: { signal: { select: { summary: true, kind: true } } },
      },
    },
  });
  if (researched.length === 0) return null;

  const payload = {
    exportedAt: new Date().toISOString(),
    version: 1,
    reason: "pipeline:embed --reset (embedding model or clusters invalidated)",
    opportunities: researched.map((o) => ({
      id: o.id,
      title: o.title,
      oneLiner: o.oneLiner,
      niche: o.niche,
      status: o.status,
      score: o.score,
      soloDevScore: o.soloDevScore,
      demandScore: o.demandScore,
      monetizationScore: o.monetizationScore,
      competitionScore: o.competitionScore,
      estMrrCeiling: o.estMrrCeiling,
      estCacBand: o.estCacBand,
      notes: o.notes,
      researchedAt: o.researchedAt,
      evidenceSignalSummaries: o.evidence.map((e) => ({
        kind: e.signal.kind,
        summary: e.signal.summary,
      })),
    })),
  };

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `research-backup-${stamp}.json`;
  const filepath = path.resolve(process.cwd(), filename);
  await fs.writeFile(filepath, JSON.stringify(payload, null, 2), "utf8");
  return filepath;
}

async function run() {
  const reset = process.argv.includes("--reset");

  if (reset) {
    console.log(`[embed] --reset: backing up researched opportunities...`);
    const backupPath = await backupResearchedOpps();
    if (backupPath) {
      console.log(`[embed] --reset: wrote backup to ${backupPath}`);
    } else {
      console.log(`[embed] --reset: no researched opportunities to back up`);
    }

    const oppCount = await prisma.opportunity.count();
    const delOpps = await prisma.opportunity.deleteMany({});
    console.log(`[embed] --reset: deleted ${delOpps.count} opportunities (${oppCount} expected; Evidence cascaded)`);

    const cleared = await prisma.signal.updateMany({
      where: { embedding: { not: null } },
      data: { embedding: null },
    });
    console.log(`[embed] --reset: cleared embeddings on ${cleared.count} signals`);
  }

  const ollama = new Ollama({ host: HOST });

  const signals = await prisma.signal.findMany({
    where: { embedding: null },
    orderBy: { createdAt: "asc" },
  });
  console.log(`[embed] ${signals.length} signals to embed with ${MODEL}`);

  let done = 0;
  for (const sig of signals) {
    try {
      const res = await ollama.embeddings({ model: MODEL, prompt: sig.summary });
      const vec = new Float32Array(res.embedding);
      await prisma.signal.update({
        where: { id: sig.id },
        data: { embedding: buffersFromFloats(vec) },
      });
      done++;
      if (done % 100 === 0) console.log(`[embed]   ${done}/${signals.length}`);
    } catch (err) {
      console.error(`[embed]   ${sig.id.slice(0, 8)} FAILED: ${(err as Error).message}`);
    }
  }

  console.log(`[embed] done — embedded ${done}/${signals.length}`);
  await prisma.$disconnect();
}

run().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
