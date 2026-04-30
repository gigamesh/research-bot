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

const SYSTEM = `You are a market-research analyst evaluating whether a cluster of pain
points from a B-stock and online-reseller community could become a feature
for **bstockbuddy.com** (working name: **Reseller Buddy**), a SaaS that
helps resellers research auction listings, source inventory, and manage
what they buy. The product is currently bstock-specific but is considering
a broader rebrand to serve any auction-marketplace reseller (Whatnot,
Liquidation.com, GovDeals, public-storage auctions, eBay sourcing).

You receive a cluster of related signals mined from a private reseller
community. Decide if this cluster represents a feature worth building, and
score it.

Scoring rubric (every score is 0-10, integers or one decimal):

- soloDevScore: how feasible is this for ONE founder (the user) to build,
  ship, and support inside an existing reseller-research SaaS?
  10 = obvious next-page or background job in their existing stack.
  0 = needs a team, regulated data, hardware, or network-effects to work.

- demandScore: signal density × reseller intensity.
  10 = many independent resellers asking for exactly this, recent, with
  emotional charge or repeat mentions across threads. 0 = single tangential
  mention.

- monetizationScore: would resellers pay for this feature? Look for current
  spend on tools (Vendoo, Sellbrite, ListPerfectly, Sortly, BrickSeek,
  AuctionInc, etc.), time costs, lost margin, sourcing-fees-for-info, or
  unwillingness expressed about other tools. 10 = users name $/mo they're
  already paying or hours/week being burned. 0 = free-tool-seekers only.

- competitionScore: how crowded is this in the reseller-tooling space?
  10 = several established reseller tools already do this well.
  0 = nobody serves this niche. (Penalty in the final score: higher = worse.)

- bstockSpecificity: how tightly does this cluster fit B-stock pallet
  workflows specifically?
  10 = bstock-only (e.g. parsing bstock manifest CSVs, unique-bid logic,
  reading marketplace category filters). 0 = applies to any reseller
  regardless of sourcing channel (e.g. listing across multiple platforms,
  inventory location tracking). 5 = relevant to several auction marketplaces
  including bstock. This score is recorded but does NOT penalize the overall
  rank — it informs the rebrand decision.

- estMrrCeiling: integer dollars/month the *whole product* could plausibly
  reach if it shipped this feature well. Reseller SaaS typically tops out
  at $50k-$300k/mo. Say 0 if unsure.

- estCacBand: "low" (community + organic SEO can carry it), "medium"
  (needs paid YouTube/TikTok or partnerships), "high" (heavy sales motion).

Process:
1. Skim the signals below — identify the core underlying problem and which
   marketplaces it applies to.
2. Use WebSearch to check competition and pricing. Try queries like
   "<feature> reseller tool", "vendoo alternative <feature>",
   "bstock <pain>", "<marketplace> reseller software".
   1-3 searches max.
3. Optionally WebFetch one pricing page if it clarifies willingness-to-pay.
4. Emit the JSON scorecard.

Output: a single JSON code block, nothing else:
\`\`\`json
{
  "title": "short <=80 char name for this opportunity",
  "oneLiner": "one sentence description",
  "niche": "short tag like 'bstock-pallet-research' or 'multi-platform-listing'",
  "soloDevScore": 0.0,
  "demandScore": 0.0,
  "monetizationScore": 0.0,
  "competitionScore": 0.0,
  "bstockSpecificity": 0.0,
  "estMrrCeiling": 0,
  "estCacBand": "low" | "medium" | "high" | null,
  "notes": "2-5 short paragraphs in markdown: the problem, who in the community is voicing it (post authors / commenters), what you would actually build, the strongest and weakest signals, top 2-3 existing competitors with pricing if known, and a one-line verdict at the end of the form: 'verdict: build into bstockbuddy' or 'verdict: build into broader Reseller Buddy' or 'verdict: pass'."
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
  bstockSpecificity: z.number().default(0),
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
          bstockSpecificity: clamp(parsed.bstockSpecificity),
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
