import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { setStatus } from "./actions";

export const dynamic = "force-dynamic";

export default async function OpportunityPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const opp = await prisma.opportunity.findUnique({
    where: { id },
    include: {
      evidence: {
        include: {
          signal: {
            include: {
              rawPost: { include: { source: true } },
            },
          },
        },
        orderBy: { weight: "desc" },
      },
    },
  });

  if (!opp) notFound();

  const formatScore = (n: number) => n.toFixed(1);

  return (
    <div className="max-w-4xl mx-auto px-6 py-8">
      <Link href="/" className="text-sm text-zinc-500 hover:underline">
        ← all opportunities
      </Link>

      <div className="mt-3 mb-6 flex items-start justify-between gap-6">
        <div>
          <h1 className="text-3xl font-semibold mb-1">{opp.title}</h1>
          <p className="text-zinc-600 dark:text-zinc-400 text-lg">{opp.oneLiner}</p>
          <div className="mt-2 flex flex-wrap gap-2 text-sm">
            {opp.niche && (
              <span className="font-mono bg-zinc-100 dark:bg-zinc-800 px-2 py-0.5 rounded">
                {opp.niche}
              </span>
            )}
            <span className="font-mono bg-zinc-100 dark:bg-zinc-800 px-2 py-0.5 rounded">
              status: {opp.status}
            </span>
            {opp.estMrrCeiling ? (
              <span className="text-zinc-500">
                ~${opp.estMrrCeiling.toLocaleString()}/mo ceiling · CAC: {opp.estCacBand ?? "?"}
              </span>
            ) : null}
          </div>
        </div>
        <div className="font-mono text-5xl font-bold tabular-nums">{opp.score.toFixed(1)}</div>
      </div>

      <div className="grid grid-cols-5 gap-3 mb-6">
        <Scorecard label="demand" value={formatScore(opp.demandScore)} />
        <Scorecard label="monetization" value={formatScore(opp.monetizationScore)} />
        <Scorecard label="solo-dev" value={formatScore(opp.soloDevScore)} />
        <Scorecard label="competition" value={formatScore(opp.competitionScore)} variant="penalty" />
        <Scorecard
          label="bstock fit"
          value={formatScore(opp.bstockSpecificity)}
          variant="info"
          tooltip="10 = bstock-pallet-only. 0 = applies to any reseller."
        />
      </div>

      <div className="mb-6 flex flex-wrap gap-2">
        {["candidate", "promoted", "snoozed", "dismissed"].map((s) => (
          <form key={s} action={setStatus}>
            <input type="hidden" name="id" value={opp.id} />
            <input type="hidden" name="status" value={s} />
            <button
              type="submit"
              disabled={opp.status === s}
              className={`px-3 py-1 rounded text-sm border ${
                opp.status === s
                  ? "bg-zinc-900 dark:bg-zinc-100 text-zinc-100 dark:text-zinc-900 border-transparent cursor-default"
                  : "border-zinc-300 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800"
              }`}
            >
              {s}
            </button>
          </form>
        ))}
      </div>

      {opp.notes ? (
        <section className="mb-8">
          <h2 className="text-sm uppercase tracking-wide text-zinc-500 mb-2">notes</h2>
          <div className="prose prose-sm dark:prose-invert max-w-none bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded p-4 whitespace-pre-wrap">
            {opp.notes}
          </div>
        </section>
      ) : (
        <section className="mb-8 text-zinc-500 text-sm">
          Not yet researched. Run <code className="font-mono bg-zinc-100 dark:bg-zinc-800 px-1 rounded">pnpm pipeline:research</code>.
        </section>
      )}

      <section>
        <EvidenceList evidence={opp.evidence} />
      </section>
    </div>
  );
}

function Scorecard({
  label,
  value,
  variant,
  tooltip,
}: {
  label: string;
  value: string;
  variant?: "penalty" | "info";
  tooltip?: string;
}) {
  const styles =
    variant === "penalty"
      ? "border-rose-300 dark:border-rose-800 bg-rose-50 dark:bg-rose-950/30"
      : variant === "info"
        ? "border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30"
        : "border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900";
  return (
    <div className={`border rounded p-3 ${styles}`} title={tooltip}>
      <div className="text-xs uppercase tracking-wide text-zinc-500">{label}</div>
      <div className="font-mono text-2xl font-semibold tabular-nums">{value}</div>
    </div>
  );
}

type EvidenceItem = {
  id: string;
  weight: number;
  signal: {
    kind: string;
    summary: string;
    nicheTags: string;
    rawPost: {
      id: string;
      url: string;
      title: string | null;
      author: string | null;
      source: { name: string };
    };
  };
};

/// Groups evidence by source post so the same conversation thread doesn't
/// appear as N separate "independent" cards. Multi-signal posts (one yielding
/// a `pain` and a `wish` from different speakers) collapse into a single card
/// listing all facets, with the post URL deep-linking back into the
/// shannonjean.info thread.
function EvidenceList({ evidence }: { evidence: EvidenceItem[] }) {
  const byPost = new Map<string, EvidenceItem[]>();
  for (const e of evidence) {
    const arr = byPost.get(e.signal.rawPost.id);
    if (arr) arr.push(e);
    else byPost.set(e.signal.rawPost.id, [e]);
  }
  for (const arr of byPost.values()) {
    arr.sort((a, b) => b.weight - a.weight);
  }
  const groups = [...byPost.values()].sort(
    (a, b) => Math.max(...b.map((e) => e.weight)) - Math.max(...a.map((e) => e.weight)),
  );

  const signalCount = evidence.length;
  const postCount = groups.length;
  const header =
    signalCount === postCount
      ? `evidence (${postCount} post${postCount === 1 ? "" : "s"})`
      : `evidence (${signalCount} signals from ${postCount} post${postCount === 1 ? "" : "s"})`;

  return (
    <>
      <h2 className="text-sm uppercase tracking-wide text-zinc-500 mb-2">{header}</h2>
      <ul className="border border-zinc-200 dark:border-zinc-800 rounded bg-white dark:bg-zinc-900 divide-y divide-zinc-200 dark:divide-zinc-800">
        {groups.map((group) => {
          const post = group[0]!.signal.rawPost;
          return (
            <li key={post.id} className="px-4 py-3">
              <div className="flex items-baseline justify-between gap-3 text-xs text-zinc-500 font-mono">
                <a
                  href={post.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:underline truncate"
                >
                  {post.title ?? post.url} ↗
                </a>
                <span className="shrink-0">
                  {post.author ? `${post.author} · ` : ""}
                  {post.source.name}
                  {group.length > 1 ? ` · ${group.length} signals` : ""}
                </span>
              </div>
              <ul className="mt-2 space-y-2">
                {group.map((e) => {
                  const s = e.signal;
                  return (
                    <li key={e.id} className="border-l-2 border-zinc-200 dark:border-zinc-700 pl-3">
                      <div className="flex items-baseline justify-between gap-3 text-sm">
                        <span className="font-mono text-xs bg-zinc-100 dark:bg-zinc-800 px-1.5 py-0.5 rounded">
                          {s.kind}
                        </span>
                        <span className="text-xs text-zinc-500 font-mono shrink-0">
                          sim {e.weight.toFixed(2)}
                        </span>
                      </div>
                      <p className="mt-1">{s.summary}</p>
                      {s.nicheTags ? (
                        <div className="mt-1 flex flex-wrap gap-2 text-xs text-zinc-500">
                          {s.nicheTags
                            .split(",")
                            .filter(Boolean)
                            .map((t) => (
                              <span key={t} className="font-mono">#{t}</span>
                            ))}
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </li>
          );
        })}
      </ul>
    </>
  );
}
