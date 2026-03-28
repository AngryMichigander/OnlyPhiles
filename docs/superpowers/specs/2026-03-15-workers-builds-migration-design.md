# Workers Builds Migration

Migrate from GitHub Actions (deploy.yml + preview.yml) to Cloudflare Workers Builds. Consolidate the Worker + Pages deployables into a single Worker with static assets served from a `public/` directory.

## Current State

- **Two deployables:** Cloudflare Worker (API at `/api/*`) and Cloudflare Pages (static HTML/CSS/JS)
- **Two GitHub Actions workflows:** `deploy.yml` (test → staging D1 validation → deploy) and `preview.yml` (test → deploy preview worker + pages → comment on PR)
- **Three wrangler environments:** production, staging, preview
- **Pain points:** API token permission issues, shared preview worker (last PR wins), complex multi-step workflows, Pages proxy hack in worker code

## Target State

- **One deployable:** Single Worker with `assets = { directory = "./public" }` serves both API and static files
- **Workers Builds** handles all deployments (push to main → deploy, push to branch → preview URL)
- **One slim GitHub Actions workflow** runs `npm test` on PRs only
- **Preview environment** uses `--env preview` with staging D1 database for safe admin testing

## Changes

### Move static files to `public/`

Create a `public/` directory containing only files that should be publicly accessible:

```
public/
  index.html
  about.html
  admin.html
  app.js
  admin.js
  style.css
  favicon.ico
  apple-touch-icon.png
  favicon-32.png
```

This prevents internal files (`wrangler.toml`, `data/people.json`, `worker/seed.sql`, `scripts/`) from being served as static assets.

### wrangler.toml

Remove `routes` and the `[env.staging]` environment. Keep a `[env.preview]` environment that binds to the staging D1. Add assets configuration pointing to `public/`.

```toml
name = "onlyphiles"
main = "worker/index.js"
compatibility_date = "2024-01-01"
assets = { directory = "./public" }

[[d1_databases]]
binding = "DB"
database_name = "onlyphiles"
database_id = "5624c86d-e5b6-4808-90c6-2356fdd5033a"

[env.preview]
assets = { directory = "./public" }
[[env.preview.d1_databases]]
binding = "DB"
database_name = "onlyphiles-staging"
database_id = "08d75b1a-e7ff-47de-b4c5-849d514ce3b4"
```

The `routes` config is no longer needed — the custom domain is connected to the Worker in the dashboard. The `assets` directive tells the Worker to serve static files from `public/`. The preview environment uses the staging D1 database so admin operations are safe to test.

### worker/index.js

Remove the Pages proxy fallback. With assets configuration, non-API requests are handled by the assets layer automatically. The worker only needs to handle `/api/*` routes. Non-API requests fall through to the static assets handler.

Current proxy code to remove:
```js
// Proxy to Pages for non-API routes
const pagesHost = env.PAGES_HOSTNAME || "onlyphiles.pages.dev";
// ... fetch from pages
```

### Workers Builds Configuration (Cloudflare Dashboard)

Per the [advanced setups docs](https://developers.cloudflare.com/workers/ci-cd/builds/advanced-setups/), wrangler environments work with Workers Builds by deploying each environment as a separate Worker and connecting the repo to each:

1. **Production Worker (`onlyphiles`):**
   - **Repository:** `AngryMichigander/OnlyPhiles`
   - **Production branch:** `main`
   - **Build command:** `npm ci`
   - **Deploy command:** `npx wrangler deploy`

2. **Preview Worker (`onlyphiles-preview`):**
   - First deploy manually: `npx wrangler deploy --env preview` to create the Worker
   - Connect the same repo to this Worker
   - **Production branch:** (none / leave unset)
   - **Non-production branch deploy command:** `npx wrangler deploy --env preview`
   - This creates per-branch preview URLs pointing at the staging D1

### D1 Migrations

D1 schema and seed are **not** applied automatically on every deploy. They are applied manually via `wrangler d1 execute` when the data changes, same as today's local workflow. This preserves any admin edits made via the admin API between deploys.

For the staging/preview database, seed data can be applied freely since it's not production:
```bash
npx wrangler d1 execute onlyphiles-staging --remote --file=worker/schema.sql --env=preview
npx wrangler d1 execute onlyphiles-staging --remote --file=worker/seed.sql --env=preview
```

### GitHub Actions

**Delete:** `.github/workflows/deploy.yml`, `.github/workflows/preview.yml`

**Create:** `.github/workflows/test.yml` — runs `npm test` on pull requests only.

```yaml
name: Test
on:
  pull_request:
    branches: [main]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - run: npm ci
      - run: npm test
```

Other existing workflows (`claude-code-review.yml`, `claude.yml`) are unaffected.

### What Gets Removed

- `.github/workflows/deploy.yml`
- `.github/workflows/preview.yml`
- `[env.staging]` section from wrangler.toml (consolidated into `[env.preview]`)
- `routes` from wrangler.toml
- Pages proxy logic in `worker/index.js`
- `PAGES_HOSTNAME` env var references

### DNS / Routing

The Worker currently uses a route pattern `onlyphiles.com/api/*`. With Workers Builds, the custom domain `onlyphiles.com` is connected directly to the Worker in the Cloudflare dashboard. All traffic hits the Worker; static assets are served by the assets layer, API routes by the worker code.

## Preview Deployments

Workers Builds deploys the preview environment Worker (`onlyphiles-preview`) on non-production branch pushes. Each preview deploy:
- Gets a unique preview URL from Workers Builds
- Binds to the **staging D1 database** (not production)
- Has its own admin secret (set via `wrangler secret put ADMIN_SECRET --env preview`)
- Allows full admin page testing without any production risk

Preview URLs appear in the Cloudflare dashboard and are surfaced via GitHub deployment status checks.

## Migration Steps

1. Create `public/` directory and move static files into it
2. Update `wrangler.toml` — consolidate to production + preview environments, add assets config, remove routes
3. Update `worker/index.js` — remove Pages proxy fallback
4. Update any internal references to moved files (e.g. test imports)
5. Delete `deploy.yml` and `preview.yml`, create `test.yml`
6. Push to main
7. Deploy preview Worker manually: `npx wrangler deploy --env preview`
8. Set preview admin secret: `npx wrangler secret put ADMIN_SECRET --env preview`
9. Seed the staging database for preview testing
10. Connect repo to both Workers in Cloudflare dashboard (production + preview), configure build/deploy commands
11. Connect custom domain `onlyphiles.com` to the production Worker (remove Pages custom domain binding first to avoid conflict)
12. Verify production deploy works
13. Push a non-main branch and verify preview deploy with staging D1

## Rollback

If Workers Builds or the `--assets` approach fails after step 6-11:
- The old `deploy.yml` and `preview.yml` are in git history and can be restored
- Re-add the Pages custom domain binding
- Revert the wrangler.toml and worker/index.js changes

The Pages project should only be decommissioned after production is confirmed stable.
