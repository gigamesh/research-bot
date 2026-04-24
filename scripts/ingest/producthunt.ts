/// ProductHunt ingest. Uses the v2 GraphQL API.
/// Get a token at https://www.producthunt.com/v2/oauth/applications and set:
///   PRODUCTHUNT_TOKEN=...
///
/// Strategy: pull recent launches + their top comments; filter comments with
/// the pain-regex. Launches themselves are stored too (tagline often reveals
/// what niches are being served, useful as "what already exists" signal).
///
/// Run: `pnpm ingest:ph [--limit 30]`

import "dotenv/config";
import { GraphQLClient, gql } from "graphql-request";
import { prisma } from "@/lib/db";
import { ensureSource, looksLikePain } from "../lib/source";

const RECENT_QUERY = gql`
  query RecentPosts($first: Int!) {
    posts(first: $first, order: NEWEST) {
      edges {
        node {
          id
          slug
          name
          tagline
          description
          url
          createdAt
          user {
            username
          }
          comments(first: 10) {
            edges {
              node {
                id
                body
                createdAt
                user {
                  username
                }
              }
            }
          }
        }
      }
    }
  }
`;

type Post = {
  id: string;
  slug: string;
  name: string;
  tagline: string;
  description: string | null;
  url: string;
  createdAt: string;
  user: { username: string } | null;
  comments: {
    edges: {
      node: {
        id: string;
        body: string;
        createdAt: string;
        user: { username: string } | null;
      };
    }[];
  };
};

type RecentResponse = {
  posts: { edges: { node: Post }[] };
};

async function run() {
  const token = process.env.PRODUCTHUNT_TOKEN;
  if (!token) {
    throw new Error("Missing PRODUCTHUNT_TOKEN in .env");
  }
  const limitArg = process.argv.indexOf("--limit");
  const limit = limitArg >= 0 ? Number(process.argv[limitArg + 1] ?? 30) : 30;

  const client = new GraphQLClient("https://api.producthunt.com/v2/api/graphql", {
    headers: { Authorization: `Bearer ${token}` },
  });

  const sourceId = await ensureSource("producthunt");
  const data = await client.request<RecentResponse>(RECENT_QUERY, { first: limit });

  let kept = 0;
  let scanned = 0;
  for (const edge of data.posts.edges) {
    const post = edge.node;
    scanned++;

    // Keep the launch itself — taglines document solved (or under-solved) problems.
    const launchBody = [post.tagline, post.description].filter(Boolean).join("\n\n");
    await prisma.rawPost.upsert({
      where: {
        sourceId_externalId: { sourceId, externalId: post.id },
      },
      create: {
        sourceId,
        externalId: post.id,
        url: `https://www.producthunt.com/posts/${post.slug}`,
        author: post.user?.username ?? null,
        postedAt: new Date(post.createdAt),
        title: post.name,
        body: launchBody,
        rawJson: JSON.stringify(post),
      },
      update: {},
    });
    kept++;

    // Pull pain-laden comments.
    for (const c of post.comments.edges) {
      const node = c.node;
      scanned++;
      if (!looksLikePain(node.body)) continue;
      await prisma.rawPost.upsert({
        where: {
          sourceId_externalId: { sourceId, externalId: `c:${node.id}` },
        },
        create: {
          sourceId,
          externalId: `c:${node.id}`,
          url: `https://www.producthunt.com/posts/${post.slug}#comment-${node.id}`,
          author: node.user?.username ?? null,
          postedAt: new Date(node.createdAt),
          title: `Comment on ${post.name}`,
          body: node.body,
          rawJson: JSON.stringify(node),
        },
        update: {},
      });
      kept++;
    }
  }

  console.log(`[producthunt] scanned=${scanned} kept=${kept}`);
  await prisma.$disconnect();
}

run().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
