import { describe, it, expect } from "vitest";
import worker, { formatPerson, addInFilter } from "../worker/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function req(path, opts = {}) {
  return new Request(`https://onlyphiles.com${path}`, opts);
}

function mockDB(opts = {}) {
  const firstResult = opts.first ?? null;
  const allResult = opts.all ?? [];
  const stmtMethods = {
    first: async () => firstResult,
    all: async () => ({ results: allResult }),
    run: async () => ({ success: true }),
  };
  return {
    prepare: () => ({
      ...stmtMethods,
      bind: (..._args) => ({ ...stmtMethods }),
    }),
    batch: async (stmts) => {
      const br = opts.batchResults ?? [];
      return stmts.map((_, i) => ({ results: br[i] ?? allResult }));
    },
  };
}

function mockEnv(overrides = {}) {
  return {
    DB: mockDB(),
    ADMIN_SECRET: "test-secret-xyz",
    ADMIN_ORIGIN: "https://onlyphiles.com",
    ...overrides,
  };
}

const adminHeaders = {
  "X-Admin-Secret": "test-secret-xyz",
  "Content-Type": "application/json",
};

// ---------------------------------------------------------------------------
// formatPerson
// ---------------------------------------------------------------------------
describe("formatPerson", () => {
  it("maps snake_case DB row to camelCase API format", () => {
    const row = {
      id: "john-doe",
      name: "John Doe",
      status: "convicted",
      level: "federal",
      state: "TX",
      office: "Senator",
      summary: "Summary text",
      still_in_office: 1,
      offense_year: 2020,
      conviction_year: 2021,
      event_date: "2020-06-15",
      enabled: 1,
    };
    const result = formatPerson(
      row,
      { "john-doe": ["csam", "assault"] },
      { "john-doe": ["https://example.com"] },
    );

    expect(result).toEqual({
      id: "john-doe",
      name: "John Doe",
      status: "convicted",
      level: "federal",
      state: "TX",
      office: "Senator",
      summary: "Summary text",
      stillInOffice: true,
      enabled: true,
      offenseYear: 2020,
      convictionYear: 2021,
      eventDate: "2020-06-15",
      crimeTypes: ["csam", "assault"],
      sources: ["https://example.com"],
    });
  });

  it("maps still_in_office = 0 to false", () => {
    const result = formatPerson(
      { id: "a", name: "A", status: "alleged", still_in_office: 0 },
      {},
      {},
    );
    expect(result.stillInOffice).toBe(false);
  });

  it("maps still_in_office = null to null", () => {
    const result = formatPerson(
      { id: "a", name: "A", status: "alleged", still_in_office: null },
      {},
      {},
    );
    expect(result.stillInOffice).toBeNull();
  });

  it("returns empty arrays when no crime types or sources", () => {
    const result = formatPerson(
      { id: "a", name: "A", status: "alleged" },
      {},
      {},
    );
    expect(result.crimeTypes).toEqual([]);
    expect(result.sources).toEqual([]);
  });

  it("includes crimeDescription only when crime_description is defined", () => {
    const withDesc = formatPerson(
      { id: "a", name: "A", status: "alleged", crime_description: "Desc" },
      {},
      {},
    );
    expect(withDesc.crimeDescription).toBe("Desc");

    const without = formatPerson(
      { id: "b", name: "B", status: "alleged" },
      {},
      {},
    );
    expect(without).not.toHaveProperty("crimeDescription");
  });

  it("returns null for missing event_date", () => {
    const result = formatPerson(
      { id: "a", name: "A", status: "alleged" },
      {},
      {},
    );
    expect(result.eventDate).toBeNull();
  });

  it("includes lastReviewedAt and flaggedReason when includeReviewFields=true", () => {
    const result = formatPerson(
      {
        id: "a",
        name: "A",
        status: "alleged",
        last_reviewed_at: "2026-06-18T12:34:56Z",
        flagged_reason: "[P0] convicted-no-conviction-year",
      },
      {},
      {},
      { includeReviewFields: true },
    );
    expect(result.lastReviewedAt).toBe("2026-06-18T12:34:56Z");
    expect(result.flaggedReason).toBe("[P0] convicted-no-conviction-year");
  });

  it("omits lastReviewedAt and flaggedReason by default", () => {
    const result = formatPerson(
      {
        id: "a",
        name: "A",
        status: "alleged",
        last_reviewed_at: "2026-06-18T12:34:56Z",
        flagged_reason: "[P0] flag",
      },
      {},
      {},
    );
    expect(result).not.toHaveProperty("lastReviewedAt");
    expect(result).not.toHaveProperty("flaggedReason");
  });

  it("normalizes null/empty review fields to null when includeReviewFields=true", () => {
    const result = formatPerson(
      { id: "a", name: "A", status: "alleged", last_reviewed_at: null, flagged_reason: "" },
      {},
      {},
      { includeReviewFields: true },
    );
    expect(result.lastReviewedAt).toBeNull();
    expect(result.flaggedReason).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// addInFilter
// ---------------------------------------------------------------------------
describe("addInFilter", () => {
  it("adds IN clause for comma-separated values", () => {
    const where = [];
    const binds = [];
    addInFilter(where, binds, "p.status", "convicted,charged");
    expect(where).toEqual(["p.status IN (?,?)"]);
    expect(binds).toEqual(["convicted", "charged"]);
  });

  it("trims whitespace from values", () => {
    const where = [];
    const binds = [];
    addInFilter(where, binds, "p.level", " federal , state ");
    expect(binds).toEqual(["federal", "state"]);
  });

  it("filters out empty values", () => {
    const where = [];
    const binds = [];
    addInFilter(where, binds, "p.status", "convicted,,charged,");
    expect(binds).toEqual(["convicted", "charged"]);
  });

  it("does nothing for empty string", () => {
    const where = [];
    const binds = [];
    addInFilter(where, binds, "p.status", "");
    expect(where).toEqual([]);
    expect(binds).toEqual([]);
  });

  it("does nothing for null/undefined", () => {
    const where = [];
    const binds = [];
    addInFilter(where, binds, "p.status", null);
    expect(where).toEqual([]);
    addInFilter(where, binds, "p.status", undefined);
    expect(where).toEqual([]);
  });

  it("throws for invalid column name", () => {
    expect(() => addInFilter([], [], "user_input", "val")).toThrow(
      "Invalid filter column",
    );
  });

  it("handles single value", () => {
    const where = [];
    const binds = [];
    addInFilter(where, binds, "p.status", "convicted");
    expect(where).toEqual(["p.status IN (?)"]);
    expect(binds).toEqual(["convicted"]);
  });
});

// ---------------------------------------------------------------------------
// Routing & CORS
// ---------------------------------------------------------------------------
describe("Worker routing", () => {
  it("returns 204 for OPTIONS on public routes", async () => {
    const res = await worker.fetch(
      req("/api/people", { method: "OPTIONS" }),
      mockEnv(),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Access-Control-Allow-Methods")).toBe(
      "GET, OPTIONS",
    );
  });

  it("returns 204 for OPTIONS on admin routes with admin CORS", async () => {
    const res = await worker.fetch(
      req("/api/admin/people", { method: "OPTIONS" }),
      mockEnv(),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://onlyphiles.com",
    );
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("PATCH");
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBe("true");
  });

  it("returns health check response", async () => {
    const db = mockDB({ first: { 1: 1 } });
    const res = await worker.fetch(req("/api/health"), mockEnv({ DB: db }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.status).toBe("ok");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("returns JSON 404 with CORS headers for non-API routes", async () => {
    const res = await worker.fetch(req("/nonexistent"), mockEnv());
    const body = await res.json();
    expect(res.status).toBe(404);
    expect(body.error).toBe("Not found");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("returns 404 for unknown admin routes", async () => {
    const res = await worker.fetch(
      req("/api/admin/unknown", {
        method: "GET",
        headers: { "X-Admin-Secret": "test-secret-xyz" },
      }),
      mockEnv(),
    );
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Admin authentication
// ---------------------------------------------------------------------------
describe("Admin authentication", () => {
  it("rejects requests without any credentials", async () => {
    const res = await worker.fetch(
      req("/api/admin/people", { method: "GET" }),
      mockEnv(),
    );
    expect(res.status).toBe(401);
  });

  it("accepts valid CF Access JWT (starts with ey)", async () => {
    const db = mockDB({
      batchResults: [[{ total: 0 }], []],
    });
    const res = await worker.fetch(
      req("/api/admin/people", {
        method: "GET",
        headers: { "Cf-Access-Jwt-Assertion": "eyJhbGciOiJSUzI1NiJ9.test" },
      }),
      mockEnv({ DB: db }),
    );
    expect(res.status).toBe(200);
  });

  it("accepts valid CF_Authorization cookie (JWT format)", async () => {
    const db = mockDB({
      batchResults: [[{ total: 0 }], []],
    });
    const res = await worker.fetch(
      req("/api/admin/people", {
        method: "GET",
        headers: {
          Cookie: "CF_Authorization=eyJhbGciOiJSUzI1NiJ9.test; other=val",
        },
      }),
      mockEnv({ DB: db }),
    );
    expect(res.status).toBe(200);
  });

  it("accepts valid admin secret header", async () => {
    const db = mockDB({
      batchResults: [[{ total: 0 }], []],
    });
    const res = await worker.fetch(
      req("/api/admin/people", {
        method: "GET",
        headers: { "X-Admin-Secret": "test-secret-xyz" },
      }),
      mockEnv({ DB: db }),
    );
    expect(res.status).toBe(200);
  });

  it("rejects wrong admin secret", async () => {
    const res = await worker.fetch(
      req("/api/admin/people", {
        method: "GET",
        headers: { "X-Admin-Secret": "wrong-secret" },
      }),
      mockEnv(),
    );
    expect(res.status).toBe(401);
  });

  it("rejects JWT that does not start with ey", async () => {
    const res = await worker.fetch(
      req("/api/admin/people", {
        method: "GET",
        headers: { "Cf-Access-Jwt-Assertion": "not-a-jwt" },
      }),
      mockEnv(),
    );
    expect(res.status).toBe(401);
  });

  it("rejects cookie with non-JWT value", async () => {
    const res = await worker.fetch(
      req("/api/admin/people", {
        method: "GET",
        headers: { Cookie: "CF_Authorization=not-a-jwt" },
      }),
      mockEnv(),
    );
    expect(res.status).toBe(401);
  });

  it("rejects when ADMIN_SECRET env is not set", async () => {
    const res = await worker.fetch(
      req("/api/admin/people", {
        method: "GET",
        headers: { "X-Admin-Secret": "any-value" },
      }),
      mockEnv({ ADMIN_SECRET: undefined }),
    );
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Admin input validation
// ---------------------------------------------------------------------------
describe("Admin input validation", () => {
  const personDB = mockDB({ first: { id: "test-person" } });

  function patchReq(body) {
    return req("/api/admin/people/test-person", {
      method: "PATCH",
      headers: adminHeaders,
      body: JSON.stringify(body),
    });
  }

  it("rejects invalid status value", async () => {
    const res = await worker.fetch(
      patchReq({ status: "invalid" }),
      mockEnv({ DB: personDB }),
    );
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error).toContain("Invalid status");
  });

  it("rejects invalid level value", async () => {
    const res = await worker.fetch(
      patchReq({ level: "invalid" }),
      mockEnv({ DB: personDB }),
    );
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error).toContain("Invalid level");
  });

  it("rejects invalid state code", async () => {
    const res = await worker.fetch(
      patchReq({ state: "INVALID" }),
      mockEnv({ DB: personDB }),
    );
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error).toContain("Invalid state");
  });

  it("rejects invalid event_date format", async () => {
    const res = await worker.fetch(
      patchReq({ event_date: "not-a-date" }),
      mockEnv({ DB: personDB }),
    );
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error).toContain("event_date");
  });

  it("accepts valid enum values and date format", async () => {
    const db = {
      prepare: () => ({
        bind: () => ({
          first: async () => ({
            id: "test-person",
            name: "Test",
            status: "convicted",
            still_in_office: null,
          }),
          all: async () => ({ results: [] }),
          run: async () => ({ success: true }),
        }),
      }),
      batch: async (stmts) =>
        stmts.map(() => ({
          results: [
            {
              id: "test-person",
              name: "Test",
              status: "convicted",
              still_in_office: null,
            },
          ],
        })),
    };
    const res = await worker.fetch(
      patchReq({
        status: "convicted",
        level: "federal",
        state: "TX",
        event_date: "2020-06-15",
      }),
      mockEnv({ DB: db }),
    );
    expect(res.status).toBe(200);
  });

  it("rejects invalid JSON body on PATCH", async () => {
    const res = await worker.fetch(
      req("/api/admin/people/test-person", {
        method: "PATCH",
        headers: adminHeaders,
        body: "not json",
      }),
      mockEnv({ DB: personDB }),
    );
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error).toContain("Invalid JSON");
  });

  it("returns 404 for non-existent person", async () => {
    const emptyDB = mockDB({ first: null });
    const res = await worker.fetch(
      patchReq({ status: "convicted" }),
      mockEnv({ DB: emptyDB }),
    );
    expect(res.status).toBe(404);
  });

  it("rejects non-http(s) source URLs", async () => {
    const res = await worker.fetch(
      req("/api/admin/people/test-person/sources", {
        method: "PUT",
        headers: adminHeaders,
        body: JSON.stringify({ sources: ["javascript:alert(1)"] }),
      }),
      mockEnv({ DB: personDB }),
    );
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error).toContain("http or https");
  });

  it("rejects invalid source URLs", async () => {
    const res = await worker.fetch(
      req("/api/admin/people/test-person/sources", {
        method: "PUT",
        headers: adminHeaders,
        body: JSON.stringify({ sources: ["not a url at all"] }),
      }),
      mockEnv({ DB: personDB }),
    );
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error).toContain("Invalid source URL");
  });

  it("rejects invalid JSON body on PUT sources", async () => {
    const res = await worker.fetch(
      req("/api/admin/people/test-person/sources", {
        method: "PUT",
        headers: adminHeaders,
        body: "not json",
      }),
      mockEnv({ DB: personDB }),
    );
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error).toContain("Invalid JSON");
  });

  it("rejects sources that is not an array", async () => {
    const res = await worker.fetch(
      req("/api/admin/people/test-person/sources", {
        method: "PUT",
        headers: adminHeaders,
        body: JSON.stringify({ sources: "not-array" }),
      }),
      mockEnv({ DB: personDB }),
    );
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error).toContain("sources must be an array");
  });

  it("rejects invalid enabled value", async () => {
    const res = await worker.fetch(
      patchReq({ enabled: "yes" }),
      mockEnv({ DB: personDB }),
    );
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error).toContain("Invalid enabled");
  });

  it("rejects invalid last_reviewed_at format", async () => {
    const res = await worker.fetch(
      patchReq({ last_reviewed_at: "yesterday" }),
      mockEnv({ DB: personDB }),
    );
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error).toContain("last_reviewed_at");
  });

  it("rejects non-string flagged_reason", async () => {
    const res = await worker.fetch(
      patchReq({ flagged_reason: 12345 }),
      mockEnv({ DB: personDB }),
    );
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error).toContain("flagged_reason");
  });

  it("rejects flagged_reason over 1000 chars", async () => {
    const res = await worker.fetch(
      patchReq({ flagged_reason: "x".repeat(1001) }),
      mockEnv({ DB: personDB }),
    );
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error).toContain("flagged_reason");
  });

  it("accepts valid ISO 8601 last_reviewed_at and string flagged_reason", async () => {
    const db = {
      prepare: () => ({
        bind: () => ({
          first: async () => ({ id: "test-person", name: "Test", status: "alleged", still_in_office: null, enabled: 1 }),
          all: async () => ({ results: [] }),
          run: async () => ({ success: true }),
        }),
      }),
      batch: async (stmts) => stmts.map(() => ({
        results: [{ id: "test-person", name: "Test", status: "alleged", still_in_office: null, enabled: 1 }],
      })),
    };
    const res = await worker.fetch(
      patchReq({ last_reviewed_at: "2026-06-18T12:34:56.789Z", flagged_reason: "[P0] needs verification" }),
      mockEnv({ DB: db }),
    );
    expect(res.status).toBe(200);
  });

  it("accepts null flagged_reason (clears the flag)", async () => {
    const db = {
      prepare: () => ({
        bind: () => ({
          first: async () => ({ id: "test-person", name: "Test", status: "alleged", still_in_office: null, enabled: 1 }),
          all: async () => ({ results: [] }),
          run: async () => ({ success: true }),
        }),
      }),
      batch: async (stmts) => stmts.map(() => ({
        results: [{ id: "test-person", name: "Test", status: "alleged", still_in_office: null, enabled: 1 }],
      })),
    };
    const res = await worker.fetch(
      patchReq({ flagged_reason: null }),
      mockEnv({ DB: db }),
    );
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Enabled column filtering
// ---------------------------------------------------------------------------
describe("Enabled column filtering", () => {
  it("public /api/people excludes disabled records", async () => {
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
});

// Review fields auto-stamp behavior
describe("Review fields auto-stamp", () => {
  function spyDB(initialPerson) {
    const captured = { sqls: [], binds: [] };
    const stmtMethods = {
      first: async () => initialPerson,
      all: async () => ({ results: [] }),
      run: async () => ({ success: true }),
    };
    return {
      _captured: captured,
      prepare: (sql) => {
        captured.sqls.push(sql);
        return {
          ...stmtMethods,
          bind: (...args) => {
            captured.binds.push({ sql, args });
            return stmtMethods;
          },
        };
      },
      batch: async (stmts) => stmts.map(() => ({
        results: [{ id: "test-person", name: "Test", status: "alleged", still_in_office: null, enabled: 1 }],
      })),
    };
  }

  function patchReq(body) {
    return req("/api/admin/people/test-person", {
      method: "PATCH",
      headers: adminHeaders,
      body: JSON.stringify(body),
    });
  }

  it("auto-stamps last_reviewed_at when body does not include it", async () => {
    const db = spyDB({ id: "test-person" });
    const res = await worker.fetch(patchReq({ name: "Updated" }), mockEnv({ DB: db }));
    expect(res.status).toBe(200);
    const updateBind = db._captured.binds.find(b => b.sql.startsWith("UPDATE people"));
    expect(updateBind.sql).toContain("last_reviewed_at = ?");
    const hasIso = updateBind.args.some(
      a => typeof a === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(a),
    );
    expect(hasIso).toBe(true);
  });

  it("respects explicit last_reviewed_at when provided in body", async () => {
    const db = spyDB({ id: "test-person" });
    const explicitTs = "2025-01-15T00:00:00.000Z";
    const res = await worker.fetch(
      patchReq({ last_reviewed_at: explicitTs }),
      mockEnv({ DB: db }),
    );
    expect(res.status).toBe(200);
    const updateBind = db._captured.binds.find(b => b.sql.startsWith("UPDATE people"));
    expect(updateBind.args).toContain(explicitTs);
    const lraCount = (updateBind.sql.match(/last_reviewed_at = \?/g) || []).length;
    expect(lraCount).toBe(1);
  });

  it("respects explicit null last_reviewed_at (mark unreviewed)", async () => {
    const db = spyDB({ id: "test-person" });
    const res = await worker.fetch(
      patchReq({ last_reviewed_at: null }),
      mockEnv({ DB: db }),
    );
    expect(res.status).toBe(200);
    const updateBind = db._captured.binds.find(b => b.sql.startsWith("UPDATE people"));
    expect(updateBind.sql).toContain("last_reviewed_at = ?");
    expect(updateBind.args).toContain(null);
    const lraCount = (updateBind.sql.match(/last_reviewed_at = \?/g) || []).length;
    expect(lraCount).toBe(1);
  });

  it("auto-stamps even on empty PATCH body (mark-as-reviewed shortcut)", async () => {
    const db = spyDB({ id: "test-person" });
    const res = await worker.fetch(patchReq({}), mockEnv({ DB: db }));
    expect(res.status).toBe(200);
    const updateBind = db._captured.binds.find(b => b.sql.startsWith("UPDATE people"));
    expect(updateBind.sql).toBe("UPDATE people SET last_reviewed_at = ? WHERE id = ?");
  });

  it("accepts camelCase lastReviewedAt key (matches existing snake/camel handling)", async () => {
    const db = spyDB({ id: "test-person" });
    const explicitTs = "2025-03-01T00:00:00.000Z";
    const res = await worker.fetch(
      patchReq({ lastReviewedAt: explicitTs }),
      mockEnv({ DB: db }),
    );
    expect(res.status).toBe(200);
    const updateBind = db._captured.binds.find(b => b.sql.startsWith("UPDATE people"));
    expect(updateBind.args).toContain(explicitTs);
  });
});

// Admin list filters
describe("Admin list filters", () => {
  function spyListDB(opts = {}) {
    const captured = { sqls: [], binds: [] };
    const stmtMethods = {
      first: async () => null,
      all: async () => ({ results: [] }),
      run: async () => ({ success: true }),
    };
    return {
      _captured: captured,
      prepare: (sql) => ({
        ...stmtMethods,
        bind: (...args) => {
          captured.binds.push({ sql, args });
          return stmtMethods;
        },
      }),
      batch: async (stmts) => stmts.map((_, i) =>
        opts.batchResults?.[i] ?? (i === 0 ? { results: [{ total: 0 }] } : { results: [] })
      ),
    };
  }

  it("flaggedOnly=1 adds flagged_reason IS NOT NULL clause", async () => {
    const db = spyListDB();
    const res = await worker.fetch(
      req("/api/admin/people?flaggedOnly=1", {
        method: "GET",
        headers: { "X-Admin-Secret": "test-secret-xyz" },
      }),
      mockEnv({ DB: db }),
    );
    expect(res.status).toBe(200);
    const selectBind = db._captured.binds.find(b => b.sql.startsWith("SELECT"));
    expect(selectBind.sql).toContain("flagged_reason IS NOT NULL");
  });

  it("unreviewedOnly=1 adds last_reviewed_at IS NULL clause", async () => {
    const db = spyListDB();
    const res = await worker.fetch(
      req("/api/admin/people?unreviewedOnly=1", {
        method: "GET",
        headers: { "X-Admin-Secret": "test-secret-xyz" },
      }),
      mockEnv({ DB: db }),
    );
    expect(res.status).toBe(200);
    const selectBind = db._captured.binds.find(b => b.sql.startsWith("SELECT"));
    expect(selectBind.sql).toContain("last_reviewed_at IS NULL");
  });

  it("hiddenOnly=1 adds enabled = 0 clause", async () => {
    const db = spyListDB();
    const res = await worker.fetch(
      req("/api/admin/people?hiddenOnly=1", {
        method: "GET",
        headers: { "X-Admin-Secret": "test-secret-xyz" },
      }),
      mockEnv({ DB: db }),
    );
    expect(res.status).toBe(200);
    const selectBind = db._captured.binds.find(b => b.sql.startsWith("SELECT"));
    expect(selectBind.sql).toContain("p.enabled = 0");
  });

  it("public /api/people ignores admin filter params (security)", async () => {
    const db = spyListDB();
    const res = await worker.fetch(
      req("/api/people?flaggedOnly=1&unreviewedOnly=1&hiddenOnly=1"),
      mockEnv({ DB: db }),
    );
    expect(res.status).toBe(200);
    const selectBind = db._captured.binds.find(b => b.sql.startsWith("SELECT"));
    expect(selectBind.sql).toContain("p.enabled = 1");
    expect(selectBind.sql).not.toContain("flagged_reason IS NOT NULL");
    expect(selectBind.sql).not.toContain("last_reviewed_at IS NULL");
    expect(selectBind.sql).not.toContain("p.enabled = 0");
  });

  it("admin list SELECT includes last_reviewed_at and flagged_reason columns", async () => {
    const db = spyListDB();
    const res = await worker.fetch(
      req("/api/admin/people", {
        method: "GET",
        headers: { "X-Admin-Secret": "test-secret-xyz" },
      }),
      mockEnv({ DB: db }),
    );
    expect(res.status).toBe(200);
    const dataSelectBind = db._captured.binds.find(b => /^SELECT p\.id/.test(b.sql));
    expect(dataSelectBind.sql).toContain("p.last_reviewed_at");
    expect(dataSelectBind.sql).toContain("p.flagged_reason");
  });

  it("admin list response includes lastReviewedAt and flaggedReason fields", async () => {
    const db = spyListDB({
      batchResults: [
        { results: [{ total: 1 }] },
        { results: [{ id: "a", name: "A", status: "alleged", enabled: 1, still_in_office: null, last_reviewed_at: "2026-06-18T00:00:00Z", flagged_reason: "[P0] test" }] },
        { results: [] },
        { results: [] },
      ],
    });
    const res = await worker.fetch(
      req("/api/admin/people", {
        method: "GET",
        headers: { "X-Admin-Secret": "test-secret-xyz" },
      }),
      mockEnv({ DB: db }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results[0].lastReviewedAt).toBe("2026-06-18T00:00:00Z");
    expect(body.results[0].flaggedReason).toBe("[P0] test");
  });

  it("public list response strips lastReviewedAt and flaggedReason fields", async () => {
    const db = spyListDB({
      batchResults: [
        { results: [{ total: 1 }] },
        { results: [{ id: "a", name: "A", status: "alleged", enabled: 1, still_in_office: null, last_reviewed_at: "2026-06-18T00:00:00Z", flagged_reason: "[P0] test" }] },
        { results: [] },
        { results: [] },
      ],
    });
    const res = await worker.fetch(req("/api/people"), mockEnv({ DB: db }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results[0]).not.toHaveProperty("lastReviewedAt");
    expect(body.results[0]).not.toHaveProperty("flaggedReason");
  });
});

// seed-d1.js
// ---------------------------------------------------------------------------
describe("seed-d1.js", () => {
  it("generates ON CONFLICT upsert syntax", () => {
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
    expect(sql).not.toContain("enabled = excluded.enabled");
  });

  it("does not include last_reviewed_at or flagged_reason in the upsert SET clause", () => {
    const fs = require("fs");
    const sql = fs.readFileSync("worker/seed.sql", "utf-8");
    expect(sql).not.toContain("last_reviewed_at = excluded.last_reviewed_at");
    expect(sql).not.toContain("flagged_reason = excluded.flagged_reason");
  });

  it("includes orphan cleanup at end", () => {
    const fs = require("fs");
    const sql = fs.readFileSync("worker/seed.sql", "utf-8");
    expect(sql).toContain("-- Orphan cleanup");
    expect(sql).toContain("DELETE FROM people WHERE id NOT IN");
  });
});
