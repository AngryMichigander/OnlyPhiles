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

// ---------------------------------------------------------------------------
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

  it("includes orphan cleanup at end", () => {
    const fs = require("fs");
    const sql = fs.readFileSync("worker/seed.sql", "utf-8");
    expect(sql).toContain("-- Orphan cleanup");
    expect(sql).toContain("DELETE FROM people WHERE id NOT IN");
  });
});
