/// Deep-dive each candidate opportunity with the Claude Agent SDK.
/// For each unresearched (or stale) Opportunity with >=N signals, the agent:
///   1. reads the cluster's signals
///   2. uses WebSearch/WebFetch to sanity-check existing competitors + pricing
///   3. emits a structured scorecard + notes
///
/// Run: `pnpm pipeline:research [--limit 5] [--min-signals 2]`

import "dotenv/config";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { runClaude, extractJson } from "@/lib/claude";
import { clamp, computeScore } from "@/lib/scoring";

const SYSTEM = `You are a SaaS market-research analyst evaluating niche opportunities for a
SOLO developer aiming for ~$15k/mo profit with favorable CAC/LTV. You will
receive a cluster of related pain-point signals mined from public sources.

Your job: decide if this is a real, solo-feasible opportunity and score it.

Scoring rubric (every score is 0-10, integers or one decimal):

- soloDevScore: how feasible is this for ONE person to build, ship, and support?
  10 = weekend MVP, obvious stack. 0 = needs a team, regulated, network-effects.

- demandScore: how much real, active demand does the cluster show?
  10 = multiple independent users explicitly asking for exactly this, recent.
  0 = one vague post, no willingness-to-pay signal.

- monetizationScore: is willingness-to-pay clear?
  10 = users explicitly mention paying / currently paying $X/mo for a worse
  alternative. 0 = free-tool-seekers with no revenue signal.

- competitionScore: how crowded is this space?
  10 = dozens of well-funded incumbents, saturated. 0 = nobody serves this niche.
  (This is a penalty in the final score, so higher = worse.)

- estMrrCeiling: integer dollars/month this could plausibly reach for a solo
  dev in 18 months. Be realistic. Most niches are <$30k. Say 0 if unsure.

- estCacBand: "low" (organic/SEO can carry it), "medium" (needs some paid
  acquisition), or "high" (requires heavy sales motion). null if unsure.

Process:
1. Skim the signals below — identify the core underlying problem.
2. Use WebSearch to check: "top [niche] tools", "[problem] software",
   and look for existing solutions + pricing. 1-3 searches max.
3. Optionally WebFetch one pricing page if it clarifies willingness-to-pay.
4. Emit the JSON scorecard.

Output: a single JSON code block, nothing else:
\`\`\`json
{
  "title": "short <=80 char name for this opportunity",
  "oneLiner": "one sentence description",
  "niche": "short tag like 'etsy-sellers' or 'solo-lawyers'",
  "soloDevScore": 0.0,
  "demandScore": 0.0,
  "monetizationScore": 0.0,
  "competitionScore": 0.0,
  "estMrrCeiling": 0,
  "estCacBand": "low" | "medium" | "high" | null,
  "notes": "2-5 short paragraphs in markdown: the problem, target user, what would you actually build, the strongest and weakest signals, top 2-3 existing competitors with pricing if known, and a honest verdict (ship / investigate / pass)."
}
\`\`\`
`;

const ResearchSchema = z.object({
  title: z.string().max(120),
  oneLiner: z.string().max(300),
  niche: z.string().max(60).nullable().optional(),
  soloDevScore: z.number(),
  demandScore: z.number(),
  monetizationScore: z.number(),
  competitionScore: z.number(),
  estMrrCeiling: z.number().int().nullable().optional(),
  estCacBand: z.enum(["low", "medium", "high"]).nullable().optional(),
  notes: z.string(),
});

async function run() {
  const limitArg = process.argv.indexOf("--limit");
  const minArg = process.argv.indexOf("--min-signals");
  const limit = limitArg >= 0 ? Number(process.argv[limitArg + 1] ?? 5) : 5;
  // --min-signals filters on DISTINCT POSTS, not raw signals. The flag name
  // stays for backward compatibility, but the semantics measure independent
  // confluence (different posters complaining about the same thing) instead
  // of being inflatable by a single ranty post that yielded multiple signals.
  const minPosts = minArg >= 0 ? Number(process.argv[minArg + 1] ?? 2) : 2;

  // Sort by signal count desc — clusters with more confluence are stronger
  // opportunities and should consume our Claude budget first. Secondary sort
  // by createdAt asc keeps re-runs deterministic across ties.
  const opps = await prisma.opportunity.findMany({
    where: { researchedAt: null, status: "candidate" },
    include: {
      evidence: {
        include: { signal: { include: { rawPost: true } } },
        take: 12,
      },
      _count: { select: { evidence: true } },
    },
    orderBy: [{ evidence: { _count: "desc" } }, { createdAt: "asc" }],
  });

  const eligible = opps
    .filter((o) => {
      const distinctPosts = new Set(o.evidence.map((e) => e.signal.rawPostId));
      return distinctPosts.size >= minPosts;
    })
    .slice(0, limit);
  console.log(
    `[research] ${eligible.length} opportunities to research (of ${opps.length} candidates; min-posts=${minPosts})`,
  );

  for (const opp of eligible) {
    const signalsBlock = opp.evidence
      .map((e, i) => {
        const s = e.signal;
        const url = s.rawPost.url;
        return `${i + 1}. [${s.kind}] ${s.summary}\n   tags: ${s.nicheTags || "—"}\n   source: ${url}`;
      })
      .join("\n\n");

    const userPrompt =
      `Candidate title: ${opp.title}\n` +
      `Initial niche guess: ${opp.niche ?? "unknown"}\n\n` +
      `--- signals in this cluster ---\n\n${signalsBlock}\n`;

    try {
      const raw = await runClaude({
        systemPrompt: SYSTEM,
        userPrompt,
        tools: ["WebSearch", "WebFetch"],
        maxTurns: 6,
        model: "sonnet",
      });
      const parsed = ResearchSchema.parse(extractJson(raw));

      const scored = computeScore({
        soloDevScore: clamp(parsed.soloDevScore),
        demandScore: clamp(parsed.demandScore),
        monetizationScore: clamp(parsed.monetizationScore),
        competitionScore: clamp(parsed.competitionScore),
      });

      await prisma.opportunity.update({
        where: { id: opp.id },
        data: {
          title: parsed.title,
          oneLiner: parsed.oneLiner,
          niche: parsed.niche ?? opp.niche,
          soloDevScore: clamp(parsed.soloDevScore),
          demandScore: clamp(parsed.demandScore),
          monetizationScore: clamp(parsed.monetizationScore),
          competitionScore: clamp(parsed.competitionScore),
          estMrrCeiling: parsed.estMrrCeiling ?? null,
          estCacBand: parsed.estCacBand ?? null,
          notes: parsed.notes,
          score: scored,
          researchedAt: new Date(),
        },
      });
      console.log(`[research]   ${opp.id.slice(0, 8)}  score=${scored.toFixed(2)}  "${parsed.title}"`);
    } catch (err) {
      console.error(`[research]   ${opp.id.slice(0, 8)}  FAILED: ${(err as Error).message}`);
    }
  }

  console.log(`[research] done`);
  await prisma.$disconnect();
}

run().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
