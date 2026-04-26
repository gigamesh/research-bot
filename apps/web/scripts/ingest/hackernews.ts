/// HackerNews ingest. Uses the public Firebase API — no auth needed.
/// Strategy: pull the current front page of "ask" + "show" stories, then for
/// each story fetch its text. We also scan recent comments on those stories
/// for pain-point language.
///
/// Run: `pnpm ingest:hn [--limit 50]`

import "dotenv/config";
import { prisma } from "@/lib/db";
import { ensureSource, looksLikePain } from "../lib/source";

const HN_API = "https://hacker-news.firebaseio.com/v0";

type HnItem = {
  id: number;
  by?: string;
  time?: number;
  text?: string;
  title?: string;
  url?: string;
  kids?: number[];
  type?: "story" | "comment" | "job" | "poll";
  dead?: boolean;
  deleted?: boolean;
};

async function getItem(id: number): Promise<HnItem | null> {
  const res = await fetch(`${HN_API}/item/${id}.json`);
  if (!res.ok) return null;
  return (await res.json()) as HnItem | null;
}

async function getList(name: "askstories" | "showstories"): Promise<number[]> {
  const res = await fetch(`${HN_API}/${name}.json`);
  if (!res.ok) return [];
  return (await res.json()) as number[];
}

function stripHtml(s: string): string {
  return s
    .replace(/<p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

async function upsertItem(sourceId: string, item: HnItem): Promise<boolean> {
  if (item.dead || item.deleted) return false;
  const body = item.text ? stripHtml(item.text) : "";
  const combined = `${item.title ?? ""}\n${body}`.trim();
  if (!combined || !looksLikePain(combined)) return false;

  await prisma.rawPost.upsert({
    where: {
      sourceId_externalId: { sourceId, externalId: String(item.id) },
    },
    create: {
      sourceId,
      externalId: String(item.id),
      url: `https://news.ycombinator.com/item?id=${item.id}`,
      author: item.by,
      postedAt: item.time ? new Date(item.time * 1000) : null,
      title: item.title ?? null,
      body: body || (item.title ?? ""),
      rawJson: JSON.stringify(item),
    },
    update: {},
  });
  return true;
}

async function run() {
  const limitArg = process.argv.indexOf("--limit");
  const limit = limitArg >= 0 ? Number(process.argv[limitArg + 1] ?? 30) : 30;

  const sourceId = await ensureSource("hn");
  const [askIds, showIds] = await Promise.all([getList("askstories"), getList("showstories")]);
  const storyIds = [...askIds, ...showIds].slice(0, limit);

  let kept = 0;
  let scanned = 0;
  for (const id of storyIds) {
    const story = await getItem(id);
    if (!story) continue;
    scanned++;
    if (await upsertItem(sourceId, story)) kept++;

    // Skim top-level comments for pain language too.
    const commentIds = (story.kids ?? []).slice(0, 5);
    for (const cid of commentIds) {
      const comment = await getItem(cid);
      if (!comment) continue;
      scanned++;
      if (await upsertItem(sourceId, comment)) kept++;
    }
  }

  console.log(`[hn] scanned=${scanned} kept=${kept}`);
  await prisma.$disconnect();
}

run().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
