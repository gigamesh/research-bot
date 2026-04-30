import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

export default async function QueuePage() {
  const [sources, rawPostCount, signalCount, embeddedCount, oppCounts] = await Promise.all([
    prisma.source.findMany({
      include: {
        _count: { select: { posts: true } },
        posts: { orderBy: { fetchedAt: "desc" }, take: 1, select: { fetchedAt: true } },
      },
      orderBy: { name: "asc" },
    }),
    prisma.rawPost.count(),
    prisma.signal.count(),
    prisma.signal.count({ where: { embedding: { not: null } } }),
    prisma.opportunity.groupBy({
      by: ["status"],
      _count: { _all: true },
    }),
  ]);

  const rawPostsWithSignals = await prisma.rawPost.count({
    where: { signals: { some: {} } },
  });
  const signalsLinked = await prisma.signal.count({
    where: { evidence: { some: {} } },
  });
  const oppsResearched = await prisma.opportunity.count({ where: { researchedAt: { not: null } } });

  return (
    <div className="max-w-4xl mx-auto px-6 py-8">
      <h1 className="text-2xl font-semibold mb-6">Pipeline status</h1>

      <section className="mb-8">
        <h2 className="text-sm uppercase tracking-wide text-zinc-500 mb-2">sources</h2>
        <div className="border border-zinc-200 dark:border-zinc-800 rounded bg-white dark:bg-zinc-900 divide-y divide-zinc-200 dark:divide-zinc-800">
          {sources.length === 0 ? (
            <div className="px-4 py-3 text-zinc-500">
              No sources yet — run <code className="font-mono bg-zinc-100 dark:bg-zinc-800 px-1 rounded">pnpm scrape feed</code>.
            </div>
          ) : (
            sources.map((s) => (
              <div key={s.id} className="px-4 py-3 flex items-center justify-between text-sm">
                <span className="font-mono">{s.name}</span>
                <span className="text-zinc-500">
                  {s._count.posts} post{s._count.posts === 1 ? "" : "s"}
                  {s.posts[0]?.fetchedAt
                    ? ` · last ${new Date(s.posts[0].fetchedAt).toLocaleString()}`
                    : ""}
                </span>
              </div>
            ))
          )}
        </div>
      </section>

      <section className="mb-8">
        <h2 className="text-sm uppercase tracking-wide text-zinc-500 mb-2">pipeline progress</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Stat label="raw posts" value={rawPostCount} sub={`${rawPostsWithSignals} with signals`} />
          <Stat label="signals" value={signalCount} sub={`${embeddedCount} embedded · ${signalsLinked} clustered`} />
          <Stat label="opportunities" value={oppCounts.reduce((s, c) => s + c._count._all, 0)} sub={`${oppsResearched} researched`} />
          <Stat
            label="by status"
            value={oppCounts.length}
            sub={oppCounts.map((c) => `${c._count._all} ${c.status}`).join(" · ") || "—"}
          />
        </div>
      </section>

      <section>
        <h2 className="text-sm uppercase tracking-wide text-zinc-500 mb-2">next commands</h2>
        <pre className="bg-zinc-900 text-zinc-100 rounded p-4 text-sm overflow-x-auto">
{`pnpm scrape feed                      # scroll the kajabi community + harvest threads
pnpm scrape status --watch            # follow the queue live

pnpm pipeline:signals --limit 20
pnpm pipeline:embed
pnpm pipeline:cluster
pnpm pipeline:research --limit 5

pnpm pipeline:all                     # signals -> embed -> cluster -> research`}
        </pre>
      </section>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: number; sub?: string }) {
  return (
    <div className="border border-zinc-200 dark:border-zinc-800 rounded bg-white dark:bg-zinc-900 p-3">
      <div className="text-xs uppercase tracking-wide text-zinc-500">{label}</div>
      <div className="font-mono text-2xl font-semibold tabular-nums">{value}</div>
      {sub ? <div className="text-xs text-zinc-500 mt-1">{sub}</div> : null}
    </div>
  );
}
