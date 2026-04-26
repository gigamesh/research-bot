import { prisma } from "@/lib/db";

export const LEASE_MS = 120_000;

const ALLOWED_ORIGIN = "https://www.upwork.com";

export const CRAWL_CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
  Vary: "Origin",
};

export async function ensureCrawlConfig() {
  return prisma.crawlConfig.upsert({
    where: { id: "singleton" },
    create: { id: "singleton" },
    update: {},
  });
}

/// Atomically claim the next pending (or expired-lease) job. Returns null if
/// nothing is claimable. Single SQLite writer means the FIRST_FAIL race window
/// is tiny but we still wrap in a transaction so two SW polls land safely.
export async function claimNextJob() {
  return prisma.$transaction(async (tx) => {
    const candidate = await tx.crawlJob.findFirst({
      where: {
        OR: [
          { status: "pending" },
          { status: "running", leaseUntil: { lt: new Date() } },
        ],
      },
      orderBy: { enqueuedAt: "asc" },
    });
    if (!candidate) return null;

    return tx.crawlJob.update({
      where: { id: candidate.id },
      data: {
        status: "running",
        leaseUntil: new Date(Date.now() + LEASE_MS),
        startedAt: candidate.startedAt ?? new Date(),
        attempts: { increment: 1 },
      },
    });
  });
}

/// Build absolute Upwork detail-page URLs from captured externalIds, skipping
/// ids we already have a (rich) RawPost for AND ids that already have a
/// pending/running CrawlJob to avoid duplicate work.
export async function spawnDetailChildren(
  parentId: string,
  externalIds: string[],
): Promise<number> {
  if (externalIds.length === 0) return 0;
  const upworkSource = await prisma.source.findUnique({ where: { name: "upwork" } });
  const sourceId = upworkSource?.id;

  const existingPosts = sourceId
    ? new Set(
        (
          await prisma.rawPost.findMany({
            where: { sourceId, externalId: { in: externalIds } },
            select: { externalId: true, rawJson: true },
          })
        )
          .filter((p) => {
            // Only skip if we already have detail-page coverage. Cards are not enough.
            try {
              const parsed = p.rawJson ? (JSON.parse(p.rawJson) as { capturedFrom?: string }) : null;
              return parsed?.capturedFrom === "job-detail";
            } catch {
              return false;
            }
          })
          .map((p) => p.externalId),
      )
    : new Set<string>();

  const candidates = externalIds.filter((id) => !existingPosts.has(id));
  if (candidates.length === 0) return 0;

  const urls = candidates.map((id) => `https://www.upwork.com/jobs/${id}`);
  const existingJobs = await prisma.crawlJob.findMany({
    where: { url: { in: urls }, status: { in: ["pending", "running"] } },
    select: { url: true },
  });
  const dedup = new Set(existingJobs.map((j) => j.url));
  const fresh = urls.filter((u) => !dedup.has(u));
  if (fresh.length === 0) return 0;

  await prisma.crawlJob.createMany({
    data: fresh.map((u) => ({
      kind: "job-detail" as const,
      url: u,
      parentId,
      expandToDetail: false,
    })),
  });
  return fresh.length;
}
