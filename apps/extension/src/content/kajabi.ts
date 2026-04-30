import {
  detectKajabiPageKind,
  KAJABI_SELECTORS,
} from "@/lib/kajabi-selectors";
import { parsePost, type ParseFailure } from "@/parsers/kajabi-post";
import {
  extractRichText,
  findByText,
  jitter,
  sleep,
  waitForContainer,
  waitForReactSettle,
} from "@/parsers/kajabi-helpers";
import type { KajabiPostItem, ScrapeFailReason } from "@research-bot/shared";

/// Kajabi reseller-community capture. Runs on every shannonjean.info page
/// load. Two flavors:
///   - Passive: user browses normally; nothing fires until the SW reports
///     `managed=true` (i.e. an active session is driving this tab).
///   - Crawler-driven: the SW navigates the managed tab to the feed URL,
///     this script scrolls + opens each post's modal, then emits
///     `kajabi:complete` so the SW can drain the queue and POST
///     /api/scrape/complete.

// Pacing — tuned around two observations:
//   1. Modal scroll, reply expansion, "Show more", and per-comment
//      handling can run very fast (<100ms gaps) without issue. These
//      are local DOM operations.
//   2. FEED PAGINATION is rate-limited by Kajabi's backend. Going faster
//      than ~1.5s between scrolls causes the GraphQL endpoint to stop
//      responding after 30-50 cards even though the sentinel keeps
//      hitting the IntersectionObserver target.
// So: feed pacing stays generous, modal/comment pacing stays aggressive.

const SCROLL_DELAY_MIN_MS = 1000;
const SCROLL_DELAY_MAX_MS = 2000;
/// On stall, give Kajabi extra time before counting it. Stalls are
/// often caused by transient pagination back-pressure rather than a
/// real end-of-feed; giving the backend a long beat to recover gets
/// past the wall most of the time.
const STALL_EXTRA_WAIT_MS = 5000;
const SCROLL_STALL_LIMIT = 8;

const MODAL_SCROLL_STALL_LIMIT = 4;
const MODAL_SCROLL_MAX_ITERATIONS = 80;
const MODAL_SCROLL_DELAY_MIN_MS = 100;
const MODAL_SCROLL_DELAY_MAX_MS = 250;
const REPLY_EXPAND_MAX_ITERATIONS = 50;
const REPLY_CLICK_DELAY_MIN_MS = 50;
const REPLY_CLICK_DELAY_MAX_MS = 120;
const SHOW_MORE_DELAY_MS = 40;
const POST_THROTTLE_MIN_MS = 50;
const POST_THROTTLE_MAX_MS = 150;
const MODAL_CLOSE_SETTLE_MS = 80;

const MODAL_OPEN_TIMEOUT_MS = 4000;

void main();

async function main(): Promise<void> {
  const kind = detectKajabiPageKind(window.location.pathname);
  if (!kind) return;

  const settings = await chrome.storage.sync.get({ enabled: true });
  if (!settings.enabled) return;

  console.log(
    `[research-bot] kajabi content script live on ${window.location.pathname}  build=${__BUILD_MARKER__}`,
  );

  const containerFound = await waitForContainer(KAJABI_SELECTORS.pageReady);
  await waitForReactSettle();

  const managedAtStart = await askIfManaged();
  console.log(`[research-bot] managed=${managedAtStart} pageReady=${containerFound}`);
  // Passive (non-managed): do nothing. We don't want a logged-in user's
  // casual browse to trigger a scrape that uses local-storage / network
  // bandwidth without a job being claimed.
  if (!managedAtStart) return;

  // Auth probe: the compose-comment UI references the current user's
  // profile via `<a href="/products/communities/v2/xmm/profile/<uuid>">`.
  // Its absence means the session expired and Kajabi rendered a public
  // shell. Bail with a login_redirect reason so the SW auto-pauses.
  const authMarker = document.querySelector(
    "a[href^='/products/communities/v2/xmm/profile/']",
  );
  if (!authMarker) {
    sendFail("login_redirect", "no profile anchor found — session likely expired");
    return;
  }

  if (!containerFound) {
    sendFail(
      "selector_drift",
      `pageReady selector ${KAJABI_SELECTORS.pageReady} never matched`,
    );
    return;
  }

  // Track how many times we've already been reloaded to recover from
  // stalls in this session. Bound it so we don't loop forever if Kajabi
  // is genuinely out of posts.
  const reloadAttempts = await getReloadAttempts();
  if (reloadAttempts > 0) {
    console.log(
      `[research-bot] resuming after stall reload (attempt ${reloadAttempts}) — seen-skip will catch us up`,
    );
  }

  // Chrome aggressively throttles setTimeout (clamped to 1s minimum) and
  // requestAnimationFrame (paused entirely) in background tabs. That
  // would stretch a 5s modal flow into a 60+ second slog. Tabs with
  // *audible* audio playing are exempt — start a silent inaudible loop
  // for the duration of the scrape.
  startKeepAlive();

  // Pull previously-seen UUIDs from the SW so we can early-stop on
  // incremental runs.
  const seenServerSide = new Set(await fetchSeenUuids());

  try {
    const result = await scrapeFeed(seenServerSide);
    console.log(
      `[research-bot] scrape complete: ${result.captured.length} new post(s) sent (reason="${result.exitReason}")`,
    );
    // If we exited because Kajabi stopped paginating (stall-limit), and
    // we haven't already retried too many times this session, ask the
    // SW to reload the tab. After reload, the script reruns from top,
    // seen-skip catches us up to where we left off, and we continue
    // past the wall.
    const MAX_RELOAD_ATTEMPTS = 5;
    const isStall = result.exitReason.startsWith("stall-limit");
    const madeProgress = result.captured.length > 0;
    if (isStall && reloadAttempts < MAX_RELOAD_ATTEMPTS && (madeProgress || reloadAttempts === 0)) {
      console.log(
        `[research-bot] hit stall-limit; requesting tab reload to flush Apollo cache (attempt ${reloadAttempts + 1}/${MAX_RELOAD_ATTEMPTS})`,
      );
      await setReloadAttempts(reloadAttempts + 1);
      requestTabReload();
      // Don't send `complete` — the SW will reload us and main() will
      // run again on the fresh page.
      return;
    }
    // Reset the counter so the next session starts fresh.
    await setReloadAttempts(0);
    sendComplete(result.captured.length);
  } catch (err) {
    sendFail("other", (err as Error).message ?? String(err));
  } finally {
    stopKeepAlive();
  }
}

/// Reload-attempt counter persisted in sessionStorage so it survives
/// the tab reload but resets when the tab/session is closed.
async function getReloadAttempts(): Promise<number> {
  try {
    const raw = window.sessionStorage.getItem("rb-reload-attempts");
    return raw ? Number(raw) || 0 : 0;
  } catch {
    return 0;
  }
}
async function setReloadAttempts(n: number): Promise<void> {
  try {
    window.sessionStorage.setItem("rb-reload-attempts", String(n));
  } catch {
    /* ignore */
  }
}

function requestTabReload(): void {
  chrome.runtime.sendMessage({ type: "scrape:reload-tab" }).catch(() => {});
}

let keepAliveCtx: AudioContext | null = null;
let keepAliveOsc: OscillatorNode | null = null;

/// Start a silent oscillator on a Web Audio context. Chrome treats tabs
/// with active audio output as "important" and skips the background-
/// throttling that cripples setTimeout/RAF in hidden tabs.
///
/// We use Web Audio (not <audio>) because <audio> requires a recent
/// user gesture to autoplay — content scripts running in response to a
/// SW navigation rarely qualify. AudioContext is more lenient and is
/// permitted from extension content scripts in current Chrome.
function startKeepAlive(): void {
  if (keepAliveCtx) return;
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    gain.gain.value = 0; // truly silent
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    keepAliveCtx = ctx;
    keepAliveOsc = osc;
    // If the context is suspended (browser policy), try to resume.
    if (ctx.state === "suspended") {
      void ctx.resume().then(
        () => console.log("[research-bot] keep-alive AudioContext resumed"),
        (err) => console.warn(`[research-bot] keep-alive resume rejected: ${(err as Error).message}`),
      );
    }
    console.log(
      `[research-bot] keep-alive AudioContext state=${ctx.state} (suppresses background-tab throttling when running)`,
    );
  } catch (e) {
    console.warn(
      `[research-bot] keep-alive AudioContext init failed (${(e as Error).message}); background tabs will be slow`,
    );
  }
}

function stopKeepAlive(): void {
  try {
    keepAliveOsc?.stop();
  } catch {
    /* already stopped */
  }
  if (keepAliveCtx) {
    void keepAliveCtx.close();
  }
  keepAliveOsc = null;
  keepAliveCtx = null;
  console.log("[research-bot] keep-alive AudioContext stopped");
}

/// Interleaved scrape: each iteration either processes one queued card
/// or scrolls the feed for more. Cards land in the DB as soon as they're
/// encountered, so a Ctrl-C preserves all work done so far. Memory is
/// bounded — we only keep references to processed elements via a WeakSet,
/// and unprocessed cards are walked off the live DOM each iteration.
async function scrapeFeed(
  seenServerSide: Set<string>,
): Promise<{ captured: string[]; exitReason: string }> {
  const captured: string[] = [];
  const sentThisSession = new Set<string>();
  const processed = new WeakSet<HTMLElement>();

  // One-time DOM survey: how many cards exist now, and via which
  // sentry-component variants. If posts are being missed because they
  // render under a non-PostCardContainer component, this is where we'd
  // see it.
  surveyDom();

  // We re-detect the scroll container on every scroll iteration —
  // Kajabi's modal open/close cycles can shuffle the DOM enough that
  // a once-resolved scroller becomes stale.

  let stalls = 0;
  let totalSeen = 0;
  let totalSent = 0;
  let diagnosedOnce = false;
  let exitReason = "(unset)";
  // Skip-reason histogram. Printed at exit so we can see whether posts
  // are being legitimately filtered or quietly lost.
  const skipTally: Record<string, number> = Object.create(null);
  const bumpSkip = (reason: string): void => {
    skipTally[reason] = (skipTally[reason] ?? 0) + 1;
  };

  // Loop until stall-limit fires (Kajabi stops paginating). The user can
  // always Ctrl-C to bail out cleanly; work-so-far is preserved. We
  // intentionally don't short-circuit on "many already-seen in a row" —
  // the user's existing DB has the most-recent N posts at the TOP of the
  // feed, so a normal incremental run is supposed to fast-forward past
  // hundreds of stored cards before reaching unscraped historical content.
  while (true) {
    // 1. Pick the topmost unprocessed card on the page right now. We do
    //    this every iteration so newly-mounted cards from Kajabi's
    //    pagination get picked up as soon as they appear.
    const all = Array.from(
      document.querySelectorAll<HTMLElement>(KAJABI_SELECTORS.postCard),
    );
    const card = all.find((c) => !processed.has(c));

    if (card) {
      processed.add(card);
      const probeUuid = inferUuidFromCard(card);
      const idx = all.indexOf(card) + 1;
      reportPhase(`processing card #${idx} (cards in DOM: ${all.length})`);

      if (probeUuid && seenServerSide.has(probeUuid)) {
        totalSeen += 1;
        bumpSkip("already-seen");
        // Fast-forward over already-stored posts, but DO NOT use a
        // consecutive-seen run as a termination signal — the user
        // routinely runs against a DB that already has the entire top
        // of the feed cached and wants to walk further back into
        // history. Only stall-limit (Kajabi stops paginating) or
        // Ctrl-C ends the run.
        if (totalSeen % 25 === 0) {
          console.log(
            `[research-bot] fast-forward: skipped ${totalSeen} already-stored posts so far (sent=${totalSent})`,
          );
        }
        continue;
      }

      // Quick DOM-shape survey before we spend modal time on this card.
      const shape = surveyCard(card);
      const outcome = await processCard(card);
      if (outcome.kind === "parse-failed") {
        bumpSkip(`parse-failed:${outcome.reason}`);
        console.warn(
          `[research-bot] card #${idx}: parse-failed reason=${outcome.reason} via=${outcome.via}  shape=${JSON.stringify(shape)}`,
        );
        continue;
      }
      const item = outcome.item;
      if (sentThisSession.has(item.uuid)) {
        bumpSkip("dup-uuid-this-session");
        console.log(
          `[research-bot] card #${idx}: dup uuid (${item.uuid.slice(0, 8)}) within this session — skip  shape=${JSON.stringify(shape)}`,
        );
        continue;
      }
      sentThisSession.add(item.uuid);
      totalSent += 1;

      console.log(
        `[research-bot] card #${idx} (${item.uuid.slice(0, 8)}): sending → via=${outcome.via}`,
      );
      logCapturedPost(item);

      chrome.runtime
        .sendMessage({ type: "kajabi:items", items: [item] })
        .catch(() => {});
      captured.push(item.uuid);

      await sleep(jitter(POST_THROTTLE_MIN_MS, POST_THROTTLE_MAX_MS));
      continue;
    }

    // 2. No unprocessed cards left in the DOM. Scroll for more.
    // Re-detect the scroller each iteration in case the DOM shifted.
    reportPhase(
      `scrolling for more posts (DOM: ${all.length} cards, sent=${totalSent}, seen=${totalSeen}, stalls=${stalls}/${SCROLL_STALL_LIMIT})`,
    );
    const scroller = findFeedScroller();
    const beforeCount = all.length;
    const beforeY = scroller?.scrollTop ?? 0;
    const lastCard = all[all.length - 1];
    scrollFeedDown(scroller, lastCard);
    // Verify the sentinel actually became visible. If yes, Kajabi's IO
    // *should* have fired — any continued failure is on Kajabi's side.
    // If no, our scroll didn't take effect and we need to try harder.
    const sentinelEl = findPaginationSentinel(lastCard);
    let sentinelSeen = false;
    if (sentinelEl) {
      sentinelSeen = await probeSentinelVisibility(sentinelEl, 1500);
    }
    // Belt-and-suspenders: dispatch a wheel event on the scroller as if
    // the user wheel-scrolled. Some pagination listeners only react to
    // real scroll-input events.
    if (scroller) dispatchWheelDown(scroller);
    await clickLoadMoreButton();
    await sleep(jitter(SCROLL_DELAY_MIN_MS, SCROLL_DELAY_MAX_MS));
    let afterCount = document.querySelectorAll(KAJABI_SELECTORS.postCard).length;
    let afterY = scroller?.scrollTop ?? 0;

    // If nothing showed up in the regular wait, give Kajabi extra time
    // before counting it as a stall. Slow GraphQL responses + post-modal
    // layout settles routinely take >2s on top of the SCROLL_DELAY.
    if (afterCount === beforeCount) {
      await sleep(STALL_EXTRA_WAIT_MS);
      afterCount = document.querySelectorAll(KAJABI_SELECTORS.postCard).length;
      afterY = scroller?.scrollTop ?? 0;
    }

    if (afterCount === beforeCount) {
      stalls += 1;
      const scrollerInfo = scroller
        ? `<${scroller.tagName.toLowerCase()}>${scroller.id ? `#${scroller.id}` : ""}.${(scroller.className || "").split(/\s+/).slice(0, 2).join(".")} (delta ${scroller.scrollHeight - scroller.clientHeight}px)`
        : "null";
      console.log(
        `[research-bot] scroll stall ${stalls}/${SCROLL_STALL_LIMIT} (cards=${afterCount} y=${beforeY}→${afterY} scroller=${scrollerInfo} sentinel=${sentinelEl ? "yes" : "no"} sentinelVisibleToOurIO=${sentinelSeen}) — totals: sent=${totalSent} seen=${totalSeen}`,
      );
      if (!diagnosedOnce) {
        diagnoseFeedAfterLastCard(all);
        diagnosedOnce = true;
      }
      if (stalls >= SCROLL_STALL_LIMIT) {
        exitReason = `stall-limit (${SCROLL_STALL_LIMIT} consecutive)`;
        break;
      }
    } else {
      console.log(
        `[research-bot] scroll: ${beforeCount}→${afterCount} cards (y=${beforeY}→${afterY}) — totals: sent=${totalSent} seen=${totalSeen}`,
      );
      stalls = 0;
    }
  }

  const finalCardCount = document.querySelectorAll(KAJABI_SELECTORS.postCard).length;
  const skipSummary = Object.entries(skipTally)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  console.log(
    `[research-bot] feed scrape ended: reason="${exitReason}" sent=${totalSent} seen=${totalSeen} cards-in-DOM=${finalCardCount} stalls=${stalls} skips=[${skipSummary || "none"}]`,
  );
  return { captured, exitReason };
}

/// One-shot DOM survey at the start of the run. Mainly to spot whether
/// posts are rendering under a non-PostCardContainer component, which
/// would explain "missing" posts that we never even tried to process.
function surveyDom(): void {
  const counts: Record<string, number> = {
    PostCardContainer: document.querySelectorAll(
      "[data-sentry-component='PostCardContainer']",
    ).length,
    ChannelPostCard: document.querySelectorAll(
      "[data-sentry-component='ChannelPostCard']",
    ).length,
    PaginatedList: document.querySelectorAll(
      "[data-sentry-component='PaginatedList']",
    ).length,
    PostCardHeaderCol: document.querySelectorAll(
      "[data-sentry-component='PostCardHeaderCol']",
    ).length,
    KcRichTextViewer: document.querySelectorAll(
      "[data-sentry-component='KcRichTextViewer']",
    ).length,
  };
  console.log(`[research-bot] DOM survey:`, counts);
}

/// Cheap shape probe of a single card so when parse fails we can see
/// whether the failure is caused by missing DOM rather than a bug in
/// the parser. Includes whether we found the author col, body container,
/// timestamp button, and inline thread.
function surveyCard(card: HTMLElement): Record<string, boolean | number> {
  const sel = KAJABI_SELECTORS;
  return {
    hasAuthorCol: !!card.querySelector("[data-sentry-component='PostCardHeaderCol']"),
    hasAuthorAnchor: !!card.querySelector(sel.post.authorLink),
    hasBodyContainer: !!card.querySelector(sel.post.bodyVisible),
    hasTimestampBtn: !!card.querySelector(sel.post.timestampBtn),
    hasInlineThread: !!card.querySelector(sel.thread.inlineContainer),
    bodyChildCount:
      card.querySelector(sel.post.bodyVisible)?.children.length ?? 0,
  };
}

/// Per-card outcome surfaced to the scrape loop so it can log a precise
/// reason for any skip.
type CardOutcome =
  | { kind: "ok"; item: KajabiPostItem; via: "inline" | "modal" | "modal-fallback-inline" }
  | { kind: "parse-failed"; reason: ParseFailure; via: "inline" | "modal" | "modal-fallback-inline" };

/// Process one post card: open the modal if it has comments, expand all
/// "View N replies" / "Show more" buttons, parse, close.
///
/// We attach `cardHtml` (always) and `modalHtml` (when applicable) to the
/// successfully-parsed item so the server can store them for forensic
/// comparison against what the parser extracted. This is verbose — each
/// row balloons by 5-50 KB — but invaluable while we're stabilizing
/// selectors.
async function processCard(card: HTMLElement): Promise<CardOutcome> {
  const scrapedAt = new Date().toISOString();
  const commentCountText = (
    card.querySelector(KAJABI_SELECTORS.post.commentCount)?.textContent ?? ""
  ).trim();
  const commentCount = readCount(commentCountText);

  if (commentCount === 0) {
    // Inline path: expand any "Show more" on the card body before
    // capturing its HTML, otherwise long bodies get stored truncated.
    const sm = await expandShowMoreUntilStable(card);
    if (sm.clicks > 0) {
      console.log(
        `[research-bot]   inline expansion: show-more clicks=${sm.clicks} iters=${sm.iters}`,
      );
    }
    const cardHtml = card.outerHTML;
    const r = parsePost(card, scrapedAt);
    if (r.ok) {
      r.item.cardHtml = cardHtml;
      return { kind: "ok", item: r.item, via: "inline" };
    }
    return { kind: "parse-failed", reason: r.reason, via: "inline" };
  }

  // Capture the inline card BEFORE opening the modal so we have a
  // record of how Kajabi rendered the truncated thread on the feed.
  const cardHtmlPreModal = card.outerHTML;

  const modal = await openModalForCard(card);
  if (!modal) {
    console.warn(
      `[research-bot]   modal failed to open within ${MODAL_OPEN_TIMEOUT_MS}ms; falling back to inline parse`,
    );
    const sm = await expandShowMoreUntilStable(card);
    if (sm.clicks > 0) {
      console.log(
        `[research-bot]   inline-fallback expansion: show-more clicks=${sm.clicks}`,
      );
    }
    const r = parsePost(card, scrapedAt);
    if (r.ok) {
      r.item.cardHtml = card.outerHTML;
      return { kind: "ok", item: r.item, via: "modal-fallback-inline" };
    }
    return { kind: "parse-failed", reason: r.reason, via: "modal-fallback-inline" };
  }

  try {
    reportPhase(`modal open: scrolling comments`);
    // 1) Initial scroll to load the first batch of comments.
    const scroll1 = await scrollModalCounted(modal);
    // 2) Expand all "View N replies" / "View all comments". This may
    //    extend the modal vertically with new content.
    reportPhase(`modal open: expanding replies`);
    const replies = await expandRepliesUntilExhausted(modal);
    // 3) Re-scroll: replies that pushed the bottom further down may
    //    still need lazy-loading.
    if (replies.clicks > 0) reportPhase(`modal open: re-scrolling after replies`);
    const scroll2 =
      replies.clicks > 0 ? await scrollModalCounted(modal) : { iters: 0, growth: 0 };
    // 4) Expand any "Show more" on bodies (post AND every comment),
    //    looped in case nested truncation reveals more.
    reportPhase(`modal open: expanding show-more`);
    const sm = await expandShowMoreUntilStable(modal);

    console.log(
      `[research-bot]   modal expansion: scroll1=${scroll1.iters}iter/+${scroll1.growth} replies=${replies.clicks}clicks/${replies.iters}iter scroll2=${scroll2.iters}iter/+${scroll2.growth} show-more=${sm.clicks}clicks/${sm.iters}iter`,
    );
    if (replies.iters >= REPLY_EXPAND_MAX_ITERATIONS) {
      console.warn(
        `[research-bot]   modal expansion HIT REPLY CAP — thread may have unexpanded replies`,
      );
    }

    const modalHtml = modal.outerHTML;
    const r = parsePost(modal, scrapedAt);
    if (r.ok) {
      r.item.cardHtml = cardHtmlPreModal;
      r.item.modalHtml = modalHtml;
      return { kind: "ok", item: r.item, via: "modal" };
    }
    return { kind: "parse-failed", reason: r.reason, via: "modal" };
  } finally {
    await closeModal();
  }
}

async function openModalForCard(card: HTMLElement): Promise<Element | null> {
  const btn = card.querySelector<HTMLButtonElement>(
    KAJABI_SELECTORS.post.timestampBtn,
  );
  if (!btn) return null;
  btn.click();

  const start = Date.now();
  while (Date.now() - start < MODAL_OPEN_TIMEOUT_MS) {
    const modal = lastOpenDialog();
    if (modal) {
      await waitForReactSettle();
      return modal;
    }
    await sleep(80);
  }
  return null;
}

function lastOpenDialog(): Element | null {
  const dialogs = document.querySelectorAll(KAJABI_SELECTORS.modal.root);
  if (dialogs.length === 0) return null;
  return dialogs[dialogs.length - 1] ?? null;
}

async function scrollModalCounted(modal: Element): Promise<{ iters: number; growth: number }> {
  const scrollable = findScrollableAncestor(modal);
  if (!scrollable) return { iters: 0, growth: 0 };
  const initial = modal.querySelectorAll(
    "[data-sentry-component='ChannelPostCommentContent']",
  ).length;
  let stalls = 0;
  let iters = 0;
  for (let i = 0; i < MODAL_SCROLL_MAX_ITERATIONS; i += 1) {
    iters += 1;
    const before = modal.querySelectorAll(
      "[data-sentry-component='ChannelPostCommentContent']",
    ).length;
    scrollable.scrollTop = scrollable.scrollHeight;
    await sleep(jitter(MODAL_SCROLL_DELAY_MIN_MS, MODAL_SCROLL_DELAY_MAX_MS));
    const after = modal.querySelectorAll(
      "[data-sentry-component='ChannelPostCommentContent']",
    ).length;
    if (after <= before) {
      stalls += 1;
      if (stalls >= MODAL_SCROLL_STALL_LIMIT) break;
    } else {
      stalls = 0;
    }
  }
  const final = modal.querySelectorAll(
    "[data-sentry-component='ChannelPostCommentContent']",
  ).length;
  return { iters, growth: final - initial };
}

function findScrollableAncestor(modal: Element): HTMLElement | null {
  // Modal scrollable is whichever child has overflow-auto/scroll AND
  // a positive scrollHeight - clientHeight gap.
  const candidates = modal.querySelectorAll<HTMLElement>("*");
  for (const el of Array.from(candidates)) {
    const cs = window.getComputedStyle(el);
    const scrollable =
      cs.overflowY === "auto" || cs.overflowY === "scroll";
    if (scrollable && el.scrollHeight - el.clientHeight > 50) {
      return el;
    }
  }
  return modal instanceof HTMLElement ? modal : null;
}

async function expandRepliesUntilExhausted(modal: Element): Promise<{ iters: number; clicks: number }> {
  const replyButtonRe = /^view\s+\d+\s+repl/i;
  const allCommentsRe = /^view\s+all\s+comments/i;
  let iters = 0;
  let clicks = 0;
  for (let i = 0; i < REPLY_EXPAND_MAX_ITERATIONS; i += 1) {
    const buttons = [
      ...findByText(modal, "button", replyButtonRe),
      ...findByText(modal, "button", allCommentsRe),
    ];
    if (buttons.length === 0) break;
    iters += 1;
    for (const b of buttons) {
      b.click();
      clicks += 1;
      await sleep(jitter(REPLY_CLICK_DELAY_MIN_MS, REPLY_CLICK_DELAY_MAX_MS));
    }
    await waitForReactSettle();
  }
  return { iters, clicks };
}

/// Click every visible "Show more" until none remain. Looped because
/// clicking one can reveal nested truncation in newly-expanded replies.
/// Cheap so we just retry until stable (cap at 8 iters).
async function expandShowMoreUntilStable(root: Element): Promise<{ iters: number; clicks: number }> {
  const showMoreRe = /^show\s+more$/i;
  let iters = 0;
  let clicks = 0;
  for (let i = 0; i < 8; i += 1) {
    const buttons = findByText(root, "span, button", showMoreRe);
    if (buttons.length === 0) break;
    iters += 1;
    for (const b of buttons) {
      b.click();
      clicks += 1;
      await sleep(SHOW_MORE_DELAY_MS);
    }
    await waitForReactSettle();
  }
  return { iters, clicks };
}

async function closeModal(): Promise<void> {
  // Strategy order:
  //   1. Click the Radix overlay (the `data-state="open"` `fixed inset-0`
  //      backdrop sibling of the dialog content). Empirically this is
  //      the most reliable close affordance — works even when the
  //      dialog's own close button is a no-op due to a transitional
  //      state.
  //   2. Fall back to the dialog's close button.
  //   3. Final fallback: dispatch Escape keydown.
  //
  // After each strategy we briefly check whether the dialog actually
  // closed and try the next one if not, so a stuck modal doesn't leave
  // the page in a weird state for subsequent cards.
  const overlay = document.querySelector<HTMLElement>(
    'div[data-state="open"][aria-hidden="true"][class*="fixed"][class*="inset-0"]',
  );
  if (overlay) {
    overlay.click();
    await sleep(MODAL_CLOSE_SETTLE_MS);
    if (!lastOpenDialog()) return;
  }

  const closeBtn =
    document.querySelector<HTMLButtonElement>(
      `${KAJABI_SELECTORS.modal.root} button[aria-label*='Close' i]`,
    ) ??
    document.querySelector<HTMLButtonElement>(
      `${KAJABI_SELECTORS.modal.root} [data-state='open'] button[type='button']`,
    );
  if (closeBtn) {
    closeBtn.click();
    await sleep(MODAL_CLOSE_SETTLE_MS);
    if (!lastOpenDialog()) return;
  }

  document.body.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
  );
  await sleep(MODAL_CLOSE_SETTLE_MS);
}

/// Best-effort UUID probe from a card without invoking the full parser.
/// Uses the SAME synthesis seed as `parsePost`'s `inferPostUuid` —
/// authorHref + first 200 chars of the visible post body — so a probe
/// hit guarantees a parser hit. Both paths must agree for dedup to work.
function inferUuidFromCard(card: HTMLElement): string | null {
  const authorAnchor = card.querySelector<HTMLAnchorElement>(
    KAJABI_SELECTORS.post.authorLink,
  );
  const authorHref = authorAnchor?.getAttribute("href") ?? "";
  const bodyText = extractRichText(card.querySelector(KAJABI_SELECTORS.post.bodyVisible));
  if (!authorHref && !bodyText) return null;
  return synthesizeUuid(`${authorHref}::${bodyText.slice(0, 200)}`);
}

function readCount(label: string): number {
  const m = label.match(/(\d+)/);
  return m ? Number(m[1]) : 0;
}

/// Print a one-line preview of the post and every comment we just parsed.
/// The body is truncated to 50 visible chars (with ellipsis) and indented
/// by reply depth so the conversation tree reads naturally in DevTools.
function logCapturedPost(item: KajabiPostItem): void {
  const head = oneLine(item.bodyText, 50);
  console.log(
    `[research-bot] post  ${item.uuid.slice(0, 8)}  [${item.author.name}] ${head}  (commentCount=${item.commentCount}, comments parsed=${item.comments.length})`,
  );
  if (item.comments.length === 0) return;

  // Build a depth map so child comments indent under their parent.
  const depthByUuid = new Map<string, number>();
  for (const c of item.comments) {
    const parentDepth = c.parentUuid ? depthByUuid.get(c.parentUuid) ?? 0 : 0;
    const depth = c.parentUuid ? parentDepth + 1 : 1;
    depthByUuid.set(c.uuid, depth);
    const indent = "  ".repeat(depth);
    const preview = oneLine(c.bodyText, 50);
    console.log(
      `[research-bot]   ${indent}↳ [${c.author.name}] ${preview}`,
    );
  }
}

function oneLine(s: string, maxChars: number): string {
  const compact = (s ?? "").replace(/\s+/g, " ").trim();
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, maxChars)}…`;
}

/// Find the element that actually scrolls the feed. Walk UP from a
/// postCard looking for the first ancestor whose scrollHeight exceeds
/// its clientHeight — that's the closest containing scroll container,
/// which is what Kajabi's IntersectionObserver root is most likely to
/// be set to. Picking "largest scrollable on the page" instead has been
/// observed to grab unrelated containers (sidebars, debug panels) whose
/// scroll position has nothing to do with feed pagination.
///
/// Falls back to `document.scrollingElement` and finally to the largest
/// scrollable on the page if no ancestor is scrollable (rare).
function findFeedScroller(): HTMLElement | null {
  const card = document.querySelector<HTMLElement>(KAJABI_SELECTORS.postCard);
  if (card) {
    let cursor: HTMLElement | null = card.parentElement;
    while (cursor && cursor !== document.body) {
      if (cursor.scrollHeight > cursor.clientHeight + 50) {
        return cursor;
      }
      cursor = cursor.parentElement;
    }
  }
  const docEl = document.scrollingElement as HTMLElement | null;
  if (docEl && docEl.scrollHeight > docEl.clientHeight + 50) return docEl;
  // Last resort: largest scrollable element on the page.
  const all = document.querySelectorAll<HTMLElement>("*");
  let best: HTMLElement | null = null;
  let bestDelta = 0;
  for (const el of all) {
    const delta = el.scrollHeight - el.clientHeight;
    if (delta > 50 && delta > bestDelta) {
      best = el;
      bestDelta = delta;
    }
  }
  return best;
}

/// Install a one-shot IntersectionObserver on the sentinel and resolve
/// `true` when it intersects (regardless of whether Kajabi's own IO
/// fires). This tells us whether the sentinel is *actually visible* —
/// if our IO fires and Kajabi still doesn't paginate, the bug is on
/// Kajabi's end (wrong root, broken Apollo, rate limit). If our IO
/// never fires, our scroll didn't work and we need to look elsewhere.
async function probeSentinelVisibility(
  sentinel: HTMLElement,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    let resolved = false;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            if (!resolved) {
              resolved = true;
              io.disconnect();
              resolve(true);
            }
            return;
          }
        }
      },
      { threshold: 0 },
    );
    io.observe(sentinel);
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        io.disconnect();
        resolve(false);
      }
    }, timeoutMs);
  });
}

/// Dispatch a synthetic wheel event on the scroller as if the user
/// actually wheel-scrolled. Some pagination listeners only react to
/// genuine scroll input rather than programmatic scrollTop mutation.
function dispatchWheelDown(target: Element): void {
  const evt = new WheelEvent("wheel", {
    bubbles: true,
    cancelable: true,
    deltaY: 500,
    deltaMode: 0,
  });
  target.dispatchEvent(evt);
}

/// Find Kajabi's PaginatedList IntersectionObserver sentinel: a small
/// (1px-tall) empty div that lives as the LAST sibling of the post
/// cards inside their common parent. When this element scrolls into
/// view, Kajabi calls Apollo `fetchMore`. Returns null if no sentinel
/// is detectable (in which case we fall back to bulk scrolling).
function findPaginationSentinel(lastCard: HTMLElement | undefined): HTMLElement | null {
  if (!lastCard) return null;
  const parent = lastCard.parentElement;
  if (!parent) return null;
  // Walk siblings AFTER the last card looking for a small div with
  // empty text content. The `.h-px` (1px tall) class is what we've
  // observed Kajabi using; we also accept any tiny empty div.
  let cursor: Element | null = lastCard.nextElementSibling;
  while (cursor) {
    if (cursor instanceof HTMLElement) {
      const isLikelySentinel =
        cursor.classList.contains("h-px") ||
        (cursor.tagName === "DIV" &&
          (cursor.textContent ?? "").trim() === "" &&
          cursor.children.length === 0);
      if (isLikelySentinel) return cursor;
    }
    cursor = cursor.nextElementSibling;
  }
  return null;
}

/// Trigger Kajabi pagination. Empirically, the only thing that
/// reliably loads more posts is `scrollIntoView` on the IO sentinel —
/// the browser walks up internally to find the actual scroll
/// container and aligns the sentinel there. Direct scrollTop assignment
/// on the candidate scroller has been observed to be a no-op (the
/// element exposes scrollHeight but doesn't accept scroll input).
///
/// We still keep the sentinel scrollIntoView + a final lastCard fallback
/// for layouts where no sentinel can be found, plus a synthetic scroll
/// event so any window-level listeners get a kick.
function scrollFeedDown(_scroller: HTMLElement | null, lastCard: HTMLElement | undefined): void {
  const sentinel = findPaginationSentinel(lastCard);
  if (sentinel) {
    sentinel.scrollIntoView({ block: "end", behavior: "auto" });
  } else if (lastCard) {
    lastCard.scrollIntoView({ block: "end", behavior: "auto" });
  }
  window.dispatchEvent(new Event("scroll", { bubbles: true }));
}

/// Click any visible feed-pagination button. Filters out buttons inside
/// post cards (those are body/comment expanders like "Show more" on a
/// long body, "View 2 replies" inside a thread — they don't load new
/// posts). Real pagination buttons are siblings of the post list, not
/// descendants of cards. Returns true if at least one button was clicked.
async function clickLoadMoreButton(): Promise<boolean> {
  const re = /^(load|show|view)\s+(more|older|previous)|^older\s+posts?$/i;
  const all = findByText(document, "button", re);
  const paginationOnly = all.filter(
    (b) => !b.closest(KAJABI_SELECTORS.postCard),
  );
  if (paginationOnly.length === 0) return false;
  console.log(
    `[research-bot] clicking ${paginationOnly.length} pagination button(s): ${paginationOnly.map((b) => `"${(b.textContent ?? "").trim()}"`).join(", ")}`,
  );
  for (const b of paginationOnly) {
    b.click();
    await sleep(jitter(200, 500));
  }
  return true;
}

/// One-shot DOM dump on the first scroll stall. Prints the parent of the
/// post cards (PaginatedList container), what's after the last card, and
/// any buttons in the area — so when scrolling fails we can immediately
/// see whether there's a sentinel/button we should be targeting.
function diagnoseFeedAfterLastCard(cards: HTMLElement[]): void {
  if (cards.length === 0) return;
  const last = cards[cards.length - 1]!;
  const list = last.parentElement;
  if (!list) return;
  console.log(
    `[research-bot] feed list parent: <${list.tagName.toLowerCase()}> classes="${list.className.slice(0, 80)}" scrollDelta=${list.scrollHeight - list.clientHeight}px children=${list.children.length}`,
  );
  const siblings: string[] = [];
  let n: Element | null = last.nextElementSibling;
  let i = 0;
  while (n && i < 6) {
    const tag = n.tagName.toLowerCase();
    const cls = (n.className && typeof n.className === "string" ? n.className : "").slice(0, 60);
    const txt = (n.textContent ?? "").trim().slice(0, 40);
    siblings.push(`<${tag}> "${txt}" .${cls}`);
    n = n.nextElementSibling;
    i += 1;
  }
  console.log(`[research-bot] siblings after last card: ${siblings.length === 0 ? "(none)" : siblings.join(" | ")}`);
  // Buttons that look like pagination triggers (avoid dumping the
  // hundreds of "Reply", author name, and "GIF" buttons that flood the
  // feed region). Look for ones whose text matches load-more-ish
  // phrasing AND aren't inside a post card.
  const region = list.parentElement ?? list;
  const candidates = Array.from(region.querySelectorAll<HTMLButtonElement>("button"))
    .filter((b) => !b.closest(KAJABI_SELECTORS.postCard))
    .map((b) => (b.textContent ?? "").trim())
    .filter((t) => t.length > 0 && t.length < 40);
  console.log(
    `[research-bot] non-card buttons in feed region: ${candidates.length === 0 ? "(none)" : candidates.slice(0, 20).join(" | ") + (candidates.length > 20 ? ` … (+${candidates.length - 20} more)` : "")}`,
  );
  console.log(
    `[research-bot] viewport: window.innerHeight=${window.innerHeight} body.scrollHeight=${document.body.scrollHeight} doc.scrollHeight=${document.documentElement.scrollHeight} doc.scrollTop=${document.documentElement.scrollTop}`,
  );
}


function synthesizeUuid(seed: string): string {
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

async function fetchSeenUuids(): Promise<string[]> {
  try {
    const reply = (await chrome.runtime.sendMessage({
      type: "kajabi:seen-uuids",
    })) as { uuids?: string[] } | undefined;
    return reply?.uuids ?? [];
  } catch {
    return [];
  }
}

async function askIfManaged(): Promise<boolean> {
  try {
    const reply = (await chrome.runtime.sendMessage({
      type: "scrape:am-i-managed",
    })) as { managed?: boolean } | undefined;
    return reply?.managed === true;
  } catch {
    return false;
  }
}

function sendComplete(postsCaptured: number): void {
  chrome.runtime
    .sendMessage({ type: "kajabi:complete", postsCaptured })
    .catch(() => {});
}

function sendFail(reason: ScrapeFailReason, error?: string): void {
  chrome.runtime
    .sendMessage({ type: "kajabi:fail", reason, error })
    .catch(() => {});
}

/// Report a one-line phase string back to the server so the CLI can show
/// it in its silence heartbeat. Debounced — only fires when the message
/// changes, so callers can sprinkle it freely without flooding the API.
let lastReportedPhase: string | null = null;
function reportPhase(phase: string): void {
  if (phase === lastReportedPhase) return;
  lastReportedPhase = phase;
  chrome.runtime.sendMessage({ type: "kajabi:phase", phase }).catch(() => {});
}
