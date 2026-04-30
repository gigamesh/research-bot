/// Signal extraction. For each RawPost that doesn't yet have Signals, asks
/// Claude to emit 0-N structured pain/wish/complaint records. Running on a
/// Max/Pro subscription via the Agent SDK, so token cost is effectively zero
/// per invocation — but we still keep the rubric cacheable and responses tight.
///
/// Run: `pnpm pipeline:signals [--limit 20]`

import "dotenv/config";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { extractJson } from "@/lib/claude";
import { runTextClassifier } from "@/lib/llm";

const SYSTEM = `You are a SaaS market-research analyst working for a solo founder behind
**bstockbuddy.com** (a SaaS that helps B-stock and other auction-marketplace
resellers research auctions and manage inventory). Your job is to read posts
and conversation threads from a private reseller community and extract
*structured signals* that could inform feature decisions for that product
(or a possible broader rebrand to "Reseller Buddy" serving any reseller).

Inputs are usually a top-level post followed by its comment thread. The body
will look like \`[Author] post text\` followed by \`[Author] comment text\`
lines indented by reply depth. **Treat every speaker as their own signal
source**: a comment that expresses a pain is its own signal, independent of
the post that prompted it.

A Signal is a canonical statement of one of:
- pain — something frustrating or costly about how they currently work
- wish — explicit "I wish there was…", "is there a tool that…"
- complaint — bad experience with an existing tool, revealing a gap
- current_spend — they explicitly say they pay / waste \$ or hours on X
- workflow — described manual/tedious process that could be automated
- feature_request — an idea explicitly framed as something a reseller tool
  should do (e.g. "would be great if [tool] also supported X")
- tool_mention — they name a specific tool/process they use, switched to,
  or switched away from (Vendoo, Sellbrite, ListPerfectly, Sortly, BrickSeek,
  bstock filters, GovDeals saved searches, etc.). Capture which tool, the
  context, and any reason given.

Rules:
- Only emit signals that reflect a CONCRETE, ACTIONABLE reseller workflow
  problem or tool gap. Ignore congratulations, motivational quotes, off-topic
  banter, and generic small-talk.
- The same conversation can yield many signals (one per speaker, sometimes
  multiple per speaker). Many conversations yield zero — that's fine.
- Each summary must be <=200 chars, in your own words, written from the
  speaker's perspective (e.g. "I waste 30 min per pallet manually researching
  Costco SKUs across 4 sites" — not "users want product research").
- For tool_mention signals, prefix the summary with \`<tool>: \` so clusters
  group cleanly.
- nicheTags: 1-4 short tags identifying the niche/workflow. Lean into
  reseller-domain vocabulary. Good tags: \`bstock\`, \`liquidation\`,
  \`govdeals\`, \`amazon-fba\`, \`ebay-reseller\`, \`poshmark\`, \`whatnot\`,
  \`facebook-marketplace\`, \`inventory-mgmt\`, \`sourcing\`,
  \`auction-research\`, \`reseller-tools\`, \`pricing-research\`,
  \`shipping\`, \`returns\`, \`storage-units\`. Prefer specific over generic
  (\`bstock-pallet-research\` beats \`reseller-tools\`).

Output: a single JSON code block with this exact shape:
\`\`\`json
{
  "signals": [
    {
      "kind": "pain" | "wish" | "complaint" | "current_spend" | "workflow" | "feature_request" | "tool_mention",
      "summary": "<=200 chars canonical statement",
      "nicheTags": ["tag1", "tag2"]
    }
  ]
}
\`\`\`

If the conversation has no actionable signal, return \`{ "signals": [] }\`.
Do not add any prose outside the JSON block.`;

const SignalSchema = z.object({
  kind: z.enum([
    "pain",
    "wish",
    "complaint",
    "current_spend",
    "workflow",
    "feature_request",
    "tool_mention",
  ]),
  summary: z.string().min(1).max(400),
  nicheTags: z.array(z.string()).default([]),
});
const ExtractSchema = z.object({ signals: z.array(SignalSchema) });

type ExtractedSignal = z.infer<typeof SignalSchema>;
type PostWithSource = {
  id: string;
  url: string;
  title: string | null;
  body: string;
  source: { name: string };
};

const SNIPPET_CHARS = 500;
const SEP = "─".repeat(72);

/// Pretty-print a post + the signals Claude extracted from it. Shown live
/// during `pipeline:signals` so you can validate extraction quality without
/// waiting for a db:studio round-trip.
function printSignalBlock(post: PostWithSource, signals: ExtractedSignal[]): void {
  const combined = [post.title, post.body].filter(Boolean).join(" — ");
  const collapsed = combined.replace(/\s+/g, " ").trim();
  const snippet =
    collapsed.length > SNIPPET_CHARS
      ? `${collapsed.slice(0, SNIPPET_CHARS)}…`
      : collapsed;

  const lines: string[] = [
    "",
    SEP,
    `[signals] ${post.id.slice(0, 8)}  +${signals.length}  (${post.source.name})`,
    `  url    : ${post.url}`,
    `  post   : ${snippet}`,
    "",
  ];
  for (const s of signals) {
    lines.push(`  ▸ [${s.kind}] ${s.summary}`);
    if (s.nicheTags.length) {
      lines.push(`    tags: ${s.nicheTags.join(", ")}`);
    }
  }
  lines.push(SEP);
  console.log(lines.join("\n"));
}

async function run() {
  const limitArg = process.argv.indexOf("--limit");
  const limit = limitArg >= 0 ? Number(process.argv[limitArg + 1] ?? 20) : 20;

  // Posts never seen by the signals stage. processedAt is set after each
  // successful Claude response (even zero-signal), so we never re-evaluate
  // the same post. Failures leave processedAt null so they get retried.
  const posts = await prisma.rawPost.findMany({
    where: { processedAt: null },
    orderBy: { fetchedAt: "desc" },
    take: limit,
    include: { source: true },
  });

  console.log(`[signals] processing ${posts.length} posts`);
  let totalSignals = 0;

  for (const post of posts) {
    const userPrompt =
      `Source: ${post.source.name}\n` +
      `URL: ${post.url}\n` +
      (post.title ? `Title: ${post.title}\n` : "") +
      `\n${post.body.slice(0, 4000)}`;

    try {
      const raw = await runTextClassifier({ systemPrompt: SYSTEM, userPrompt });
      const parsed = ExtractSchema.parse(extractJson(raw));

      // Atomic: create signals and mark processed together, so a crash can't
      // leave signals behind without the processed flag (which would cause
      // duplicate signals on the next run).
      await prisma.$transaction([
        ...parsed.signals.map((sig) =>
          prisma.signal.create({
            data: {
              rawPostId: post.id,
              kind: sig.kind,
              summary: sig.summary.slice(0, 400),
              nicheTags: sig.nicheTags.slice(0, 4).join(","),
            },
          }),
        ),
        prisma.rawPost.update({
          where: { id: post.id },
          data: { processedAt: new Date() },
        }),
      ]);

      totalSignals += parsed.signals.length;
      if (parsed.signals.length === 0) {
        console.log(`[signals]   ${post.id.slice(0, 8)}  (0 signals)`);
      } else {
        printSignalBlock(post, parsed.signals);
      }
    } catch (err) {
      console.error(`[signals]   ${post.id.slice(0, 8)}  FAILED: ${(err as Error).message}`);
    }
  }

  console.log(`[signals] done. total new signals: ${totalSignals}`);
  await prisma.$disconnect();
}

run().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
