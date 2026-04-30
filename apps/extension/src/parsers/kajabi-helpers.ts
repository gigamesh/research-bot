/// Kajabi-specific parsing utilities.

const KAJABI_ORIGIN = "https://www.shannonjean.info";

export function text(el: Element | null | undefined): string {
  return el?.textContent?.replace(/\s+/g, " ").trim() ?? "";
}

/// Extract the visible body text from a Kajabi KcRichTextViewer.
///
/// Kajabi renders rich-text content in two different layouts:
///
///   Variant A (truncatable content): an invisible measurement copy at
///     `top:-9999px` plus a visible `.relative` wrapper holding the same
///     paragraphs. Used when the body is long enough that "Show more"
///     might apply.
///
///   Variant B (short content): paragraphs/lists are direct children of
///     the KcRichTextViewer with no measurement copy.
///
/// We pass the KcRichTextViewer itself in. If a `.relative:not(.invisible)`
/// child exists, we walk that (variant A). Otherwise we walk the viewer's
/// direct children (variant B), explicitly skipping any `.invisible`
/// measurement copy that might still be a sibling.
///
/// Why walk children at all? Because `textContent` would collapse every
/// whitespace span — including paragraph breaks — into a single space,
/// gluing the entire post into one wall of text. Children-walk preserves
/// paragraph structure as `\n\n` separators. Empty children (spacers like
/// `<div class="h-4">`, gradient overlays) drop out naturally.
export function extractRichText(container: Element | null | undefined): string {
  if (!container) return "";
  const visibleCopy = container.querySelector<HTMLElement>(
    ":scope > div.relative:not(.invisible)",
  );
  const target: Element = visibleCopy ?? container;

  if (target.children.length === 0) {
    return text(target);
  }
  const parts: string[] = [];
  for (const child of Array.from(target.children)) {
    if (child instanceof HTMLElement) {
      // Skip the measurement copy if it shows up as a sibling at this level.
      if (child.classList.contains("invisible")) continue;
      // Use `innerText` (not `textContent`) so <br> tags become real
      // newlines instead of being silently dropped — Kajabi authors
      // routinely use Shift-Enter to separate lines within a paragraph,
      // and textContent would glue "garage.That's at half speed." with
      // no whitespace at all. innerText also respects CSS visibility,
      // so any visually-hidden span doesn't leak into the body.
      const raw = child.innerText ?? child.textContent ?? "";
      // Collapse runs of whitespace inside a line, preserve newlines.
      const t = raw
        .split("\n")
        .map((line) => line.replace(/\s+/g, " ").trim())
        .filter((line) => line.length > 0)
        .join("\n");
      if (t) parts.push(t);
    } else {
      const t = (child.textContent ?? "").replace(/\s+/g, " ").trim();
      if (t) parts.push(t);
    }
  }
  return parts.join("\n\n");
}

export function absoluteUrl(href: string | null | undefined): string | null {
  if (!href) return null;
  try {
    return new URL(href, KAJABI_ORIGIN).toString();
  } catch {
    return null;
  }
}

/// Resolve Kajabi's compact relative-time labels ("26m", "2h", "4h", "1d",
/// "3w", "2mo") against a reference time. Returns ISO string or null when
/// the label can't be parsed.
///
/// Units accepted: s, m, h, d, w, mo, y. "now" → reference time. We
/// deliberately keep "mo" unambiguous (not just "m") because "1m" means
/// one minute on Kajabi.
export function parseKajabiRelativeTime(
  label: string,
  now: Date = new Date(),
): string | null {
  if (!label) return null;
  const compact = label.trim().toLowerCase();
  if (compact === "now" || compact === "just now") return now.toISOString();

  const match = compact.match(/^(\d+)\s*(s|m|h|d|w|mo|y)$/);
  if (!match) return null;
  const n = Number(match[1]);
  if (!Number.isFinite(n)) return null;
  const unit = match[2];
  const ms: Record<string, number> = {
    s: 1_000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
    w: 604_800_000,
    mo: 2_592_000_000,
    y: 31_536_000_000,
  };
  const factor = ms[unit];
  if (!factor) return null;
  return new Date(now.getTime() - n * factor).toISOString();
}

/// `<a href="/products/communities/v2/xmm/profile/<uuid>">` → `<uuid>`.
/// Used both for post authors and for comment authors / @mentions.
const PROFILE_HREF_RE = /\/profile\/([0-9a-f-]{36})/i;

export function extractProfileUuid(
  href: string | null | undefined,
): string | null {
  if (!href) return null;
  return href.match(PROFILE_HREF_RE)?.[1]?.toLowerCase() ?? null;
}

/// `<a href=".../circle/<slug>">` → `<slug>`. Slugs are UUIDs in practice
/// but Kajabi's URL contract is just "any path segment", so we don't
/// require UUID format here.
const CIRCLE_HREF_RE = /\/circle\/([^/?#]+)/i;

export function extractCircleSlug(
  href: string | null | undefined,
): string | null {
  if (!href) return null;
  return href.match(CIRCLE_HREF_RE)?.[1] ?? null;
}

/// Parse the visible "N comments" / "1 comment" footer label. Returns 0
/// when the label is missing.
export function parseCommentCount(label: string | null | undefined): number {
  if (!label) return 0;
  const m = label.match(/(\d+)/);
  return m ? Number(m[1]) : 0;
}

/// Extract the count from a single reaction badge. The badge contains a
/// `<p>N</p>` sibling next to the icon.
export function reactionBadgeCount(badge: Element | null | undefined): number {
  if (!badge) return 0;
  const counts = Array.from(badge.querySelectorAll("p"));
  for (const p of counts) {
    const n = Number(p.textContent?.trim() ?? "");
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}

/// Find an element from a list by visible text match. Used to drive
/// "Show more" / "View N replies" / "View all comments" buttons whose only
/// stable handle is their label text.
export function findByText(
  root: Element | Document,
  selector: string,
  re: RegExp,
): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (const el of Array.from(root.querySelectorAll(selector))) {
    const t = (el.textContent ?? "").trim();
    if (re.test(t) && el instanceof HTMLElement) out.push(el);
  }
  return out;
}

export function jitter(min: number, max: number): number {
  if (max <= min) return Math.max(0, min);
  return min + Math.floor(Math.random() * (max - min));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/// Resolve once a stable container is present. Returns true if found, false
/// on timeout. setTimeout-based (NOT requestAnimationFrame) so background
/// tabs aren't paused — RAF is heavily throttled or stopped entirely when
/// the tab is hidden.
export function waitForContainer(
  selector: string,
  timeoutMs = 8000,
  root: Document | Element = document,
): Promise<boolean> {
  if (root.querySelector(selector)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      if (root.querySelector(selector)) return resolve(true);
      if (Date.now() - start > timeoutMs) return resolve(false);
      setTimeout(tick, 30);
    };
    tick();
  });
}

/// Wait for the React tree to settle. setTimeout-based instead of two
/// RAFs so background tabs (where RAF is paused) still progress. 16ms
/// is one frame at 60Hz — enough for React reconciliation on the small
/// DOM updates we trigger (modal toggles, reply expansions).
export function waitForReactSettle(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 16);
  });
}
