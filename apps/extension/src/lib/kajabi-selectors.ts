/// Single source of truth for Kajabi DOM selectors. The target site is the
/// `xmm` reseller community at https://www.shannonjean.info — a Kajabi-hosted
/// React app whose component tree exposes stable telemetry attributes
/// (`data-sentry-component`, `data-sentry-source-file`). We anchor on those
/// instead of class names since Kajabi's Tailwind classes change between
/// builds.
///
/// Selectors verified against user-shared HTML on 2026-04-28. When scraping
/// breaks, this is the file to update.

export type KajabiSelectorMap = {
  /// Stable container the parser can wait for before scraping (proves the
  /// React tree has hydrated).
  pageReady: string;

  /// One element per top-level post in the feed (or one per visible card on
  /// any page).
  postCard: string;

  /// Per-post selectors run within each `postCard` element.
  post: {
    /// `<a href="/products/communities/v2/xmm/profile/<uuid>">` for the post
    /// author. Used to extract author UUID + profile URL + display name.
    /// Two profile anchors exist per post header (avatar link first, then a
    /// name-bearing link inside PostCardHeaderCol). We must hit the second
    /// one so the display-name span is reachable.
    authorLink: string;
    /// Channel/circle badge anchor — `<a href=".../circle/<slug>">`. Optional.
    channelLink: string;
    /// Visible body container. There are TWO copies of the rich-text inside
    /// each `KcRichTextViewer` — one hidden at top-[-9999px] for layout
    /// measurement, one visible. We pick the visible *container* (NOT the
    /// first TextViewer inside it) so the parser can walk every child
    /// paragraph / list / blockquote — Kajabi renders each paragraph as
    /// its own TextViewer element.
    bodyVisible: string;
    /// All image / video URLs in the carousel (post attachments).
    carouselImg: string;
    /// Button on the timestamp ("2h", "26m", "1d") that opens the modal.
    /// Carries `aria-label="View post details"`.
    timestampBtn: string;
    /// Visible relative-time text (the label of `timestampBtn`).
    timestampLabel: string;
    /// Footer reaction badges. Each badge contains a `count` <p> sibling.
    reactionBadge: string;
    /// "1 comment" / "2 comments" footer text. May be absent (zero comments).
    commentCount: string;
  };

  /// Comment-thread selectors — work both inline (in the feed card) and
  /// inside the modal dialog.
  thread: {
    /// Container around the inline comment thread on a post card. Comments
    /// inside are NOT necessarily complete; use the modal flow to expand.
    inlineContainer: string;
    /// Each rendered comment node. The container `div` carries `id="<uuid>"`.
    comment: string;
    /// Visible body text inside a comment.
    commentBodyVisible: string;
    /// `<a href="/profile/<uuid>">` for the comment author.
    commentAuthorLink: string;
    /// Comment header — usually contains the author's display name.
    commentAuthorName: string;
    /// Visible relative-time on a comment.
    commentTimeLabel: string;
    /// Comment-level reactions (sum across all kinds).
    commentReaction: string;
  };

  /// Modal dialog selectors. Kajabi opens posts in a Radix `<div role=dialog>`
  /// when you click the timestamp button. The modal has its own scrollable
  /// container; expand-replies buttons and show-more buttons inside it
  /// behave like the inline ones.
  modal: {
    /// Open Radix dialog root. Multiple may exist (Kajabi nests dropdowns
    /// inside dialogs); we pick the LAST one with `data-state="open"`.
    root: string;
  };
};

const POST_AUTHOR_HREF_PREFIX = "/products/communities/v2/xmm/profile/";

export const KAJABI_SELECTORS: KajabiSelectorMap = {
  pageReady: "[data-sentry-component='PaginatedList']",
  postCard: "[data-sentry-component='PostCardContainer']",
  post: {
    // Anchor on PostCardHeaderCol (the name column), not PostCardHeaderRow
    // (which contains the avatar-only anchor first). The name-bearing
    // anchor wraps a `<span class="line-clamp-1">` with the display name.
    authorLink:
      "[data-sentry-component='PostCardHeaderCol'] a[href^='" +
      POST_AUTHOR_HREF_PREFIX +
      "']",
    channelLink: "a[href*='/circle/']",
    // The KcRichTextViewer holding the post body. Scoped under
    // PostCardContentContainer so it can't accidentally match the
    // ChannelPostMessage of a *comment* (which lives in its own
    // ChannelPostCommentContent ancestor). The viewer renders in two
    // possible layouts:
    //   1. paragraphs directly inside (short bodies, no truncation)
    //   2. an invisible measurement copy + a visible `.relative` wrapper
    //      (when "Show more" truncation might apply)
    // `extractRichText` handles both. Anchoring at the viewer (not its
    // inner wrapper) is critical — variant 1 has no inner wrapper and
    // would never match a `>div.relative` selector.
    bodyVisible:
      "[data-sentry-component='PostCardContentContainer'] [data-sentry-component='KcRichTextViewer']",
    carouselImg: "[data-sentry-component='ChannelPostCarousel'] img[src]",
    timestampBtn: "button[aria-label='View post details']",
    timestampLabel: "button[aria-label='View post details']",
    reactionBadge: "[data-testid='message-reaction-count']",
    commentCount:
      "[data-sentry-component='PostCardContentFooter'] p.text-xs.font-medium.text-foreground",
  },
  thread: {
    inlineContainer:
      "[data-sentry-component='ChannelPostCommentThreadContainer']",
    comment: "[data-sentry-component='ChannelPostCommentContent']",
    // Same two-layout reality as post bodies. Scope to
    // ChannelPostCommentContent so it never accidentally matches a
    // post's own ChannelPostMessage when both happen to live under the
    // same ancestor.
    commentBodyVisible:
      "[data-sentry-component='ChannelPostCommentContent'] [data-sentry-component='KcRichTextViewer']",
    commentAuthorLink: "a[href*='/profile/']",
    commentAuthorName: "a[href*='/profile/'] span.line-clamp-1",
    commentTimeLabel:
      "[data-sentry-component='ChannelPostCommentFooter'] p.text-xs",
    commentReaction: "[data-testid='message-reaction-count']",
  },
  modal: {
    root: "[role='dialog'][data-state='open']",
  },
};

/// Path-prefix → page kind. Returns `"feed"` for the community home / feed
/// page; `null` for anything else (login, profile, settings).
export function detectKajabiPageKind(pathname: string): "feed" | null {
  // The feed is at /products/communities/v2/<community>/home. Allow any
  // community slug for forward-compat (the community is currently `xmm`).
  if (/^\/products\/communities\/v2\/[^/]+\/home\/?$/.test(pathname)) {
    return "feed";
  }
  return null;
}

/// Pull a UUID out of a profile or comment-id string.
export function extractUuid(value: string | null | undefined): string | null {
  if (!value) return null;
  const m = value.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  return m ? m[0].toLowerCase() : null;
}
