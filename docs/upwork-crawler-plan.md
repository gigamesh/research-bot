# Upwork crawler — original design notes

> **Status: implementation diverged.** What actually shipped is the CLI
> (`pnpm crawl …`) + extension polling loop documented in the root
> [README.md](../README.md#upwork-crawler). The architecture below ("server
> returns a plan list, extension fetches it") is preserved here for the
> *reasoning* — why Upwork, what filters matter, level-2 ideas — not for
> the wire format. Treat the YAML spec and `/api/crawl-plan/upwork` references
> in this file as historical.

## Why Upwork (and not "whatever I browse")

Upwork listings are a structurally richer signal than Reddit posts:

| Reddit post | Upwork job listing |
|---|---|
| "I hate doing invoices" | "We need someone to reconcile QuickBooks + Shopify, $30/hr, 10hr/wk, client already spent $15k with 3 contractors" |
| 1 person venting | Verified willingness-to-pay, stack disclosed, recurring budget, client history |
| Inferred demand | Explicit demand with a price tag |

A cluster of 40 Upwork listings paying humans to "reconcile Shopify → QuickBooks monthly" is a SaaS opportunity you can title, price, and scope *from the listings alone*.

The problem with ad-hoc browsing is it biases scraping toward whatever you happened to search for that week — undermining the systematic-coverage advantage. Solution: **research-bot generates a crawl plan, the extension just executes it.** Keeps the "your browser, your session" property (no bot detection, no Cloudflare fight, no ToS bypass) while adding central control over coverage.

## What counts as "high value"

Filter listings to these properties; everything else is noise:

- **Recurring, not one-off.** "Design a logo" is garbage. Hourly + "monthly" / "ongoing" language is gold.
- **Glue-between-tools jobs.** Explicit integration gaps written as job posts ("sync X to Y", "reconcile between A and B").
- **Non-technical verticals.** Dental, HVAC, legal, real estate, beauty, accounting. Skip tech roles — those are freelancer supply, not SaaS demand.
- **Verified spender.** Only clients with payment verified AND $5k+ total spend history. Upwork exposes this on every listing; filter it out in the search URL, don't post-process.
- **Hourly > fixed-price.** Hourly almost always implies recurring pain.

Most of these map to Upwork URL params — construct the right search URLs, most of the filtering happens server-side before you scrape.

## Architecture

```
research-bot                          Chrome extension
┌──────────────────────┐              ┌────────────────────┐
│ GET /api/crawl-plan/ │ ──────────►  │ fetches plan       │
│  upwork              │              │ opens URL[0] in    │
│                      │              │   new tab          │
│ returns list of URLs │              │ scrapes DOM        │
│ (category × query    │              │ POST /api/ingest/  │
│  combos, pre-        │              │   upwork           │
│  filtered for $5k+   │              │ closes tab         │
│  clients)            │              │ next URL...        │
└──────────────────────┘              └────────────────────┘
        │                                      │
        └────────► SQLite (RawPost, source="upwork") ◄────┘
                        │
                        ▼
            signals → embed → cluster → research
                (unchanged downstream pipeline)
```

The entire downstream pipeline works unchanged — we just need a new `Source` row (`name: "upwork"`) and the RawPost shape stays the same.

## Crawl plan — YAML spec

A hand-curated starter. Edit the file, re-run the extension, coverage grows.

```yaml
# crawl-plan/upwork.yaml
filters:
  min_client_spend: 5000
  payment_verified: true
  job_type: hourly        # recurring pain > one-off
  hours_per_week_min: 10  # filters out micro-tasks

queries:
  # Classic integration-glue territory
  - category: "Accounting & Bookkeeping"
    terms:
      - "reconcile"
      - "sync quickbooks"
      - "monthly bookkeeping"
      - "between stripe and"
  - category: "Admin Support"
    terms:
      - "between shopify and"
      - "recurring data entry"
      - "CRM cleanup"
      - "export from"

  # Vertical + workflow combos (high solo-dev-SaaS ROI niches)
  - vertical: "dental practice management"
  - vertical: "HVAC dispatch"
  - vertical: "real estate transaction coordinator"
  - vertical: "law firm intake"
  - vertical: "salon booking"
  - vertical: "restaurant scheduling"
  - vertical: "property management"

  # Recurring ops roles that shouldn't exist if software worked
  - terms:
      - "marketing operations"
      - "revenue operations"
      - "integration specialist"
      - "data entry specialist"
```

Start with 20-30 combos. Expand weekly based on which clusters the bot surfaces as most promising.

## Implementation checklist — research-bot side

1. **`crawl-plan/upwork.yaml`** — seed file per spec above
2. **`src/lib/crawl-plan.ts`** — YAML loader + URL builder. Turns a `(category, term, filters)` triple into a fully-constructed Upwork search URL.
3. **`GET /api/crawl-plan/upwork`** — Next.js route handler. Reads the YAML, expands to `[{ url, category, query, vertical }]`, returns JSON. Extension polls this.
4. **`POST /api/ingest/upwork`** — Next.js route handler. Zod-validates the posted payload:
   ```ts
   z.object({
     jobs: z.array(z.object({
       externalId: z.string(),     // Upwork job id
       url: z.string().url(),
       title: z.string(),
       description: z.string(),
       budget: z.string().nullable(),       // "$30-50/hr" or "$500 fixed"
       clientSpend: z.number().nullable(),  // total $ spent historically
       skills: z.array(z.string()),
       postedAt: z.string().datetime(),
       scrapedFrom: z.object({ category: z.string(), query: z.string() }),
     })),
   })
   ```
   Writes one `RawPost` per job. Use `externalId` as the idempotency key (upsert on `sourceId_externalId`). Store the full job payload in `RawPost.rawJson` so you can re-extract fields later without re-crawling.
5. **`pnpm crawl-plan:print`** — helper script that dumps the expanded URL list for debugging the extension's input before writing the extension.
6. **`ensureSource("upwork")`** — called once by the ingest route before first upsert.

Est. ~150 lines + a day to seed the YAML right.

## Extension side — rough shape

(You're writing this, just leaving notes)

- Service worker fetches `/api/crawl-plan/upwork` on command
- Opens each URL in a background tab (or the current window, user preference)
- Content script scrapes the listing cards from the search page
- For each card, also open the detail page briefly to grab full description + client spend
- Batches posted results to `/api/ingest/upwork`
- Sleep jitter between requests to stay invisible in the site's own analytics
- A "Run scan" button in the popup; optional cron-style scheduling later

## Level-2 idea (don't build yet)

Once research-bot has Reddit clusters with scores, auto-generate crawl plan entries from them. Reddit tells you "HVAC contractors complain about dispatch" (score 7.8) → research-bot adds `"HVAC dispatch"` + `"field service between QBO"` queries to next week's plan → Upwork listings validate or falsify that cluster with actual willingness-to-pay data. Reddit becomes hypothesis generator, Upwork the price-tag validator.

Gate on: having real Reddit clusters with a few researched scores first, otherwise you're just auto-generating noise.

## Alternative sites worth the same treatment

If Upwork ends up being the right pattern, these fit the same architecture (crawl plan + extension + ingest endpoint):

- **Capterra / G2 reviews** (1-2★) — "what existing SaaS is failing customers." Complementary to Upwork: Upwork shows where *no* software serves a need; Capterra shows where *bad* software does.
- **LinkedIn Jobs** — roles like "Marketing Operations Coordinator", "Integration Specialist", "RevOps Analyst" = humans hired to do work software should. Narrower but very specific.
- **Fiverr** — gig listings show what freelancers have realized is recurring demand. Supply-side proxy for demand; weaker but easier to scrape.

Don't build more than one at a time. Upwork first, evaluate signal quality after a couple clusters, then decide.
