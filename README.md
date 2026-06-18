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

tests/                  Vitest test suite (108 tests)
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
npm test            # Run all 108 tests
npm run test:watch  # Watch mode
```

Tests cover worker API routing, response formatting, SQL helpers, and link extraction.

### Deployment

Deployment is automated via GitHub Actions:

**Production** (`.github/workflows/deploy.yml` — push to main):
1. Runs tests (108 vitest tests)
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

#### Migrations

Migrations under `worker/migrations/` are additive changes to existing D1 databases — they are NOT applied automatically by the deploy pipeline. Apply each once, in order, after a PR introducing it has merged:

```bash
# Phase B: add review-tracking columns + indexes (staging first, then prod)
npx wrangler d1 execute onlyphiles-staging --remote \
  --file=worker/migrations/001_add_review_fields.sql
npx wrangler d1 execute onlyphiles --remote \
  --file=worker/migrations/001_add_review_fields.sql

# Phase B: seed flagged_reason from Phase 1 audit findings (idempotent —
# every UPDATE guards on `AND flagged_reason IS NULL`, so re-runs and
# admin-authored reasons are preserved). Regenerate first if you have new
# audit findings:
npm run data:import-flags
npx wrangler d1 execute onlyphiles-staging --remote \
  --file=worker/migrations/002_seed_flag_reasons.sql
npx wrangler d1 execute onlyphiles --remote \
  --file=worker/migrations/002_seed_flag_reasons.sql

# Phase B (auth): add actor column for audit trail. Required for the
# strict-mode auth flow to record the reviewer's email in last_reviewed_by.
npx wrangler d1 execute onlyphiles-staging --remote \
  --file=worker/migrations/003_add_last_reviewed_by.sql
npx wrangler d1 execute onlyphiles --remote \
  --file=worker/migrations/003_add_last_reviewed_by.sql
```

Each migration's header comments document the apply command and whether re-applying is safe.

## API

### Public endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/people` | Paginated list. Params: `q`, `status`, `level`, `state`, `crimeType`, `stillInOffice`, `sort`, `order`, `page`, `limit` |
| `GET` | `/api/people/:id` | Single person with crime types and sources |
| `GET` | `/api/stats` | Aggregate counts and distinct filter values |
| `GET` | `/api/health` | Database health check |

### Admin endpoints

Require authentication — see [Admin authentication](#admin-authentication) below.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/admin/people` | Admin people list (public params plus `flaggedOnly=1`, `unreviewedOnly=1`, `hiddenOnly=1`) |
| `GET` | `/api/admin/people/:id` | Admin person detail (includes `enabled`, `lastReviewedAt`, `flaggedReason`, `lastReviewedBy`) |
| `PATCH` | `/api/admin/people/:id` | Update person fields |
| `PUT` | `/api/admin/people/:id/sources` | Replace sources array |

`PATCH` accepts (snake_case or camelCase): `name`, `status`, `level`, `state`, `office`, `summary`, `crime_description`, `offense_year`, `conviction_year`, `event_date`, `still_in_office`, `enabled`, `last_reviewed_at`, `flagged_reason`. The server auto-stamps both `last_reviewed_at` (current UTC ISO) and `last_reviewed_by` (the verified JWT's `email` claim, or `'shared-secret'` for X-Admin-Secret auth) on every successful save **unless** the body explicitly provides `last_reviewed_at` — pass `last_reviewed_at: null` to mark an entry unreviewed (also clears `last_reviewed_by`). The `enabled`, `lastReviewedAt`, `flaggedReason`, and `lastReviewedBy` fields are stripped from public `/api/people*` responses.

### Admin authentication

The worker has two auth modes, controlled by env vars in [`wrangler.toml`](wrangler.toml) or via `wrangler secret put`.

**Strict mode (recommended for production)** — When both `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD` are set, the worker fetches JWKS from `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs` (cached for 1h), cryptographically verifies the RS256 signature on every JWT (header or `CF_Authorization` cookie), and validates `iss` / `aud` / `exp` / `iat` / `nbf`. The verified `email` claim (falling back to `sub`, then the literal `"verified-jwt"`) is written to `last_reviewed_by` on every PATCH so the audit trail records *who* reviewed *when*.

**Heuristic mode (default until you set `CF_ACCESS_AUD`)** — When either env var is unset, the worker accepts any JWT/cookie whose value starts with `ey` and skips signature validation. This is the legacy path and assumes Cloudflare Access at the edge is doing the real verification. A warning is logged once per isolate. Actor is recorded as `null` (no trustworthy email).

**X-Admin-Secret fallback** — kept in both modes for emergency / break-glass access. Set via `wrangler secret put ADMIN_SECRET`. Requests using this path record `last_reviewed_by = 'shared-secret'` so SSO-authored writes are distinguishable in audit queries.

To activate strict mode:

1. In the Cloudflare Zero Trust dashboard, create an Access Application that protects `https://onlyphiles.com/api/admin/*` (and ideally `https://onlyphiles.com/admin*` for the static page itself). Add a policy (e.g. emails matching `@slenk.dev`).
2. Copy the **Application Audience (AUD) Tag** from the application overview.
3. Set it as a wrangler secret on both environments:
   ```bash
   wrangler secret put CF_ACCESS_AUD
   wrangler secret put CF_ACCESS_AUD --env preview
   ```
4. `CF_ACCESS_TEAM_DOMAIN` is already set to `slenk.cloudflareaccess.com` in [`wrangler.toml`](wrangler.toml) for both envs.
5. Redeploy. Strict mode activates automatically when both env vars are populated; the heuristic-mode warning stops appearing.

**Page-level gate (optional, hardening)** — for full defense in depth, add a CF Access policy on the `/admin*` Pages route in the Zero Trust dashboard so the static admin page itself requires SSO before loading. The `/api/admin/*` worker auth is independent and unaffected.

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

### Data quality audit

Run read-only audits against the canonical data. These scripts never mutate `data/people.json`, `worker/seed.sql`, or the D1 database.

```bash
npm run data:audit          # Run all three audit scripts (inventory, flag-list, defamation-risk)
npm run data:source-liveness  # Probe all source URLs for liveness (15–30 min for full run)
npm run data:audit:all      # Run all audits including source-liveness probe
```

Output files (not committed — live under `.omo/research/`):
- `.omo/research/data-audit-2026-06-17.md` — master inventory report (also committed at `docs/audits/data-audit-2026-06-17.md`)
- `.omo/research/flagged-entries.csv` — prioritized flag-list with P0–P3 severity ratings
- `.omo/research/source-liveness.csv` — HTTP probe results for all source URLs
- `.omo/research/defamation-risk-flagged.md` — neutral-language smell-test report

Data-quality regression tests live in `tests/data-quality.test.js`. Ratchet baselines are stored in `tests/data-quality.baselines.json` — counts can only shrink, never grow.

### Admin review workflow

The admin interface (`/admin.html`) supports a triage loop over the 990 entries flagged by the Phase 1 audit:

- Filter bar: toggle "Flagged only" / "Unreviewed only" / "Hidden only" to narrow the list.
- Edit panel shows `Last reviewed by <email> on <ts>` (or "Never reviewed") + a "Mark unreviewed" button; "Hide from public" checkbox toggles `enabled=0`; "Flag reason" textarea captures admin notes (max 1000 chars).
- Every successful save auto-stamps both `last_reviewed_at` and `last_reviewed_by` (from the verified JWT email — see [Admin authentication](#admin-authentication)) so the list naturally drains as entries are reviewed and the audit trail records actor identity.
- Soft-hide (`enabled=0`) removes the entry from `/api/people*`, `/api/stats`, and the public site, but keeps it in admin for un-hiding.

To seed initial `flagged_reason` values from the audit findings, run `npm run data:import-flags` and apply the generated migration (`worker/migrations/002_seed_flag_reasons.sql`).

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
