import { KAJABI_SELECTORS } from "@/lib/kajabi-selectors";
import {
  absoluteUrl,
  extractCircleSlug,
  extractProfileUuid,
  extractRichText,
  parseCommentCount,
  parseKajabiRelativeTime,
  reactionBadgeCount,
  text,
} from "./kajabi-helpers";
import type {
  KajabiAuthor,
  KajabiComment,
  KajabiPostItem,
  KajabiReaction,
} from "@research-bot/shared";

/// Reason a parse attempt produced no item — surfaced to the caller so the
/// content script can log a diagnostic instead of silently skipping. None
/// of these are necessarily bugs (some special card types legitimately
/// don't have an author link), but tallying them by reason tells us
/// whether we're losing real posts or filtering correctly.
export type ParseFailure =
  | "no-author-anchor"
  | "no-author-uuid"
  | "no-post-uuid";

export type ParseResult =
  | { ok: true; item: KajabiPostItem }
  | { ok: false; reason: ParseFailure };

/// Parse a single post card or modal-rendered post into a KajabiPostItem.
///
/// The same extractor works on:
///   - the inline feed card (root = the PostCardContainer element)
///   - the modal dialog (root = the open dialog's body element) — pass the
///     dialog root as `root`
export function parsePost(
  root: Element,
  scrapedAtIso: string,
): ParseResult {
  const sel = KAJABI_SELECTORS.post;
  const authorAnchor = root.querySelector<HTMLAnchorElement>(sel.authorLink);
  if (!authorAnchor) return { ok: false, reason: "no-author-anchor" };
  const authorUuid = extractProfileUuid(authorAnchor.getAttribute("href"));
  if (!authorUuid) return { ok: false, reason: "no-author-uuid" };

  const author: KajabiAuthor = {
    uuid: authorUuid,
    profileUrl:
      absoluteUrl(authorAnchor.getAttribute("href")) ??
      `https://www.shannonjean.info/products/communities/v2/xmm/profile/${authorUuid}`,
    name: text(authorAnchor.querySelector("span.line-clamp-1")) || text(authorAnchor) || "(unknown)",
    avatarUrl: avatarFromContainer(authorAnchor.parentElement),
  };

  // Post body — visible KcRichTextViewer container. Walk children so
  // multi-paragraph posts (the common case for long write-ups) keep
  // their paragraph breaks instead of collapsing to a single line.
  const bodyEl = root.querySelector(sel.bodyVisible);
  const bodyText = extractRichText(bodyEl);
  const bodyHtml = bodyEl instanceof HTMLElement ? bodyEl.innerHTML : undefined;

  // Channel badge (optional).
  let channel: KajabiPostItem["channel"] = null;
  const channelLink = root.querySelector<HTMLAnchorElement>(sel.channelLink);
  if (channelLink) {
    const slug = extractCircleSlug(channelLink.getAttribute("href"));
    const name = text(channelLink.querySelector("span.line-clamp-1")) || text(channelLink);
    if (slug) channel = { slug, name };
  }

  // Timestamp — Kajabi exposes the relative label as the button text.
  const timestampBtn = root.querySelector<HTMLButtonElement>(sel.timestampBtn);
  const timestampLabel = text(timestampBtn);
  const postedAt = parseKajabiRelativeTime(timestampLabel, new Date(scrapedAtIso));

  // Reactions — take the count off the badge at the post level (the footer
  // immediately under the body). Multiple icons mean multiple kinds; we
  // aggregate to a single sum because Kajabi's post-level badge stack is
  // already a sum across all icons.
  const reactions = collectReactions(root.querySelectorAll(sel.reactionBadge));

  // Comment count — read the "N comments" label in the footer, fall back to 0.
  const commentCountLabel = text(root.querySelector(sel.commentCount));
  const commentCount = parseCommentCount(commentCountLabel);

  // Attachments — image carousel URLs.
  const attachments = unique(
    Array.from(root.querySelectorAll<HTMLImageElement>(sel.carouselImg))
      .map((img) => absoluteUrl(img.getAttribute("src")))
      .filter((u): u is string => !!u),
  );

  // Mentions — `<a class="mention">` inside the body.
  const mentions = unique(
    bodyEl
      ? Array.from(bodyEl.querySelectorAll<HTMLAnchorElement>("a.mention, a:has(span.mention)"))
          .map((a) => extractProfileUuid(a.getAttribute("href")))
          .filter((u): u is string => !!u)
      : [],
  );

  // Comments — gathered from any comment threads visible inside `root`.
  const comments = parseCommentsWithinRoot(root, scrapedAtIso);

  // Canonical URL: the post UUID is exposed in the timestamp button's URL
  // when it links somewhere; otherwise we synthesize from author UUID +
  // best-effort. In practice Kajabi opens posts via in-app modal (no URL
  // change), so we synthesize from a stable per-card hash.
  const postUuid = inferPostUuid(root, comments);
  if (!postUuid) return { ok: false, reason: "no-post-uuid" };

  return {
    ok: true,
    item: {
      uuid: postUuid,
      url: `https://www.shannonjean.info/products/communities/v2/xmm/posts/${postUuid}`,
      channel,
      author,
      bodyText,
      bodyHtml,
      postedAt,
      reactions,
      commentCount,
      comments,
      mentions,
      attachments,
      scrapedAt: scrapedAtIso,
    },
  };
}

/// Walk every comment thread visible inside `root` and produce a flat list
/// of KajabiComment with parent UUIDs resolved.
function parseCommentsWithinRoot(root: Element, scrapedAtIso: string): KajabiComment[] {
  const sel = KAJABI_SELECTORS.thread;
  const containers = Array.from(root.querySelectorAll(sel.inlineContainer));
  const out: KajabiComment[] = [];
  const seen = new Set<string>();

  for (const container of containers) {
    // Each comment is wrapped in `<div id="<uuid>">`. Walk those and assign
    // parents by climbing back through ancestors to the nearest enclosing
    // div-with-id-uuid.
    const idDivs = container.querySelectorAll<HTMLElement>("div[id]");
    for (const div of Array.from(idDivs)) {
      const uuid = div.getAttribute("id");
      if (!uuid || !/^[0-9a-f-]{36}$/i.test(uuid)) continue;
      if (seen.has(uuid)) continue;
      // The id-bearing div must contain a comment content element to count.
      if (!div.querySelector(sel.comment)) continue;
      seen.add(uuid);

      const comment = parseComment(div, uuid, scrapedAtIso);
      if (!comment) continue;
      // Resolve parent: nearest enclosing id-div whose id is in `seen`.
      let parent: HTMLElement | null = div.parentElement;
      let parentUuid: string | null = null;
      while (parent && parent !== container) {
        const candidate = parent.getAttribute("id");
        if (
          candidate &&
          /^[0-9a-f-]{36}$/i.test(candidate) &&
          parent.querySelector(sel.comment)
        ) {
          parentUuid = candidate;
          break;
        }
        parent = parent.parentElement;
      }
      comment.parentUuid = parentUuid;
      out.push(comment);
    }
  }
  return out;
}

function parseComment(
  div: HTMLElement,
  uuid: string,
  scrapedAtIso: string,
): KajabiComment | null {
  const sel = KAJABI_SELECTORS.thread;
  const authorAnchor = div.querySelector<HTMLAnchorElement>(sel.commentAuthorLink);
  if (!authorAnchor) return null;
  const authorUuid = extractProfileUuid(authorAnchor.getAttribute("href"));
  if (!authorUuid) return null;

  const author: KajabiAuthor = {
    uuid: authorUuid,
    profileUrl:
      absoluteUrl(authorAnchor.getAttribute("href")) ??
      `https://www.shannonjean.info/products/communities/v2/xmm/profile/${authorUuid}`,
    name:
      text(div.querySelector(sel.commentAuthorName)) ||
      text(authorAnchor) ||
      "(unknown)",
    avatarUrl: avatarFromContainer(authorAnchor.parentElement),
  };

  // Comment body — same multi-paragraph handling as the post body.
  const bodyEl = div.querySelector(sel.commentBodyVisible);
  const bodyText = extractRichText(bodyEl);
  const bodyHtml = bodyEl instanceof HTMLElement ? bodyEl.innerHTML : undefined;

  const timeLabel = text(div.querySelector(sel.commentTimeLabel));
  const postedAt = parseKajabiRelativeTime(timeLabel, new Date(scrapedAtIso));

  const reactions = collectReactions(div.querySelectorAll(sel.commentReaction));
  const mentions = unique(
    bodyEl
      ? Array.from(bodyEl.querySelectorAll<HTMLAnchorElement>("a.mention, a:has(span.mention)"))
          .map((a) => extractProfileUuid(a.getAttribute("href")))
          .filter((u): u is string => !!u)
      : [],
  );

  const attachments = unique(
    Array.from(div.querySelectorAll<HTMLImageElement>("img[src]"))
      .map((img) => absoluteUrl(img.getAttribute("src")))
      .filter((u): u is string => !!u),
  );

  return {
    uuid,
    parentUuid: null, // assigned by caller after walking ancestors
    author,
    bodyText,
    bodyHtml,
    postedAt,
    reactions,
    mentions,
    attachments,
  };
}

/// Aggregate post/comment-level reactions. Kajabi shows a stacked icon set
/// followed by a single integer count; we capture that integer + any
/// per-icon kind we can read.
function collectReactions(badges: NodeListOf<Element>): KajabiReaction[] {
  if (badges.length === 0) return [];
  const out: KajabiReaction[] = [];
  let total = 0;
  for (const badge of Array.from(badges)) {
    const n = reactionBadgeCount(badge);
    total += n;
    // Kajabi labels the kind via `<rect fill="#0072EF">` (thumb-up) etc;
    // detection here is best-effort.
    const kind =
      badge.querySelector("[data-testid*='thumb']") ||
      badge.querySelector("[clip-path*='thumb-up']")
        ? "like"
        : "reaction";
    if (n > 0) out.push({ kind, count: n });
  }
  if (out.length === 0 && total > 0) out.push({ kind: "reaction", count: total });
  return out;
}

function avatarFromContainer(parent: Element | null): string | undefined {
  if (!parent) return undefined;
  const img = parent.querySelector<HTMLImageElement>("img[src]");
  return absoluteUrl(img?.getAttribute("src") ?? null) ?? undefined;
}

function unique<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}

/// Kajabi doesn't expose the post UUID directly on the card or in the
/// modal. We synthesize a stable id from `authorHref + body[:200]` —
/// chosen because:
///   - both fields are present in BOTH the inline card AND the modal,
///     so the inline scroll-loop probe and the parser produce the same
///     UUID for the same post
///   - body and author href don't change in normal use (Kajabi posts
///     are rarely edited)
///
/// `comments` is intentionally NOT part of the seed — using it would
/// shift the UUID whenever someone deletes the first top-level comment,
/// orphaning the row.
function inferPostUuid(root: Element, _comments: KajabiComment[]): string | null {
  const explicit = root.getAttribute("data-post-id");
  if (explicit && /^[0-9a-f-]{36}$/i.test(explicit)) return explicit.toLowerCase();

  const authorAnchor = root.querySelector<HTMLAnchorElement>(
    KAJABI_SELECTORS.post.authorLink,
  );
  const authorHref = authorAnchor?.getAttribute("href") ?? "";
  const bodyText = extractRichText(root.querySelector(KAJABI_SELECTORS.post.bodyVisible));
  if (!authorHref && !bodyText) return null;
  return synthesizeUuid(`${authorHref}::${bodyText.slice(0, 200)}`);
}

/// Deterministic UUID-shaped string from an arbitrary seed. We're not
/// pretending to be a real UUIDv5 — we just want a stable, opaque key for
/// Kajabi posts that lack a server-side id in the DOM.
function synthesizeUuid(seed: string): string {
  // FNV-1a 32-bit, applied four times with rotating salts → 128 bits.
  const fnv = (input: string): number => {
    let h = 0x811c9dc5;
    for (let i = 0; i < input.length; i += 1) {
      h ^= input.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  };
  const a = fnv(seed).toString(16).padStart(8, "0");
  const b = fnv(`${seed}#1`).toString(16).padStart(8, "0").slice(0, 4);
  const c = fnv(`${seed}#2`).toString(16).padStart(8, "0").slice(0, 4);
  const d = fnv(`${seed}#3`).toString(16).padStart(8, "0").slice(0, 4);
  const e = (
    fnv(`${seed}#4`).toString(16).padStart(8, "0") +
    fnv(`${seed}#5`).toString(16).padStart(8, "0")
  ).slice(0, 12);
  return `${a}-${b}-${c}-${d}-${e}`;
}
