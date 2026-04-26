import Link from "next/link";
import { prisma } from "@/lib/db";
import { computeScore } from "@/lib/scoring";

export const dynamic = "force-dynamic";

type SearchParams = {
  niche?: string;
  min?: string;
  status?: string;
  researched?: string; // "yes" (default) | "no" | "all"
};

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const minScore = params.min ? Number(params.min) : 0;
  const status = params.status ?? "candidate";
  const researched = params.researched ?? "yes";

  const researchedFilter =
    researched === "yes"
      ? { researchedAt: { not: null } }
      : researched === "no"
        ? { researchedAt: null }
        : {};

  const opps = await prisma.opportunity.findMany({
    where: {
      status,
      score: { gte: minScore },
      ...researchedFilter,
      ...(params.niche ? { niche: params.niche } : {}),
    },
    include: {
      _count: { select: { evidence: true } },
    },
    orderBy: [{ score: "desc" }, { createdAt: "desc" }],
    take: 100,
  });

  const niches = await prisma.opportunity.findMany({
    where: { niche: { not: null } },
    select: { niche: true },
    distinct: ["niche"],
    orderBy: { niche: "asc" },
  });

  const statusOptions = ["candidate", "promoted", "snoozed", "dismissed"];

  return (
    <div className="max-w-6xl mx-auto px-6 py-8">
      <div className="flex items-baseline justify-between mb-6">
        <h1 className="text-2xl font-semibold">Opportunities</h1>
        <span className="text-sm text-zinc-500">{opps.length} result{opps.length === 1 ? "" : "s"}</span>
      </div>

      <form className="flex flex-wrap gap-3 mb-6 text-sm" action="/">
        <div className="flex items-center gap-2">
          <label className="text-zinc-500">status</label>
          <select
            name="status"
            defaultValue={status}
            className="bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 rounded px-2 py-1"
          >
            {statusOptions.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-zinc-500">researched</label>
          <select
            name="researched"
            defaultValue={researched}
            className="bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 rounded px-2 py-1"
          >
            <option value="yes">yes</option>
            <option value="no">no</option>
            <option value="all">all</option>
          </select>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-zinc-500">niche</label>
          <select
            name="niche"
            defaultValue={params.niche ?? ""}
            className="bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 rounded px-2 py-1"
          >
            <option value="">any</option>
            {niches.map((n) => (
              <option key={n.niche!} value={n.niche!}>{n.niche}</option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-zinc-500">min score</label>
          <input
            name="min"
            type="number"
            step="0.1"
            min="0"
            max="10"
            defaultValue={params.min ?? ""}
            className="bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 rounded px-2 py-1 w-20"
          />
        </div>
        <button
          type="submit"
          className="bg-zinc-900 dark:bg-zinc-100 text-zinc-100 dark:text-zinc-900 rounded px-3 py-1"
        >
          apply
        </button>
      </form>

      {opps.length === 0 ? (
        <div className="border border-dashed border-zinc-300 dark:border-zinc-700 rounded p-8 text-center text-zinc-500">
          <p className="mb-2">No opportunities yet.</p>
          <p className="text-sm">
            Run <code className="font-mono bg-zinc-200 dark:bg-zinc-800 px-1 rounded">pnpm ingest:hn</code>,{" "}
            then <code className="font-mono bg-zinc-200 dark:bg-zinc-800 px-1 rounded">pnpm pipeline:all</code>.
          </p>
        </div>
      ) : (
        <div className="border border-zinc-200 dark:border-zinc-800 rounded bg-white dark:bg-zinc-900 divide-y divide-zinc-200 dark:divide-zinc-800">
          {opps.map((opp) => {
            const recomputed = computeScore({
              soloDevScore: opp.soloDevScore,
              demandScore: opp.demandScore,
              monetizationScore: opp.monetizationScore,
              competitionScore: opp.competitionScore,
            });
            return (
              <Link
                key={opp.id}
                href={`/opportunities/${opp.id}`}
                className="flex items-start gap-4 px-4 py-3 hover:bg-zinc-50 dark:hover:bg-zinc-800/50"
              >
                <div className="font-mono text-lg font-semibold w-12 text-right tabular-nums">
                  {recomputed.toFixed(1)}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="font-medium truncate">{opp.title}</div>
                  <div className="text-sm text-zinc-500 truncate">{opp.oneLiner}</div>
                  <div className="mt-1 flex flex-wrap gap-1 text-xs">
                    {opp.niche && (
                      <span className="font-mono bg-zinc-100 dark:bg-zinc-800 px-1.5 py-0.5 rounded">
                        {opp.niche}
                      </span>
                    )}
                    <span className="text-zinc-500">
                      D{opp.demandScore.toFixed(0)} · M{opp.monetizationScore.toFixed(0)} · S{opp.soloDevScore.toFixed(0)} · C{opp.competitionScore.toFixed(0)}
                    </span>
                    {opp.estMrrCeiling ? (
                      <span className="text-zinc-500">~${opp.estMrrCeiling.toLocaleString()}/mo ceiling</span>
                    ) : null}
                    <span className="text-zinc-500">
                      {opp._count.evidence} signal{opp._count.evidence === 1 ? "" : "s"}
                    </span>
                    {!opp.researchedAt && (
                      <span className="text-amber-600 dark:text-amber-400">unresearched</span>
                    )}
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
