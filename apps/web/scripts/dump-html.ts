/// Dump raw card / modal HTML out of RawPost.rawJson into per-post
/// files, for forensic analysis when the parser's output looks wrong.
///
/// Usage:
///   pnpm scrape:dump-html               # writes to ./tmp/scraped-html/
///   pnpm scrape:dump-html <out-dir>     # writes to a custom directory
///   pnpm scrape:dump-html --uuid <id>   # dump just one post
///
/// Each post produces up to three files:
///   <uuid>.card.html  — outerHTML of the inline PostCardContainer
///   <uuid>.modal.html — outerHTML of the modal AFTER expansions
///   <uuid>.json       — the parsed item (without the html blobs)

import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { prisma } from "@/lib/db";

const KAJABI_SOURCE = "kajabi-shannonjean";

type StoredItem = {
  uuid?: string;
  cardHtml?: string;
  modalHtml?: string;
  [k: string]: unknown;
};

function takeOption(args: string[], name: string): string | null {
  const i = args.indexOf(name);
  if (i < 0) return null;
  const v = args[i + 1] ?? null;
  args.splice(i, 2);
  return v;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const onlyUuid = takeOption(args, "--uuid");
  const outDir = resolve(args[0] ?? "tmp/scraped-html");

  mkdirSync(outDir, { recursive: true });

  const source = await prisma.source.findUnique({
    where: { name: KAJABI_SOURCE },
    select: { id: true },
  });
  if (!source) {
    console.error(`no Source row named "${KAJABI_SOURCE}" — run pnpm scrape first`);
    process.exit(2);
  }

  const rows = await prisma.rawPost.findMany({
    where: {
      sourceId: source.id,
      ...(onlyUuid ? { externalId: onlyUuid } : {}),
    },
    select: {
      id: true,
      externalId: true,
      author: true,
      title: true,
      rawJson: true,
      fetchedAt: true,
    },
    orderBy: { fetchedAt: "asc" },
  });

  if (rows.length === 0) {
    console.error("no matching rows");
    process.exit(2);
  }

  let cards = 0;
  let modals = 0;
  let jsonOnly = 0;

  for (const r of rows) {
    if (!r.rawJson) {
      jsonOnly += 1;
      continue;
    }
    let parsed: StoredItem | null = null;
    try {
      parsed = JSON.parse(r.rawJson) as StoredItem;
    } catch {
      console.warn(`  ! ${r.externalId}: rawJson parse failed; skipping`);
      continue;
    }
    if (!parsed) continue;

    const stem = r.externalId;

    if (typeof parsed.cardHtml === "string" && parsed.cardHtml.length > 0) {
      writeFileSync(`${outDir}/${stem}.card.html`, parsed.cardHtml);
      cards += 1;
    }
    if (typeof parsed.modalHtml === "string" && parsed.modalHtml.length > 0) {
      writeFileSync(`${outDir}/${stem}.modal.html`, parsed.modalHtml);
      modals += 1;
    }

    // Strip the html blobs out before writing the parsed json so the
    // .json file stays small enough to skim.
    const slim = { ...parsed };
    delete slim.cardHtml;
    delete slim.modalHtml;
    writeFileSync(
      `${outDir}/${stem}.json`,
      JSON.stringify(
        {
          dbId: r.id,
          externalId: r.externalId,
          author: r.author,
          title: r.title,
          fetchedAt: r.fetchedAt.toISOString(),
          parsed: slim,
        },
        null,
        2,
      ),
    );
    jsonOnly += 1;
  }

  console.log(`wrote: ${cards} card, ${modals} modal, ${jsonOnly} json files → ${outDir}`);
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
