# research-bot

Personal tool for mining niche SaaS opportunities that a solo dev could
realistically grow to ≥$15k/mo with favorable CAC/LTV. Ingests Reddit,
HackerNews, and ProductHunt, uses Claude (via your Max/Pro subscription) to
extract structured pain signals, clusters them with local embeddings, and
scores each cluster as a candidate opportunity.

Runs entirely on your machine. No cloud, no deploy, no API costs.

## Architecture

```
ingest scripts  ─┐                               ┌─ Next.js dashboard
                 ├─► SQLite (prisma/dev.db) ◄────┤   (pnpm dev → localhost:3000)
pipeline scripts ┘                               └─ queue + opportunity list
```

- **Ingest** (`scripts/ingest/*`): stateless fetchers, idempotent on `(source, externalId)`.
- **Pipeline** (`scripts/pipeline/*`): signals → embed → cluster → research.
- **Dashboard** (`src/app/*`): Next.js 16 Server Components reading straight from Prisma.

## Setup

### 1. Dependencies

```bash
pnpm install
```

### 2. Claude subscription auth

The research pipeline uses the [`@anthropic-ai/claude-agent-sdk`][sdk], which
authenticates via your local `claude` CLI — so make sure you're logged in:

```bash
claude --version    # should print a version
```

If not logged in, run `claude` once and follow the subscription sign-in flow.
No API key required. Token cost of running the pipeline: **$0**.

[sdk]: https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk

### 3. Ollama (local embeddings)

```bash
brew install ollama
ollama serve &                     # or run it as a background service
ollama pull nomic-embed-text       # 274 MB
```

Ollama listens on `http://127.0.0.1:11434`. Override with `OLLAMA_HOST` if needed.

### 4. Database

```bash
pnpm db:migrate                    # creates prisma/dev.db
```

### 5. Source credentials (`.env`)

Only HackerNews works with zero config. Reddit and ProductHunt need API tokens.
Copy `.env.example` to `.env` and fill in what you want:

```bash
cp .env.example .env
```

#### Reddit

Uses public JSON endpoints — no app, no credentials. Set only a User-Agent
(as an etiquette signal to Reddit):

```
REDDIT_USER_AGENT=research-bot/0.1 by <your-reddit-username>
```

The ingest sleeps ~6.5s between subreddits to stay under the ~10 req/min
unauthenticated rate limit. A full run over the default 15-sub list takes
~100s.

#### ProductHunt

Create an app at https://www.producthunt.com/v2/oauth/applications and set:

```
PRODUCTHUNT_TOKEN=<your developer token>
```

## Usage

### One-off run

```bash
pnpm ingest:hn                     # free, no auth
pnpm ingest:reddit                 # no auth needed
pnpm ingest:ph                     # needs PRODUCTHUNT_TOKEN

pnpm pipeline:all                  # signals → embed → cluster → research

pnpm dev                           # open http://localhost:3000
```

### Individual stages

```bash
pnpm pipeline:signals --limit 20         # extract signals from new RawPosts
pnpm pipeline:embed                      # embed all unembedded signals
pnpm pipeline:cluster --threshold 0.82   # cosine clustering into Opportunities
pnpm pipeline:research --limit 5         # Claude researches + scores candidates
```

All stages are idempotent — re-running picks up only new work.

### Inspecting the DB

```bash
pnpm db:studio                     # Prisma Studio at http://localhost:5555
```

## How it ranks opportunities

The research agent emits four 0-10 subscores per opportunity:

- **demandScore** — how much real, active demand does the signal cluster show
- **monetizationScore** — willingness-to-pay evidence (users already paying $X for worse alternatives?)
- **soloDevScore** — feasible for one person to build, ship, and support
- **competitionScore** — how crowded the space is (penalty)

The final rank score combines them (see `src/lib/scoring.ts`) — tweak weights
there without touching the DB. Scores recompute on read in the dashboard.

## Hybrid provider: Claude vs local Ollama for signal extraction

The signals stage can run on either Claude (via your subscription) or a local
Ollama model. The research stage always uses Claude — tool-using agents on
local models aren't worth the integration pain yet.

```bash
# Default (no env needed):
#   Claude via Agent SDK — best judgment, subscription rate limits apply.

# Opt in to local:
SIGNALS_PROVIDER=ollama
OLLAMA_SIGNALS_MODEL=qwen2.5:14b-instruct   # pull first: ollama pull qwen2.5:14b-instruct
```

When to flip to local:
- You want to burn through 10k+ posts without hitting the subscription cap.
- You're doing it overnight / unattended.
- You're OK with ~5-15% more noise in the Signal table (clustering + regex
  gate upstream absorbs most of it).

Keep Claude when quality matters — e.g. after tuning niche selection and you
want the cleanest signal set.

## Token/cost optimization

1. **Claude via Agent SDK subscription** — zero marginal cost for signal
   extraction and research.
2. **Local Ollama embeddings** — zero cost, ~200ms/signal on Apple Silicon.
3. **Pain-regex pre-filter** (`scripts/lib/source.ts`) — only posts matching
   "I wish…", "is there a tool…", "spend $X", etc. reach Claude.
4. **Prompt caching** — the scoring rubric is in a cacheable system prompt.
5. **Batch at the cluster level** — Claude sees a whole cluster once per
   opportunity, not per signal.
6. **Idempotency everywhere** — re-running is free.

## Project layout

```
.
├── prisma/
│   ├── schema.prisma          # data model
│   └── dev.db                 # SQLite (gitignored)
├── prisma.config.ts           # Prisma 7 config (datasource.url)
├── src/
│   ├── app/                   # Next.js 16 dashboard
│   │   ├── page.tsx           # ranked opportunities
│   │   ├── opportunities/[id]/ # detail + Server Action for status
│   │   └── queue/             # pipeline status
│   ├── lib/
│   │   ├── db.ts              # Prisma singleton (better-sqlite3 adapter)
│   │   ├── claude.ts          # Agent SDK wrapper
│   │   ├── similarity.ts      # cosine + centroids
│   │   └── scoring.ts         # pure ROI scoring
│   └── generated/prisma/      # generated client (gitignored)
└── scripts/
    ├── lib/source.ts          # shared helpers + pain-regex gate
    ├── ingest/                # hackernews.ts, reddit.ts, producthunt.ts
    └── pipeline/              # signals.ts, embed.ts, cluster.ts, research.ts
```

## Roadmap

v1 is HN + Reddit + ProductHunt. After first useful outputs:

- [ ] IndieHackers (Playwright scrape of revenue listings)
- [ ] G2 / Capterra 1-2★ reviews (Firecrawl)
- [ ] Google keyword volume via DataForSEO
- [ ] launchd daily cron
- [ ] "Watch" mode — Claude re-checks promoted ideas weekly
- [ ] Markdown / Notion export
