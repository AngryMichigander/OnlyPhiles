# OnlyPhiles

Public accountability database tracking Republican politicians with sex crimes against children. Built with vanilla HTML/CSS/JS on Cloudflare Workers + Pages + D1.

## Architecture

```
Frontend (Cloudflare Pages)        API (Cloudflare Worker)        Database (D1/SQLite)
┌──────────────────────┐      ┌──────────────────────┐      ┌─────────────────┐
│ index.html + app.js  │─────▶│ worker/index.js      │─────▶│ people          │
│ admin.html + admin.js│      │   /api/people         │      │ crime_types     │
│ about.html           │      │   /api/stats          │      │ sources         │
│ style.css            │      │   /api/admin/*        │      └─────────────────┘
└──────────────────────┘      └──────────────────────┘
```

- **Frontend** — Static HTML/CSS/JS, no build step. Dark mode with IBM colorblind-safe palette.
- **API** — Cloudflare Worker serving public read endpoints and authenticated admin endpoints. Non-API routes proxy to Pages.
- **Database** — Cloudflare D1 (SQLite). Three tables: `people`, `crime_types`, `sources`. Schema in `worker/schema.sql`.
- **Data pipeline** — Source data in `data/people.json`. Scripts generate SQL, scrape/enrich entries, and extract dates.

## Project Structure

```
index.html              Main database page
about.html              About page with data sources and legal disclaimer
admin.html + admin.js   Admin interface for editing entries
app.js                  Client-side filtering, search, URL state sync
style.css               Dark mode, IBM colorblind-safe CSS custom properties
_headers                Cloudflare Pages security headers (CSP, HSTS, etc.)
wrangler.toml           Cloudflare Worker config

worker/
  index.js              Worker: API routes, auth, CORS, D1 queries
  schema.sql            D1 schema (CREATE TABLE IF NOT EXISTS, indexes)
  seed.sql              Generated INSERT statements (from seed-d1.js)

scripts/
  seed-d1.js            Converts people.json → seed.sql
  parse-goppredators.js Parses scraped data from goppredators.wordpress.com
  enrich-sources.js     Extracts news source links from scraped posts
  enrich-full.js        Full enrichment: summary, office, level, status
  extract-dates.js      Extracts event dates from cached raw HTML
  lib/extract-links.js  Shared HTML link extraction utility

tests/                  Vitest test suite (67 tests)
data/people.json        Canonical source data
```

## Development

### Prerequisites

- Node.js 20+
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) (`npx wrangler` works)
- Cloudflare account with D1 database

### Running locally

```bash
# Static frontend only (no API)
npx serve .

# Full stack with Worker API
npx wrangler dev
```

### Testing

```bash
npm test            # Run all 67 tests
npm run test:watch  # Watch mode
```

Tests cover worker API routing, response formatting, SQL helpers, and link extraction.

### Deployment

Deployment is automated via GitHub Actions:

**Production** (`.github/workflows/deploy.yml` — push to main):
1. Runs tests (67 vitest tests)
2. Validates schema + seed against staging D1 database (smoke test: row counts + orphan FK checks)
3. Conditionally applies schema/seed to production D1 (only when those files change)
4. Deploys Worker and Pages to production

**PR Previews** (`.github/workflows/preview.yml` — pull requests):
1. Runs tests
2. Deploys Pages preview at `<branch>.onlyphiles.pages.dev`
3. Deploys full-stack Worker preview at `onlyphiles-preview.angrymichigander.workers.dev` (shared — last PR wins)

Requires GitHub secrets: `CLOUDFLARE_API_TOKEN` (Workers Scripts Edit + D1 Edit + Cloudflare Pages Edit) and `CLOUDFLARE_ACCOUNT_ID`.

#### Manual deployment

```bash
npx wrangler deploy                                              # Deploy worker
npx wrangler d1 execute onlyphiles --remote --file=worker/schema.sql  # Apply schema
npx wrangler d1 execute onlyphiles --remote --file=worker/seed.sql    # Apply seed
```

## API

### Public endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/people` | Paginated list. Params: `q`, `status`, `level`, `state`, `crimeType`, `stillInOffice`, `sort`, `order`, `page`, `limit` |
| `GET` | `/api/people/:id` | Single person with crime types and sources |
| `GET` | `/api/stats` | Aggregate counts and distinct filter values |
| `GET` | `/api/health` | Database health check |

### Admin endpoints

Require authentication via Cloudflare Access JWT, CF Access cookie, or `X-Admin-Secret` header.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/admin/people` | Admin people list (same filtering as public) |
| `GET` | `/api/admin/people/:id` | Admin person detail |
| `PATCH` | `/api/admin/people/:id` | Update person fields |
| `PUT` | `/api/admin/people/:id/sources` | Replace sources array |

## Data Pipeline

Source data lives in `data/people.json`. To update the database:

```bash
# 1. Edit data/people.json (or run enrichment scripts)
# 2. Regenerate seed SQL
node scripts/seed-d1.js
# 3. Apply to D1 (or commit seed.sql and let CI handle it)
npx wrangler d1 execute onlyphiles --remote --file=worker/seed.sql
```

Enrichment scripts for bulk data import:

```bash
node scripts/parse-goppredators.js   # Parse scraped WordPress data
node scripts/enrich-sources.js       # Extract news links from posts
node scripts/enrich-full.js          # Full enrichment (summary, office, etc.)
node scripts/extract-dates.js        # Extract event dates from cached HTML
```

## Data Schema (people.json)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | yes | URL-friendly slug |
| `name` | string | yes | Full name |
| `status` | enum | yes | `convicted`, `charged`, `alleged` |
| `sources` | array | yes | Source URLs (at least one) |
| `level` | enum | | `federal`, `state`, `local`, `party-official`, `adjacent` |
| `state` | string | | Two-letter state code |
| `office` | string | | Office or role held |
| `crimeTypes` | array | | `csam`, `assault`, `trafficking`, `solicitation`, `statutory-rape`, `grooming`, `enablement` |
| `stillInOffice` | bool/null | | Whether they currently hold office |
| `offenseYear` | number | | Year of offense |
| `convictionYear` | number/null | | Year of conviction |
| `eventDate` | string | | Event date (YYYY-MM-DD) |
| `summary` | string | | 1-2 sentence factual summary |
