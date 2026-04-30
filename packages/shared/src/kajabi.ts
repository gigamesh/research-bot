import { z } from "zod";

/**
 * Kajabi community item shapes captured by the Chrome extension.
 *
 * The extension scrolls the authenticated feed and opens each post's modal
 * to harvest the full conversation tree, then POSTs batches to the local
 * web app at /api/ingest/kajabi. These zod schemas are the contract between
 * the extension and the web app — keep them in sync on both sides.
 *
 * One `KajabiPostItem` corresponds to one top-level post and all of its
 * comments + replies (flattened with `parentUuid` refs). On the server,
 * each item upserts to a single `RawPost` row keyed on `(source, postUuid)`.
 */

const KajabiAuthorSchema = z.object({
  /// UUID from the profile URL `/products/communities/v2/<community>/profile/<uuid>`.
  uuid: z.string().min(1),
  profileUrl: z.string().url(),
  name: z.string(),
  avatarUrl: z.string().url().optional(),
});
export type KajabiAuthor = z.infer<typeof KajabiAuthorSchema>;

const KajabiReactionSchema = z.object({
  /// "thumbs-up" | "heart" | etc — the visible reaction kind. Kajabi exposes
  /// a small fixed set; we capture whatever string the DOM exposes.
  kind: z.string().min(1),
  count: z.number().int().nonnegative(),
});
export type KajabiReaction = z.infer<typeof KajabiReactionSchema>;

export const KajabiCommentSchema = z.object({
  /// UUID from the comment container's `id` attribute.
  uuid: z.string().min(1),
  /// UUID of the parent comment, or null when the comment is a direct reply
  /// to the post (top-level inside the thread).
  parentUuid: z.string().min(1).nullable(),
  author: KajabiAuthorSchema,
  /// Plain text of the visible KcRichTextViewer copy (NOT the hidden one at
  /// top-[-9999px], which is for measurement).
  bodyText: z.string(),
  /// Raw inner HTML for re-rendering links/mentions later. Optional.
  bodyHtml: z.string().optional(),
  /// ISO timestamp resolved against `KajabiPostItem.scrapedAt`. NULL when the
  /// relative-time string couldn't be parsed.
  postedAt: z.string().datetime().nullable(),
  reactions: z.array(KajabiReactionSchema).default([]),
  /// Profile UUIDs referenced via `<a class="mention">` inside the body.
  mentions: z.array(z.string()).default([]),
  /// URLs of any images / video frames attached. Empty for text-only comments.
  attachments: z.array(z.string().url()).default([]),
});
export type KajabiComment = z.infer<typeof KajabiCommentSchema>;

export const KajabiPostItemSchema = z.object({
  /// UUID from the timestamp button's destination URL (or any other stable
  /// per-card UUID exposed in the DOM).
  uuid: z.string().min(1),
  /// Canonical post URL on shannonjean.info. Used as `RawPost.url`.
  url: z.string().url(),
  /// The community "circle" this post was published to. NULL when the post
  /// has no badge (rare). `slug` is the path segment after `/circle/`,
  /// `name` is the visible label.
  channel: z
    .object({
      slug: z.string(),
      name: z.string(),
    })
    .nullable(),
  author: KajabiAuthorSchema,
  bodyText: z.string(),
  bodyHtml: z.string().optional(),
  /// ISO. Derived from the relative-time string (e.g. "2h", "1d") against
  /// `scrapedAt`. NULL when the relative-time string couldn't be parsed.
  postedAt: z.string().datetime().nullable(),
  reactions: z.array(KajabiReactionSchema).default([]),
  /// "N comments" footer. May not equal `comments.length` if Kajabi truncates
  /// or if the modal scroll-loop didn't fully drain — used as a re-scrape
  /// signal: if the next visit reports a higher commentCount, we null
  /// `processedAt` and re-extract signals.
  commentCount: z.number().int().nonnegative(),
  /// Flat depth-first order. Reconstruct the tree via `parentUuid`.
  comments: z.array(KajabiCommentSchema).default([]),
  mentions: z.array(z.string()).default([]),
  attachments: z.array(z.string().url()).default([]),
  /// ISO at top-of-scrape. Used by the parser to resolve relative timestamps
  /// like "2h" / "1d" into absolute `postedAt` values.
  scrapedAt: z.string().datetime(),
  /// Raw outerHTML of the inline post card (`PostCardContainer`).
  /// Optional — captured for forensic analysis so we can verify the
  /// parser's extraction against the actual DOM. Will balloon row size,
  /// so only enable in debug builds or when explicitly debugging.
  cardHtml: z.string().optional(),
  /// Raw outerHTML of the modal AFTER scrolling, expanding replies, and
  /// clicking show-more. Only present for posts processed via the modal
  /// flow (commentCount > 0 and the modal opened).
  modalHtml: z.string().optional(),
});
export type KajabiPostItem = z.infer<typeof KajabiPostItemSchema>;

/// Wire format the SW POSTs to /api/ingest/kajabi. Either a flat list of
/// fully-scraped posts (modal-driven) or feed-only previews (no comments).
export const KajabiIngestPayloadSchema = z.object({
  items: z.array(KajabiPostItemSchema).min(1).max(100),
  /// Extension-side capture timestamp; useful for debugging clock skew.
  capturedAt: z.string().datetime().optional(),
});
export type KajabiIngestPayload = z.infer<typeof KajabiIngestPayloadSchema>;

export const KajabiIngestResponseSchema = z.object({
  created: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
});
export type KajabiIngestResponse = z.infer<typeof KajabiIngestResponseSchema>;

/// Walk the flat `comments` array depth-first by following `parentUuid`,
/// joining each comment as `[author] body` with blank-line separators.
/// Used server-side to build `RawPost.body` so the signals stage sees the
/// post + full conversation in one shot.
export function flattenCommentsForBody(item: KajabiPostItem): string {
  const childrenByParent = new Map<string | null, KajabiComment[]>();
  for (const c of item.comments) {
    const arr = childrenByParent.get(c.parentUuid);
    if (arr) arr.push(c);
    else childrenByParent.set(c.parentUuid, [c]);
  }
  const lines: string[] = [];
  const walk = (parentUuid: string | null, depth: number) => {
    const children = childrenByParent.get(parentUuid) ?? [];
    for (const c of children) {
      const indent = "  ".repeat(depth);
      lines.push(`${indent}[${c.author.name}] ${c.bodyText.trim()}`);
      walk(c.uuid, depth + 1);
    }
  };
  walk(null, 0);
  return lines.join("\n\n");
}

/// Stable hash of the comment thread for change-detection. Used by the
/// ingest endpoint to decide whether to null `processedAt` on re-scrape.
export function commentThreadFingerprint(item: KajabiPostItem): string {
  const ids = item.comments.map((c) => c.uuid).sort();
  return `${item.commentCount}:${ids.length}:${ids.join(",")}`;
}
