# research-bot

Personal tool for mining niche SaaS opportunities a solo dev could realistically
grow to ≥$15k/mo with favorable CAC/LTV. Ingests **HackerNews**, **Reddit**,
**ProductHunt**, and **Upwork** (via a Chrome extension you control from the CLI),
uses Claude (via your Max/Pro subscription) to extract structured pain signals,
clusters them with local embeddings, and scores each cluster as a candidate
opportunity.

Runs entirely on your machine. **No cloud, no deploy, no API costs.**

## Repository layout

This is a **pnpm + Turborepo monorepo**.

```
research-bot/
├── apps/
│   ├── web/                          # Next.js 16 dashboard + ingest API + pipeline scripts
│   │   ├── src/
│   │   │   ├── app/                  # routes (page.tsx, opportunities/[id], queue, api/...)
│   │   │   ├── lib/                  # db, claude, llm, scoring, similarity, source, crawl
│   │   │   └── generated/prisma/     # Prisma client (gitignored)
│   │   ├── scripts/
│   │   │   ├── ingest/               # hackernews.ts, reddit.ts, producthunt.ts
│   │   │   ├── pipeline/             # signals.ts, embed.ts, cluster.ts, research.ts
│   │   │   ├── lib/source.ts         # re-exports the canonical source helpers
│   │   │   └── crawl.ts              # `pnpm crawl …` CLI
│   │   ├── prisma/
│   │   │   ├── schema.prisma
│   │   │   ├── migrations/
│   │   │   └── dev.db                # local SQLite (gitignored)
│   │   └── .env                      # local config (gitignored)
│   └── extension/                    # Chrome MV3 extension (Vite + crxjs)
│       ├── src/
│       │   ├── manifest.ts
│       │   ├── background/           # service worker + crawler
│       │   ├── content/upwork.ts     # page-type detection + capture + bot-signal probe
│       │   ├── parsers/              # job-search, job-detail, category-feed, helpers
│       │   ├── lib/                  # selectors, transport, crawl-transport, storage
│       │   ├── popup/                # status UI
│       │   └── options/              # endpoint setting + per-page-type toggles
│       └── dist/                     # `pnpm extension build` output (load this in chrome://extensions)
├── packages/
│   ├── shared/                       # zod schemas + types shared by web ↔ extension (Upwork, crawl)
│   └── tsconfig/                     # shared tsconfig bases
├── docs/                             # design notes (e.g. upwork-crawler-plan.md)
├── turbo.json
├── pnpm-workspace.yaml
└── package.json                      # workspace root with delegating scripts
```

## Architecture

```
ingest scripts ──┐                                  ┌─ Next.js dashboard
                 │                                  │   (pnpm dev → :3000)
crawl CLI  ──────┼──► SQLite (apps/web/prisma/dev.db) ──┤
                 │                                  ├─ /queue (pipeline status)
extension SW ────┘                                  └─ /opportunities
                       │
                       ▼
            signals → embed → cluster → research
```

- **Ingest** (`apps/web/scripts/ingest/*`) — stateless fetchers, idempotent on `(source, externalId)`. Used for HN / Reddit / ProductHunt.
- **Pipeline** (`apps/web/scripts/pipeline/*`) — signals → embed → cluster → research. Each stage is idempotent and resumable.
- **Crawler** (`pnpm crawl …` + extension SW) — for sources that need a logged-in browser session (Upwork). The CLI writes `CrawlJob` rows; the extension polls, drives a managed Chrome tab, and feeds captured items into the same RawPost table the ingest scripts use.
- **Dashboard** (`apps/web/src/app/*`) — Next.js 16 Server Components reading straight from Prisma. `dynamic = "force-dynamic"` everywhere so the UI always shows fresh DB state.

## Setup

### 1. Dependencies

```bash
pnpm install
```

### 2. Claude subscription auth

The signals + research stages use the [`@anthropic-ai/claude-agent-sdk`][sdk],
which authenticates via your local `claude` CLI:

```bash
claude --version    # should print a version
```

If not logged in, run `claude` once and follow the subscription sign-in flow.
**No API key required.** Token cost of running the pipeline: $0.

[sdk]: https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk

### 3. Ollama (local embeddings)

```bash
brew install ollama
ollama serve &
ollama pull mxbai-embed-large      # 669 MB, 1024-dim. Strong paraphrase recognition.
```

Override with a different model via `OLLAMA_EMBED_MODEL` in `.env`. Swapping
models invalidates existing embeddings + clusters — use
`pnpm pipeline:embed --reset` to rebuild.

Ollama listens on `http://127.0.0.1:11434`. Override with `OLLAMA_HOST` if needed.

### 4. Database

```bash
pnpm db:migrate    # creates apps/web/prisma/dev.db and runs all migrations
```

### 5. Source credentials (`apps/web/.env`)

Only HackerNews and Upwork-via-extension need zero credentials. Reddit and
ProductHunt need values; copy `.env.example` and fill in:

```bash
cp apps/web/.env.example apps/web/.env
```

#### Reddit

Public JSON endpoints — no app, no credentials. Set only a User-Agent
(etiquette signal):

```
REDDIT_USER_AGENT=research-bot/0.1 by <your-reddit-username>
```

The ingest sleeps ~6.5s between subreddits to stay under Reddit's ~10 req/min
unauthenticated limit. A full run over the default subreddit list takes ~100s.

#### ProductHunt

Create an app at <https://www.producthunt.com/v2/oauth/applications> and set:

```
PRODUCTHUNT_TOKEN=<your developer token>
```

#### Upwork

No `.env` setup needed — capture goes through your real Chrome session via
the extension. See [Upwork crawler](#upwork-crawler) below.

### 6. Load the Chrome extension (for Upwork capture)

```bash
pnpm extension build
```

Then in Chrome:

1. Open `chrome://extensions`
2. Enable **Developer Mode** (top right)
3. **Load unpacked** → select `apps/extension/dist/`
4. Click the extension icon → **Settings** → confirm endpoint is `http://localhost:3000/api/ingest/upwork` (or match the port your dev server is using)

The extension only activates on `https://www.upwork.com/*`. It runs in **two
modes simultaneously**:

- **Passive** — when you browse Upwork yourself, captured pages flow into RawPost.
- **Crawler-driven** — when you've enqueued jobs from the CLI, the extension's
  service worker drives a single managed background tab through them.

## Usage

### HN / Reddit / ProductHunt

```bash
pnpm ingest:hn                     # free, no auth
pnpm ingest:reddit                 # User-Agent only
pnpm ingest:ph                     # needs PRODUCTHUNT_TOKEN
```

### Upwork crawler

The crawler is controlled entirely from the CLI. The extension just executes.

```bash
pnpm crawl search "<query>" [--pages N] [--no-expand-detail]
pnpm crawl url <url>             [--no-expand-detail]
pnpm crawl status                [--watch]
pnpm crawl pause                 [--reason <text>]
pnpm crawl resume                # also expires stale leases
pnpm crawl clear                 [--all|--done|--failed|--pending]
pnpm crawl throttle <minMs> <maxMs>     # default 5000..9000
pnpm crawl expand-detail on|off         # default for new search-page jobs
```

**Typical flow:**

```bash
# 1. Enqueue 5 search-result pages for a query
pnpm crawl search "ai consultant" --pages 5

# 2. Watch progress (Ctrl-C to exit)
pnpm crawl status --watch

# 3. When done, run the existing pipeline
pnpm pipeline:all
```

By default, each captured search-result card auto-spawns a follow-up
`job-detail` job for the same `~01…` id, so the LLM gets the full description +
client stats instead of just the snippet. Disable with `--no-expand-detail`.

### How the crawler stays under the radar

- **Single managed tab.** The extension reuses one background tab for every
  navigation — no parallel fan-out.
- **Throttle window.** Inter-page delay is uniform-random in `[throttleMinMs,
  throttleMaxMs]` (default 5–9s). Tune with `pnpm crawl throttle 8000 15000`
  if Upwork ever rate-limits.
- **Real session.** All requests use your logged-in cookies — Upwork sees a
  human browsing, not a headless bot.
- **Bot-detection auto-pause.** The content script probes for CAPTCHA frames,
  login redirects, and rate-limit copy on every page. If it sees one, it
  fails the current `CrawlJob` with `reason: captcha | login_redirect |
  rate_limit` — and the server **flips the global pause flag**. The extension
  goes idle until you `pnpm crawl resume` (typically after solving the
  challenge in the managed tab manually).
- **Lease-based claim.** Each `/api/crawl/next` lease is 2 min; if the SW dies
  mid-job the lease expires and the job becomes claimable again.

### Pipeline (all sources)

```bash
pnpm pipeline:signals --limit 20         # extract signals from new RawPosts
pnpm pipeline:embed                      # embed all unembedded signals
pnpm pipeline:cluster --threshold 0.76   # cosine clustering into Opportunities
pnpm pipeline:cluster --reset            # wipe unresearched opps + rebuild
pnpm pipeline:research --limit 5         # Claude researches + scores top candidates
pnpm pipeline:all                        # all four, in order
```

All stages are idempotent — re-running picks up only new work.

### Inspecting state

```bash
pnpm dev                       # http://localhost:3000  → ranked dashboard
pnpm db:studio                 # http://localhost:5555  → Prisma Studio
pnpm crawl status --watch      # live crawl queue
```

The dashboard's `/queue` page shows source counts, signal/embedding/opportunity
counts, and the pipeline `Job` queue. The `/` page lists scored opportunities;
each `/opportunities/[id]` shows the signal cluster + research notes.

## How it ranks opportunities

The research agent emits four 0–10 subscores per opportunity:

- **demandScore** — how much real, active demand the signal cluster shows
- **monetizationScore** — willingness-to-pay evidence (users already paying $X for worse alternatives?)
- **soloDevScore** — feasible for one person to build, ship, and support
- **competitionScore** — how crowded the space is (penalty)

The final rank score combines them in `apps/web/src/lib/scoring.ts`. Tweak
weights there without touching the DB — scores recompute on read.

**Why Upwork data scores higher on `monetizationScore`:** the ingest route
prepends a structured prefix to each Upwork RawPost body before the signals
stage sees it:

```
[BUDGET: $500-1500 fixed | CLIENT_SPENT: $40k+ | PROPOSALS: 5-10 | POSTED: 2026-04-22]

{original job description}
```

This gives the signals LLM a clean numeric handle on willingness-to-pay
without changing any downstream code.

## Hybrid provider: Claude vs Ollama for signal extraction

The signals stage can run on either Claude (via your subscription) or a local
Ollama model. The research stage always uses Claude — tool-using agents on
local models aren't worth the integration pain yet.

```bash
# Default (no env needed):
#   Claude via Agent SDK — best judgment, subscription rate limits apply.

# Opt in to local:
SIGNALS_PROVIDER=ollama
OLLAMA_SIGNALS_MODEL=qwen2.5:14b-instruct   # ollama pull qwen2.5:14b-instruct
```

Switch to local when:
- Burning through 10k+ posts faster than the subscription cap allows
- Doing it overnight / unattended
- Willing to accept ~5–15% more noise (clustering + the regex pre-gate absorb most of it)

## Token / cost optimization

1. **Claude via Agent SDK subscription** — zero marginal cost for signals + research.
2. **Local Ollama embeddings** — zero cost, ~300ms/signal on Apple Silicon.
3. **Pain-regex pre-filter** (`apps/web/src/lib/source.ts`) — only HN/Reddit/PH
   posts matching "I wish…", "is there a tool…", "spend $X", etc. reach Claude.
   **Upwork bypasses this gate** because every job is by definition someone
   paying for pain.
4. **Prompt caching** — the scoring rubric is in a cacheable system prompt.
5. **Cluster-level batching** — Claude sees a whole cluster once per opportunity, not per signal.
6. **Idempotency everywhere** — re-running is free.

## Data model

`apps/web/prisma/schema.prisma`. The downstream pipeline doesn't care which
source a RawPost came from — adding a new source is "write an ingest path,
upsert RawPosts, done."

| Model         | Purpose |
|---|---|
| `Source`      | Per-platform metadata (`name` unique, `config` JSON). |
| `RawPost`     | Posts/comments/jobs. Unique on `(sourceId, externalId)`. `processedAt` is set after the signals stage runs (whether or not it emitted signals) so we don't burn calls re-evaluating. |
| `Signal`      | Pain/wish/complaint/spend/workflow extracted from a RawPost. Has an embedding (1024-dim Float32 from mxbai-embed-large). |
| `Opportunity` | Scored SaaS candidate. Centroid + 4 subscores + research notes. |
| `Evidence`    | Many-to-many Signal ↔ Opportunity, weighted. |
| `Job`         | Async job queue for pipeline observability (kind, status, attempts). Shown on `/queue`. |
| `CrawlJob`    | Upwork crawl-queue work item. `kind` ∈ {`search-page`, `job-detail`, `category-feed`}. Lease-based claim via `leaseUntil`. `parentId` lets a search job spawn detail children. |
| `CrawlConfig` | Singleton row controlling the crawler — `paused`, `pauseReason`, `throttleMinMs/Max`, default `expandToDetail`. |

## API surface (HTTP routes)

The extension is the only client of these routes. They're all CORS-gated to
`https://www.upwork.com` so curl/script use from localhost is fine.

| Route                                  | Method   | Purpose |
|---|---|---|
| `/api/ingest/upwork`                   | POST     | Bulk RawPost upsert. Body: `{ items: UpworkJobItem[] }` (zod-validated). Returns `{ created, updated, skipped }`. Detail-page captures overwrite search-card captures for the same `externalId`. |
| `/api/crawl/next`                      | GET      | Atomic claim of the next pending (or expired-lease) `CrawlJob`. Returns config + `job` (or `null`). 2-minute lease. |
| `/api/crawl/status`                    | GET      | Read-only status. Returns counts + paused state. Used by the popup so opening the popup doesn't claim jobs. |
| `/api/crawl/jobs/[id]/done`            | POST     | Mark a job done. Body: `{ itemsCaptured, capturedExternalIds }`. Auto-spawns `job-detail` children for search/feed jobs when `expandToDetail`. |
| `/api/crawl/jobs/[id]/fail`            | POST     | Mark a job failed. Body: `{ reason, error? }`. `captcha`/`login_redirect`/`rate_limit` reasons auto-pause the crawler. |

Wire formats live in [`packages/shared/src/`](packages/shared/src/) so the
extension and the route handlers share the same zod schemas.

## Adding a new source

1. **Decide the ingest model**: an HTTP API (use a `scripts/ingest/<name>.ts`
   script like HN/Reddit) or a logged-in browser session (use the extension +
   crawler — see Upwork for the template).
2. **Upsert RawPosts** keyed on `(sourceId, externalId)`. Use the existing
   `ensureSource(name, config?)` helper from `apps/web/src/lib/source.ts`.
3. **Decide on the pain-gate**: text-heavy social sources usually want
   `looksLikePain()` for cost control; structured high-intent sources (job
   boards, RFPs) should bypass it.
4. **(Optional) prefix structured metadata into the body** at ingest time so
   the signals LLM has it as text. See `formatUpworkBodyPrefix` in
   `packages/shared/src/upwork.ts` for the pattern.

The downstream pipeline runs unchanged.

## Development

```bash
# Typecheck
pnpm --filter @research-bot/web exec tsc --noEmit
pnpm --filter @research-bot/extension exec tsc --noEmit

# Build
pnpm build                       # both apps via Turborepo
pnpm extension build             # just the extension
pnpm web build                   # just the web app

# Migrations
pnpm db:migrate                  # creates a new migration if schema changed
pnpm --filter @research-bot/web exec prisma migrate reset    # nuke local DB
```

After a Prisma schema change you may need to **restart the dev server** so
the singleton `PrismaClient` (held on `globalThis`) picks up the new models.

The extension's selectors for Upwork's React DOM live in **one file**:
[`apps/extension/src/lib/selectors.ts`](apps/extension/src/lib/selectors.ts).
Upwork's hashed class names rotate, so when scraping breaks, that's the only
file you need to touch. Prefer `data-test`, `data-cy`, ARIA, and semantic
selectors over class names.

## Roadmap

- [x] HN / Reddit / ProductHunt ingest
- [x] Upwork via Chrome extension + CLI-driven crawler with throttle + auto-pause
- [ ] IndieHackers (Playwright scrape of revenue listings)
- [ ] G2 / Capterra 1–2★ reviews (Firecrawl)
- [ ] Google keyword volume via DataForSEO
- [ ] launchd daily cron (HN/Reddit/PH only — Upwork stays human-paced)
- [ ] "Watch" mode — Claude re-checks promoted ideas weekly
- [ ] Markdown / Notion export
- [ ] Auto-generate Upwork crawl plans from high-scoring Reddit clusters (cross-validate willingness-to-pay)

See `docs/upwork-crawler-plan.md` for the original Upwork design notes (some
details superseded by this README, but the *why* + filter strategies are still
useful).
