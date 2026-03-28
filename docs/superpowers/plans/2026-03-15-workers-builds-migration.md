# Workers Builds Migration Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace GitHub Actions CI/CD with Cloudflare Workers Builds and consolidate Worker + Pages into a single Worker with static assets.

**Architecture:** Single Worker serves both `/api/*` routes and static files from `public/` directory. Workers Builds deploys on push to main (production) and on non-main branches (preview with staging D1). GitHub Actions only runs tests on PRs.

**Tech Stack:** Cloudflare Workers, D1, Workers Builds, GitHub Actions (tests only)

**Spec:** `docs/superpowers/specs/2026-03-15-workers-builds-migration-design.md`

---

## Chunk 1: Move static files and update configuration

### Task 1: Move static files to `public/`

**Files:**
- Create: `public/` (directory)
- Move: `index.html` → `public/index.html`
- Move: `about.html` → `public/about.html`
- Move: `admin.html` → `public/admin.html`
- Move: `app.js` → `public/app.js`
- Move: `admin.js` → `public/admin.js`
- Move: `style.css` → `public/style.css`
- Move: `favicon.ico` → `public/favicon.ico`
- Move: `apple-touch-icon.png` → `public/apple-touch-icon.png`
- Move: `favicon-32.png` → `public/favicon-32.png`
- Move: `_headers` → `public/_headers`

- [ ] **Step 1: Create `public/` and move all static files**

```bash
mkdir -p public
git mv index.html about.html admin.html app.js admin.js style.css favicon.ico apple-touch-icon.png favicon-32.png _headers public/
```

The `_headers` file contains Cloudflare security headers (CSP, HSTS, etc.) and must be in the assets directory to be served.

- [ ] **Step 2: Verify moved files**

```bash
ls public/
```

Expected: `_headers about.html admin.html admin.js app.js apple-touch-icon.png favicon-32.png favicon.ico index.html style.css`

- [ ] **Step 3: Check for broken internal references in HTML files**

The HTML files reference each other and their JS/CSS files with relative paths (e.g., `<link href="style.css">`). Since they're all in `public/` together, relative references remain valid. Verify:

```bash
grep -n 'href="\|src="' public/index.html public/about.html public/admin.html | grep -v 'http'
```

Confirm all local references (style.css, app.js, admin.js, favicon paths) are relative and co-located. This also covers spec migration step 4 ("Update any internal references to moved files") — since all static files move together, no path updates are needed.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor: move static files to public/ for Workers assets"
```

### Task 2: Update wrangler.toml

**Files:**
- Modify: `wrangler.toml`

- [ ] **Step 1: Replace wrangler.toml contents**

Remove `routes`, `[env.staging]`. Keep `[env.preview]` with staging D1 and `workers_dev = true` (needed for the `*.workers.dev` subdomain used by preview deploys). Add `assets` config.

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
workers_dev = true
assets = { directory = "./public" }
[[env.preview.d1_databases]]
binding = "DB"
database_name = "onlyphiles-staging"
database_id = "08d75b1a-e7ff-47de-b4c5-849d514ce3b4"
```

- [ ] **Step 2: Commit**

```bash
git add wrangler.toml
git commit -m "config: simplify wrangler.toml for Workers Builds with assets"
```

### Task 3: Remove Pages proxy from worker/index.js

**Files:**
- Modify: `worker/index.js:90-93`

- [ ] **Step 1: Remove the Pages proxy fallback**

In `worker/index.js`, replace lines 90-93:

```js
      // Not an API route — pass through to Pages origin
      const pagesUrl = new URL(request.url);
      pagesUrl.hostname = env.PAGES_HOSTNAME || "onlyphiles.pages.dev";
      return fetch(new Request(pagesUrl.toString(), request));
```

With:

```js
      // Not an API route and no static asset matched — 404
      return json({ error: "Not found" }, 404, corsHeaders);
```

Note: With `assets` configured in wrangler.toml, the Workers runtime serves matching static files *before* the worker code runs. The worker only sees requests that didn't match a static file. This 404 handles the case where someone requests a non-existent path that's also not an API route. Uses `json()` helper with CORS headers for consistency with all other error responses.

- [ ] **Step 2: Run existing tests**

```bash
npm test
```

Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add worker/index.js
git commit -m "refactor: remove Pages proxy, return 404 for non-API/non-asset routes"
```

### Task 4: Clean up test file

**Files:**
- Modify: `tests/worker.test.js:36`

- [ ] **Step 1: Remove PAGES_HOSTNAME from mockEnv**

In `tests/worker.test.js`, remove the `PAGES_HOSTNAME` line from the `mockEnv` function:

```js
function mockEnv(overrides = {}) {
  return {
    DB: mockDB(),
    ADMIN_SECRET: "test-secret-xyz",
    ADMIN_ORIGIN: "https://onlyphiles.com",
    ...overrides,
  };
}
```

- [ ] **Step 2: Run tests**

```bash
npm test
```

Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add tests/worker.test.js
git commit -m "test: remove PAGES_HOSTNAME from mock env"
```

## Chunk 2: Replace GitHub Actions workflows

### Task 5: Delete deploy and preview workflows, create test-only workflow

**Files:**
- Delete: `.github/workflows/deploy.yml`
- Delete: `.github/workflows/preview.yml`
- Create: `.github/workflows/test.yml`

- [ ] **Step 1: Delete old workflows**

```bash
git rm .github/workflows/deploy.yml .github/workflows/preview.yml
```

- [ ] **Step 2: Create test-only workflow**

Create `.github/workflows/test.yml`:

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

- [ ] **Step 3: Run tests locally to confirm nothing is broken**

```bash
npm test
```

Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/
git commit -m "ci: replace deploy/preview workflows with test-only workflow"
```

## Chunk 3: Final verification and push

### Task 6: Final verification

- [ ] **Step 1: Run full test suite**

```bash
npm test
```

Expected: All tests pass.

- [ ] **Step 2: Verify file structure**

```bash
ls public/
ls .github/workflows/
cat wrangler.toml
```

Expected:
- `public/` contains all 10 files (9 static files + `_headers`)
- `.github/workflows/` contains `CLAUDE.md`, `claude-code-review.yml`, `claude.yml`, `test.yml` (no `deploy.yml` or `preview.yml`)
- `wrangler.toml` has `assets = { directory = "./public" }`, production D1, and `[env.preview]` with `workers_dev = true` and staging D1

- [ ] **Step 3: Verify no static files remain in project root**

```bash
ls *.html *.css *.ico *.png 2>/dev/null | head -5
test -f _headers && echo "FAIL: _headers still in root" || echo "OK"
test -f app.js && echo "FAIL: app.js still in root" || echo "OK"
test -f admin.js && echo "FAIL: admin.js still in root" || echo "OK"
```

Expected: No output from ls, all checks "OK".

### Task 7: Push and configure Workers Builds (manual dashboard steps)

- [ ] **Step 1: Push to main**

```bash
git push origin main
```

- [ ] **Step 2: Configure Workers Builds in Cloudflare Dashboard (manual)**

Production Worker (`onlyphiles`):
1. Go to Workers & Pages → `onlyphiles` → Settings → Builds
2. Connect GitHub repo `AngryMichigander/OnlyPhiles`
3. Set production branch: `main`
4. Build command: `npm ci`
5. Deploy command: `npx wrangler deploy`

- [ ] **Step 3: Deploy preview Worker manually**

This creates the `onlyphiles-preview` Worker that Step 6 will configure in the dashboard.

```bash
npx wrangler deploy --env preview
```

- [ ] **Step 4: Set preview admin secret**

```bash
npx wrangler secret put ADMIN_SECRET --env preview
```

Enter the admin secret value when prompted.

- [ ] **Step 5: Seed the staging database for preview testing**

```bash
npx wrangler d1 execute onlyphiles-staging --remote --file=worker/schema.sql --env=preview
npx wrangler d1 execute onlyphiles-staging --remote --file=worker/seed.sql --env=preview
```

- [ ] **Step 6: Configure preview Worker in Cloudflare Dashboard (manual)**

Depends on Step 3 having completed successfully — the `onlyphiles-preview` Worker must exist.

Preview Worker (`onlyphiles-preview`):
1. Go to Workers & Pages → `onlyphiles-preview` → Settings → Builds
2. Connect same GitHub repo `AngryMichigander/OnlyPhiles`
3. Non-production branch deploy command: `npx wrangler deploy --env preview`
4. Leave production branch unset or set to a branch that won't be pushed to

- [ ] **Step 7: Connect custom domain (manual)**

1. Remove `onlyphiles.com` custom domain from the Pages project first
2. Add `onlyphiles.com` as a custom domain on the `onlyphiles` Worker
3. Verify https://onlyphiles.com loads correctly

- [ ] **Step 8: Verify production security headers**

```bash
curl -sI https://onlyphiles.com | grep -i 'content-security-policy\|strict-transport\|x-frame'
```

Expected: CSP, HSTS, and X-Frame-Options headers present (served from `public/_headers`).

- [ ] **Step 9: Verify preview deploy**

Push a test branch and confirm:
- Workers Builds creates a preview deployment
- Preview URL loads the site
- Preview uses staging D1 (check via admin page)

- [ ] **Step 10: Update CLAUDE.md**

Update the Architecture section to reflect the single Worker with assets. Update Common Commands to reflect the new manual D1 workflow and Workers Builds deployment:

Architecture section changes:
- Remove mention of Pages as a separate deployable
- Add: Worker serves static files via `assets = { directory = "./public" }`
- Add: Deployed via Cloudflare Workers Builds (push to main auto-deploys)
- Add: Preview deploys use `[env.preview]` with staging D1

Common Commands section:

```markdown
## Common Commands

\```bash
# Serve locally (static files only, no API)
npx serve public
# or: cd public && python3 -m http.server

# Regenerate seed SQL from people.json
node scripts/seed-d1.js

# Apply schema + seed to D1 (production — run manually when data changes)
npx wrangler d1 execute onlyphiles --remote --file=worker/schema.sql
npx wrangler d1 execute onlyphiles --remote --file=worker/seed.sql

# Apply schema + seed to staging D1 (for preview testing)
npx wrangler d1 execute onlyphiles-staging --remote --file=worker/schema.sql --env=preview
npx wrangler d1 execute onlyphiles-staging --remote --file=worker/seed.sql --env=preview

# Deploy worker (normally handled by Workers Builds on push to main)
npx wrangler deploy

# Run tests
npm test
\```
```

- [ ] **Step 11: Commit CLAUDE.md update**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md for Workers Builds migration"
```
