# Enabled Column Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an `enabled` column to the `people` table so records can be hidden from the public frontend while remaining accessible to admin.

**Architecture:** DB-only operational flag (not in people.json). Seed script refactored from delete-all/insert to upsert to preserve the flag across reseeds. Public API filters by `enabled = 1`; admin API sees all records.

**Tech Stack:** Cloudflare Workers, D1 (SQLite), Vitest

---

## Chunk 1: Schema + Seed Script

### Task 1: Update schema.sql

**Files:**
- Modify: `worker/schema.sql:4-17`

- [ ] **Step 1: Add `enabled` column to people table**

In `worker/schema.sql`, add `enabled INTEGER NOT NULL DEFAULT 1` after the `event_date` column:

```sql
  conviction_year INTEGER,
  event_date TEXT,
  enabled INTEGER NOT NULL DEFAULT 1 -- 0 = hidden from public, 1 = visible
);
```

- [ ] **Step 2: Commit**

```bash
git add worker/schema.sql
git commit -m "schema: add enabled column to people table"
```

### Task 2: Refactor seed script to upsert

**Files:**
- Modify: `scripts/seed-d1.js`

- [ ] **Step 1: Replace delete-all/insert with per-person upsert**

Replace the main generation block (the `if (require.main === module)` body) with upsert logic. Key changes:
- Remove global `DELETE FROM` statements
- Use `INSERT INTO people (...) VALUES (...) ON CONFLICT(id) DO UPDATE SET ...` excluding `enabled` from the SET clause
- Delete/reinsert `crime_types` and `sources` per person (`WHERE person_id = ?`)
- Add orphan cleanup at the end: delete people/crime_types/sources not in `people.json`

```javascript
if (require.main === module) {
  const dataPath = path.join(__dirname, "..", "data", "people.json");
  const outPath = path.join(__dirname, "..", "worker", "seed.sql");

  const people = JSON.parse(fs.readFileSync(dataPath, "utf-8"));

  const lines = [];

  // D1 remote execution doesn't support SQL BEGIN TRANSACTION.
  // D1 batch imports are already atomic.

  const dataCols = [
    "id", "name", "status", "level", "state", "office", "crime_description",
    "summary", "still_in_office", "offense_year", "conviction_year", "event_date",
  ];

  for (const p of people) {
    const values = [
      esc(p.id), esc(p.name), esc(p.status), esc(p.level), esc(p.state),
      esc(p.office), esc(p.crimeDescription), esc(p.summary),
      boolToInt(p.stillInOffice), intOrNull(p.offenseYear),
      intOrNull(p.convictionYear), esc(p.eventDate),
    ];

    // Upsert: update all data columns but NOT `enabled`
    const updates = dataCols.slice(1).map((col) => `${col} = excluded.${col}`).join(", ");

    lines.push(
      `INSERT INTO people (${dataCols.join(", ")}) VALUES (${values.join(", ")}) ON CONFLICT(id) DO UPDATE SET ${updates};`
    );

    // Replace crime_types for this person
    lines.push(`DELETE FROM crime_types WHERE person_id = ${esc(p.id)};`);
    if (Array.isArray(p.crimeTypes)) {
      for (const ct of p.crimeTypes) {
        lines.push(
          `INSERT INTO crime_types (person_id, crime_type) VALUES (${esc(p.id)}, ${esc(ct)});`
        );
      }
    }

    // Replace sources for this person
    lines.push(`DELETE FROM sources WHERE person_id = ${esc(p.id)};`);
    if (Array.isArray(p.sources)) {
      for (const url of p.sources) {
        lines.push(
          `INSERT INTO sources (person_id, url) VALUES (${esc(p.id)}, ${esc(url)});`
        );
      }
    }
  }

  // Orphan cleanup: remove people not in people.json
  const allIds = people.map((p) => esc(p.id)).join(", ");
  lines.push("");
  lines.push("-- Orphan cleanup: remove entries not in people.json");
  lines.push(`DELETE FROM sources WHERE person_id NOT IN (${allIds});`);
  lines.push(`DELETE FROM crime_types WHERE person_id NOT IN (${allIds});`);
  lines.push(`DELETE FROM people WHERE id NOT IN (${allIds});`);

  fs.writeFileSync(outPath, lines.join("\n"), "utf-8");
  console.log(`Wrote ${lines.length} lines to ${outPath}`);
  console.log(`  ${people.length} people (upsert)`);
}
```

- [ ] **Step 2: Regenerate seed.sql to verify**

Run: `node scripts/seed-d1.js`
Expected: "Wrote ... lines to worker/seed.sql" with "(upsert)" message

- [ ] **Step 3: Spot-check seed.sql has ON CONFLICT syntax**

Run: `head -5 worker/seed.sql`
Expected: First person entry uses `INSERT INTO people ... ON CONFLICT(id) DO UPDATE SET ...`

- [ ] **Step 4: Write test — seed script generates upsert SQL and excludes `enabled` from SET**

Add to `tests/worker.test.js` (or a new `tests/seed.test.js`):

```javascript
describe("seed-d1.js", () => {
  const { esc, boolToInt, intOrNull } = require("../scripts/seed-d1.js");

  it("generates ON CONFLICT upsert syntax", () => {
    // Run the script and check the output
    const { execSync } = require("child_process");
    const output = execSync("node scripts/seed-d1.js", { encoding: "utf-8" });
    expect(output).toContain("upsert");

    const fs = require("fs");
    const sql = fs.readFileSync("worker/seed.sql", "utf-8");
    expect(sql).toContain("ON CONFLICT(id) DO UPDATE SET");
  });

  it("does not include enabled in the upsert SET clause", () => {
    const fs = require("fs");
    const sql = fs.readFileSync("worker/seed.sql", "utf-8");
    // The SET clause should not contain "enabled = excluded.enabled"
    expect(sql).not.toContain("enabled = excluded.enabled");
  });

  it("includes orphan cleanup at end", () => {
    const fs = require("fs");
    const sql = fs.readFileSync("worker/seed.sql", "utf-8");
    expect(sql).toContain("-- Orphan cleanup");
    expect(sql).toContain("DELETE FROM people WHERE id NOT IN");
  });
});
```

- [ ] **Step 5: Run tests**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 6: Commit**

```bash
git add scripts/seed-d1.js worker/seed.sql tests/worker.test.js
git commit -m "refactor: seed script uses upsert to preserve enabled column"
```

---

## Chunk 2: Worker API Changes

### Task 3: Add `publicOnly` parameter to `handlePeopleList`

**Files:**
- Modify: `worker/index.js:121` (function signature)
- Modify: `worker/index.js:73-74` (public route call)
- Modify: `worker/index.js:61-63` (admin route call)

- [ ] **Step 1: Write failing test — public people list excludes disabled records**

Add to `tests/worker.test.js` in a new describe block:

```javascript
describe("Enabled column filtering", () => {
  it("public /api/people excludes disabled records", async () => {
    // The mock DB's batch returns are used for [count, data] then [crimeTypes, sources]
    // We verify the worker calls the DB — the key assertion is that the response succeeds
    // and the SQL includes enabled = 1 (verified by checking the worker code, not mock)
    const db = mockDB({
      batchResults: [
        [{ total: 1 }],
        [{ id: "a", name: "A", status: "alleged", enabled: 1, still_in_office: null }],
        [],
        [],
      ],
    });
    const res = await worker.fetch(req("/api/people"), mockEnv({ DB: db }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it passes (baseline)**

Run: `npm test`
Expected: All tests pass (this test establishes the baseline behavior)

- [ ] **Step 3: Add `publicOnly` parameter to `handlePeopleList`**

In `worker/index.js`, change the function signature:

```javascript
async function handlePeopleList(url, db, cors, { publicOnly = false } = {}) {
```

After the existing `whereClauses` array is created, add:

```javascript
  // Hide disabled records from public API
  if (publicOnly) {
    whereClauses.push("p.enabled = 1");
  }
```

Also add `p.enabled` to the `listCols` string so `formatPerson` receives the actual column value:

```javascript
  const listCols = "p.id, p.name, p.status, p.level, p.state, p.office, p.summary, p.still_in_office, p.offense_year, p.conviction_year, p.event_date, p.enabled";
```

Update the public route call:

```javascript
if (url.pathname === "/api/people") {
  return await handlePeopleList(url, env.DB, corsHeaders, { publicOnly: true });
}
```

The admin route call (around line 61) stays as-is (no `publicOnly` parameter = admin sees all).

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add worker/index.js tests/worker.test.js
git commit -m "feat: filter disabled records from public people list"
```

### Task 4: Add `publicOnly` parameter to `handlePersonById`

**Files:**
- Modify: `worker/index.js:240` (function signature)
- Modify: `worker/index.js:81-84` (public route call)
- Modify: `worker/index.js:58-60` (admin route call)

- [ ] **Step 1: Write failing test — public person endpoint returns 404 for disabled record**

Add to the "Enabled column filtering" describe block:

```javascript
  it("public /api/people/:id returns 404 for disabled record", async () => {
    const db = mockDB({ first: { id: "aaron-bruns", name: "Aaron Bruns", enabled: 0, still_in_office: null } });
    const res = await worker.fetch(req("/api/people/aaron-bruns"), mockEnv({ DB: db }));
    expect(res.status).toBe(404);
  });

  it("admin /api/admin/people/:id returns 200 for disabled record", async () => {
    const db = {
      prepare: () => ({
        bind: () => ({
          first: async () => ({ id: "aaron-bruns", name: "Aaron Bruns", status: "alleged", enabled: 0, still_in_office: null }),
          all: async () => ({ results: [] }),
          run: async () => ({ success: true }),
        }),
      }),
      batch: async (stmts) => stmts.map(() => ({ results: [] })),
    };
    const res = await worker.fetch(
      req("/api/admin/people/aaron-bruns", {
        method: "GET",
        headers: { "X-Admin-Secret": "test-secret-xyz" },
      }),
      mockEnv({ DB: db }),
    );
    expect(res.status).toBe(200);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: "public /api/people/:id returns 404 for disabled record" FAILS (currently returns 200)

- [ ] **Step 3: Add `publicOnly` parameter to `handlePersonById`**

Change the function signature:

```javascript
async function handlePersonById(id, db, cors, { publicOnly = false } = {}) {
```

After fetching the person (line 241), add:

```javascript
  if (!person || (publicOnly && person.enabled === 0)) {
    return json({ error: "Not found" }, 404, cors);
  }
```

Remove the existing `if (!person)` check since the new one covers both cases.

Update the public route call:

```javascript
if (idMatch) {
  return await handlePersonById(idMatch[1], env.DB, corsHeaders, { publicOnly: true });
}
```

The admin route call stays as-is.

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add worker/index.js tests/worker.test.js
git commit -m "feat: hide disabled records from public person endpoint"
```

### Task 5: Filter stats by enabled

**Files:**
- Modify: `worker/index.js:260-289` (`handleStats`)

- [ ] **Step 1: Write failing test — stats exclude disabled records**

Add to the "Enabled column filtering" describe block:

```javascript
  it("stats exclude disabled records", async () => {
    const db = mockDB({
      batchResults: [
        [{ total: 5, convicted: 3, charged: 1, alleged: 1 }],
        [{ state: "TX" }, { state: "CA" }],
        [{ crime_type: "csam" }],
      ],
    });
    const res = await worker.fetch(req("/api/stats"), mockEnv({ DB: db }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(5);
    expect(body.states).toEqual(["TX", "CA"]);
    expect(body.crimeTypes).toEqual(["csam"]);
  });
```

- [ ] **Step 2: Run test to verify it passes (baseline)**

Run: `npm test`
Expected: Passes (baseline — we'll verify the SQL changes via code review)

- [ ] **Step 3: Add `enabled = 1` filter to all stats queries**

In `handleStats`, update the three queries:

```javascript
async function handleStats(db, cors) {
  const [totals, stateRows, crimeRows] = await db.batch([
    db.prepare(
      `SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'convicted' THEN 1 ELSE 0 END) as convicted,
        SUM(CASE WHEN status = 'charged' THEN 1 ELSE 0 END) as charged,
        SUM(CASE WHEN status = 'alleged' THEN 1 ELSE 0 END) as alleged
      FROM people WHERE enabled = 1`
    ),
    db.prepare("SELECT DISTINCT state FROM people WHERE enabled = 1 AND state IS NOT NULL ORDER BY state"),
    db.prepare("SELECT DISTINCT crime_type FROM crime_types WHERE person_id IN (SELECT id FROM people WHERE enabled = 1) ORDER BY crime_type"),
  ]);
```

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add worker/index.js tests/worker.test.js
git commit -m "feat: stats only count enabled records"
```

### Task 6: Add `enabled` to admin PATCH + formatPerson

**Files:**
- Modify: `worker/index.js:306-355` (`handleAdminUpdatePerson`)
- Modify: `worker/index.js:396-417` (`formatPerson`)

- [ ] **Step 1: Write failing test — PATCH enabled field**

Add to "Admin input validation" describe block:

```javascript
  it("rejects invalid enabled value", async () => {
    const res = await worker.fetch(
      patchReq({ enabled: "yes" }),
      mockEnv({ DB: personDB }),
    );
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error).toContain("Invalid enabled");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAILS — currently `enabled` is not validated, so it passes through or gets ignored

- [ ] **Step 3: Add `enabled` validation and to allowed fields**

In `handleAdminUpdatePerson`, add validation after the existing enum checks:

```javascript
  if (body.enabled !== undefined && ![0, 1, true, false].includes(body.enabled))
    return json({ error: "Invalid enabled value" }, 400, cors);
```

Add `"enabled"` to the `allowed` array:

```javascript
  const allowed = ["name", "status", "level", "state", "office", "summary", "crime_description", "offense_year", "conviction_year", "event_date", "still_in_office", "enabled"];
```

In the value mapping loop, add boolean-to-integer conversion for `enabled`. After the existing `if (val !== undefined)` block, before pushing to `vals`, convert booleans:

```javascript
  for (const key of allowed) {
    const jsKey = key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    const val = body[key] !== undefined ? body[key] : body[jsKey];
    if (val !== undefined) {
      sets.push(`${key} = ?`);
      // Convert booleans to integer for enabled column
      if (key === "enabled" && typeof val === "boolean") {
        vals.push(val ? 1 : 0);
      } else {
        vals.push(val === "" ? null : val);
      }
    }
  }
```

- [ ] **Step 4: Update `formatPerson` to include `enabled`**

In `formatPerson`, add the `enabled` field:

```javascript
function formatPerson(row, crimeTypesMap, sourcesMap) {
  const person = {
    id: row.id,
    name: row.name,
    status: row.status,
    level: row.level,
    state: row.state,
    office: row.office,
    summary: row.summary,
    stillInOffice: row.still_in_office === 1 ? true : row.still_in_office === 0 ? false : null,
    enabled: row.enabled === 1 ? true : row.enabled === 0 ? false : true,
    offenseYear: row.offense_year,
    convictionYear: row.conviction_year,
    eventDate: row.event_date || null,
    crimeTypes: crimeTypesMap[row.id] || [],
    sources: sourcesMap[row.id] || [],
  };
```

Note: `enabled` defaults to `true` when the column is not present in the row (backwards compatibility with tests using older mock data).

- [ ] **Step 5: Update formatPerson test to include `enabled`**

Update the first test in the "formatPerson" describe block to include `enabled: 1` in the row and `enabled: true` in the expected output.

- [ ] **Step 6: Run tests**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 7: Commit**

```bash
git add worker/index.js tests/worker.test.js
git commit -m "feat: admin can toggle enabled field, formatPerson includes enabled"
```

---

## Chunk 3: Migration + Verification

### Task 7: Run migrations on production and staging D1

**Files:** None (manual CLI commands)

- [ ] **Step 1: Run ALTER TABLE on production D1**

```bash
npx wrangler d1 execute onlyphiles --remote --command="ALTER TABLE people ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1;"
```

Expected: Success (all existing rows get `enabled = 1`)

- [ ] **Step 2: Run ALTER TABLE on staging D1**

```bash
npx wrangler d1 execute onlyphiles-staging --remote --command="ALTER TABLE people ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1;" --env=preview
```

Expected: Success

- [ ] **Step 3: Disable aaron-bruns**

```bash
npx wrangler d1 execute onlyphiles --remote --command="UPDATE people SET enabled = 0 WHERE id = 'aaron-bruns';"
```

Expected: Success — aaron-bruns hidden from public API

### Task 8: Final verification

- [ ] **Step 1: Run full test suite**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 2: Deploy and verify**

Push to `main` to trigger Workers Builds deployment. After deploy:
- Verify `GET /api/people` does not include aaron-bruns
- Verify `GET /api/people/aaron-bruns` returns 404
- Verify `GET /api/stats` total is reduced by 1
- Verify admin panel still shows aaron-bruns
