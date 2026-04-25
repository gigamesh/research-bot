/// Reddit ingest using public JSON endpoints — no OAuth app required.
/// Reddit allows unauthenticated access to any public listing at
/// `https://www.reddit.com/r/<sub>/new.json`; rate limit is ~10 req/min, which
/// is plenty when we sleep between subreddit calls.
///
/// Only env var used (and only for politeness — Reddit doesn't enforce it):
///   REDDIT_USER_AGENT=research-bot/0.1 by <your-reddit-username>
///
/// Run: `pnpm ingest:reddit [--subreddit SaaS] [--limit 100]`
/// Reddit caps unauthenticated requests at 100 posts; values above 100 are
/// clamped in fetchSub().

import { prisma } from "@/lib/db";
import "dotenv/config";
import { ensureSource, looksLikePain } from "../lib/source";

/// Narrow, high-density list. Each sub is picked for high proportion of
/// business owners / high-WTP professionals — depth > breadth.
///
/// Expanded lists (medspa, CPA, weddingplanning, etc.) tend to 403, be low
/// volume, or drift consumer. Start with this 18-sub core; add more only if
/// clustering later shows you need more density in a specific vertical.
const DEFAULT_SUBS = [
  // Founders / operators
  "sweatystartup", // service-business entrepreneurship, highest signal
  "smallbusiness",
  "Entrepreneur",
  "SaaS",

  // Skilled trades (classic vertical-SaaS targets)
  "HVAC",
  "electricians",
  "plumbing",
  "Landscaping",

  // Healthcare pros (high WTP, bad incumbent software)
  "dentistry",
  "physicaltherapy",
  "chiropractic",
  "optometry",

  // Real estate
  "realtors",
  "realestateinvesting",
  "propertymanagement",

  // E-commerce sellers
  "AmazonFBA",
  "shopify",
  "Etsy",
];

/// Respect Reddit's unauthenticated rate limit (~10 req/min). 6.5s between
/// calls keeps us safely under it and avoids 429s.
const SUB_DELAY_MS = 6500;
const REDDIT_POST_LIMIT = 100;

type RedditPost = {
  id: string;
  subreddit: string;
  author: string;
  created_utc: number;
  title: string;
  selftext: string;
  permalink: string;
  over_18?: boolean;
  stickied?: boolean;
};

type RedditListing = {
  data: {
    children: { kind: string; data: RedditPost }[];
    after: string | null;
  };
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchSub(sub: string, limit: number): Promise<RedditPost[]> {
  const ua = process.env.REDDIT_USER_AGENT ?? "research-bot/0.1";
  const url = `https://www.reddit.com/r/${sub}/new.json?limit=${Math.min(limit, 100)}`;
  const res = await fetch(url, { headers: { "User-Agent": ua } });
  if (!res.ok) {
    console.warn(`[reddit] r/${sub} failed: ${res.status}`);
    return [];
  }
  // Reddit sometimes serves an HTML error page to unauth traffic; guard the JSON parse.
  const ct = res.headers.get("content-type") ?? "";
  if (!ct.includes("application/json")) {
    console.warn(`[reddit] r/${sub} returned non-JSON (${ct})`);
    return [];
  }
  const listing = (await res.json()) as RedditListing;
  return listing.data.children.map((c) => c.data);
}

async function upsertPost(
  sourceId: string,
  post: RedditPost,
): Promise<boolean> {
  if (post.stickied || post.over_18) return false;
  const body = post.selftext ?? "";
  const combined = `${post.title}\n${body}`.trim();
  if (!looksLikePain(combined)) return false;

  await prisma.rawPost.upsert({
    where: {
      sourceId_externalId: { sourceId, externalId: post.id },
    },
    create: {
      sourceId,
      externalId: post.id,
      url: `https://www.reddit.com${post.permalink}`,
      author: post.author,
      postedAt: new Date(post.created_utc * 1000),
      title: post.title,
      body: body || post.title,
      rawJson: JSON.stringify(post),
    },
    update: {},
  });
  return true;
}

async function run() {
  const subArg = process.argv.indexOf("--subreddit");
  const limitArg = process.argv.indexOf("--limit");
  const subs =
    subArg >= 0 && process.argv[subArg + 1]
      ? [process.argv[subArg + 1]!]
      : DEFAULT_SUBS;
  const limit =
    limitArg >= 0
      ? Number(process.argv[limitArg + 1] ?? REDDIT_POST_LIMIT)
      : REDDIT_POST_LIMIT;

  const sourceId = await ensureSource("reddit", { subs: DEFAULT_SUBS });

  let kept = 0;
  let scanned = 0;
  for (let i = 0; i < subs.length; i++) {
    const sub = subs[i]!;
    const posts = await fetchSub(sub, limit);
    scanned += posts.length;
    for (const p of posts) {
      if (await upsertPost(sourceId, p)) kept++;
    }
    console.log(`[reddit]   r/${sub}: ${posts.length} fetched`);
    if (i < subs.length - 1) await sleep(SUB_DELAY_MS);
  }

  console.log(`[reddit] scanned=${scanned} kept=${kept} subs=${subs.length}`);
  await prisma.$disconnect();
}

run().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
