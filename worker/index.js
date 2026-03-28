/**
 * Cloudflare Worker — OnlyPhiles API
 * Backed by D1 database.
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    try {
      // Admin API routes — checked first for proper CORS preflight handling
      if (url.pathname.startsWith("/api/admin/")) {
        const adminOrigin = env.ADMIN_ORIGIN || "https://onlyphiles.com";
        const adminCors = {
          "Access-Control-Allow-Origin": adminOrigin,
          "Access-Control-Allow-Methods": "GET, PATCH, PUT, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Cf-Access-Jwt-Assertion, X-Admin-Secret",
          "Access-Control-Allow-Credentials": "true",
        };

        // Handle CORS preflight before auth check
        if (request.method === "OPTIONS") {
          return new Response(null, { status: 204, headers: adminCors });
        }

        // Authenticate: require CF Access JWT, CF Access cookie, or env-configured secret.
        // CF Access validates JWTs at the edge; the header/cookie are added post-validation.
        // No hardcoded fallback — env.ADMIN_SECRET must be set via `wrangler secret put`.
        const jwt = request.headers.get("Cf-Access-Jwt-Assertion");
        const secret = request.headers.get("X-Admin-Secret");
        const cookie = request.headers.get("Cookie") || "";
        const cfCookieMatch = cookie.match(/CF_Authorization=([^\s;]+)/);
        const cfToken = cfCookieMatch ? cfCookieMatch[1] : null;

        // Heuristic: valid JWTs Base64Url-encode to start with "ey".
        // This is NOT cryptographic validation — CF Access validates the JWT at the edge.
        const hasValidJwt = jwt && jwt.startsWith("ey");
        const hasValidCookie = cfToken && cfToken.startsWith("ey");
        const hasValidSecret = env.ADMIN_SECRET && secret === env.ADMIN_SECRET;

        if (!hasValidJwt && !hasValidCookie && !hasValidSecret) {
          return json({ error: "Unauthorized" }, 401, adminCors);
        }

        const adminSrcMatch = url.pathname.match(/^\/api\/admin\/people\/([^/]+)\/sources$/);
        const adminIdMatch = url.pathname.match(/^\/api\/admin\/people\/([^/]+)$/);
        if (adminSrcMatch && request.method === "PUT") {
          return await handleAdminUpdateSources(adminSrcMatch[1], request, env.DB, adminCors);
        }
        if (adminIdMatch && request.method === "PATCH") {
          return await handleAdminUpdatePerson(adminIdMatch[1], request, env.DB, adminCors);
        }
        if (adminIdMatch && request.method === "GET") {
          return await handlePersonById(adminIdMatch[1], env.DB, adminCors);
        }
        if (url.pathname === "/api/admin/people" && request.method === "GET") {
          return await handlePeopleList(url, env.DB, adminCors);
        }
        return json({ error: "Not found" }, 404, adminCors);
      }

      // Global CORS preflight for public endpoints
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders });
      }

      // Public API routes
      if (url.pathname === "/api/people") {
        return await handlePeopleList(url, env.DB, corsHeaders, { publicOnly: true });
      }

      if (url.pathname === "/api/stats") {
        return await handleStats(env.DB, corsHeaders);
      }

      const idMatch = url.pathname.match(/^\/api\/people\/([^/]+)$/);
      if (idMatch) {
        return await handlePersonById(idMatch[1], env.DB, corsHeaders, { publicOnly: true });
      }

      if (url.pathname === "/api/health") {
        return await handleHealth(env.DB, corsHeaders);
      }

      // Not an API route and no static asset matched — 404
      return json({ error: "Not found" }, 404, corsHeaders);
    } catch (err) {
      console.error("API error:", err);
      return json({ error: "Internal server error" }, 500, corsHeaders);
    }
  },
};

/** Parse a comma-separated filter param into an IN clause with bind vars. */
const FILTER_COLUMNS = new Set(["p.status", "p.level", "p.state"]);
function addInFilter(whereClauses, binds, column, param) {
  if (!param) return;
  if (!FILTER_COLUMNS.has(column)) throw new Error(`Invalid filter column: ${column}`);
  const vals = param.split(",").map((s) => s.trim()).filter(Boolean);
  if (vals.length) {
    whereClauses.push(`${column} IN (${vals.map(() => "?").join(",")})`);
    binds.push(...vals);
  }
}

function json(data, status = 200, corsHeaders = {}, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders, ...extraHeaders },
  });
}

// ---------------------------------------------------------------------------
// GET /api/people
// ---------------------------------------------------------------------------
async function handlePeopleList(url, db, cors, { publicOnly = false } = {}) {
  const params = url.searchParams;

  const q = (params.get("q") || "").slice(0, 200);
  const status = params.get("status") || "";
  const level = params.get("level") || "";
  const state = params.get("state") || "";
  const crimeType = params.get("crimeType") || "";
  const stillInOffice = params.get("stillInOffice");
  const sort = params.get("sort") || "name";
  const order = (params.get("order") || "asc").toUpperCase() === "DESC" ? "DESC" : "ASC";
  const page = Math.max(1, parseInt(params.get("page") || "1", 10));
  const limit = Math.min(200, Math.max(1, parseInt(params.get("limit") || "50", 10)));

  const whereClauses = [];
  const binds = [];

  // Hide disabled records from public API
  if (publicOnly) {
    whereClauses.push("p.enabled = 1");
  }

  // Full-text search across multiple columns
  if (q) {
    const like = `%${q}%`;
    whereClauses.push(
      "(p.name LIKE ? COLLATE NOCASE OR p.office LIKE ? COLLATE NOCASE OR p.crime_description LIKE ? COLLATE NOCASE OR p.summary LIKE ? COLLATE NOCASE)"
    );
    binds.push(like, like, like, like);
  }

  addInFilter(whereClauses, binds, "p.status", status);
  addInFilter(whereClauses, binds, "p.level", level);

  // State filter
  if (state) {
    whereClauses.push("p.state = ?");
    binds.push(state);
  }

  // Crime type filter — subquery on crime_types table
  if (crimeType) {
    const vals = crimeType.split(",").map((s) => s.trim()).filter(Boolean);
    if (vals.length) {
      whereClauses.push(
        `p.id IN (SELECT person_id FROM crime_types WHERE crime_type IN (${vals.map(() => "?").join(",")}))`
      );
      binds.push(...vals);
    }
  }

  // Still in office
  if (stillInOffice === "true") {
    whereClauses.push("p.still_in_office = 1");
  } else if (stillInOffice === "false") {
    whereClauses.push("p.still_in_office = 0");
  }

  const whereSQL = whereClauses.length ? "WHERE " + whereClauses.join(" AND ") : "";

  // Validate sort column
  const sortColumns = {
    name: "p.name",
    status: "p.status",
    state: "p.state",
    offense_year: "p.offense_year",
    conviction_year: "p.conviction_year",
  };
  const sortCol = sortColumns[sort] || "p.name";

  // Batch count + data queries in a single D1 round-trip
  const offset = (page - 1) * limit;
  const countSQL = `SELECT COUNT(*) as total FROM people p ${whereSQL}`;
  const listCols = "p.id, p.name, p.status, p.level, p.state, p.office, p.summary, p.still_in_office, p.offense_year, p.conviction_year, p.event_date, p.enabled";
  const dataSQL = `SELECT ${listCols} FROM people p ${whereSQL} ORDER BY ${sortCol} ${order} LIMIT ? OFFSET ?`;

  const [countResult, dataResult] = await db.batch([
    db.prepare(countSQL).bind(...binds),
    db.prepare(dataSQL).bind(...binds, limit, offset),
  ]);
  const total = countResult.results[0].total;
  const rows = dataResult.results;

  // Batch-fetch crime_types and sources in a single D1 round-trip
  const ids = rows.map((r) => r.id);
  let crimeTypesMap = {};
  let sourcesMap = {};

  if (ids.length) {
    const placeholders = ids.map(() => "?").join(",");

    const [ctResult, srcResult] = await db.batch([
      db.prepare(`SELECT person_id, crime_type FROM crime_types WHERE person_id IN (${placeholders})`).bind(...ids),
      db.prepare(`SELECT person_id, url FROM sources WHERE person_id IN (${placeholders})`).bind(...ids),
    ]);
    for (const row of ctResult.results) {
      if (!crimeTypesMap[row.person_id]) crimeTypesMap[row.person_id] = [];
      crimeTypesMap[row.person_id].push(row.crime_type);
    }
    for (const row of srcResult.results) {
      if (!sourcesMap[row.person_id]) sourcesMap[row.person_id] = [];
      sourcesMap[row.person_id].push(row.url);
    }
  }

  const results = rows.map((r) => formatPerson(r, crimeTypesMap, sourcesMap));

  return json(
    {
      total,
      page,
      limit,
      pages: Math.ceil(total / limit),
      results,
    },
    200,
    cors,
    { "Cache-Control": "public, max-age=300, s-maxage=3600, stale-while-revalidate=600" }
  );
}

// ---------------------------------------------------------------------------
// GET /api/people/:id
// ---------------------------------------------------------------------------
async function handlePersonById(id, db, cors, { publicOnly = false } = {}) {
  const person = await db.prepare("SELECT * FROM people WHERE id = ?").bind(id).first();
  if (!person || (publicOnly && person.enabled !== 1)) {
    return json({ error: "Not found" }, 404, cors);
  }

  const [ctResult, srcResult] = await db.batch([
    db.prepare("SELECT crime_type FROM crime_types WHERE person_id = ?").bind(id),
    db.prepare("SELECT url FROM sources WHERE person_id = ?").bind(id),
  ]);

  const crimeTypesMap = { [id]: ctResult.results.map((r) => r.crime_type) };
  const sourcesMap = { [id]: srcResult.results.map((r) => r.url) };

  return json(formatPerson(person, crimeTypesMap, sourcesMap), 200, cors, { "Cache-Control": "public, max-age=3600, s-maxage=86400, stale-while-revalidate=3600" });
}

// ---------------------------------------------------------------------------
// GET /api/stats
// ---------------------------------------------------------------------------
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

  const stats = totals.results[0];

  return json(
    {
      total: stats.total,
      convicted: stats.convicted,
      charged: stats.charged,
      alleged: stats.alleged,
      states: stateRows.results.map((r) => r.state),
      crimeTypes: crimeRows.results.map((r) => r.crime_type),
    },
    200,
    cors,
    { "Cache-Control": "public, max-age=3600, s-maxage=86400, stale-while-revalidate=3600" }
  );
}

// ---------------------------------------------------------------------------
// GET /api/health
// ---------------------------------------------------------------------------
async function handleHealth(db, cors) {
  try {
    await db.prepare("SELECT 1").first();
    return json({ status: "ok" }, 200, cors, { "Cache-Control": "no-store" });
  } catch {
    return json({ status: "error" }, 503, cors, { "Cache-Control": "no-store" });
  }
}

// ---------------------------------------------------------------------------
// PATCH /api/admin/people/:id
// ---------------------------------------------------------------------------
async function handleAdminUpdatePerson(id, request, db, cors) {
  const person = await db.prepare("SELECT id FROM people WHERE id = ?").bind(id).first();
  if (!person) return json({ error: "Not found" }, 404, cors);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400, cors);
  }

  // Validate enum and format constraints
  const VALID_STATUS = ["convicted", "charged", "alleged"];
  const VALID_LEVEL = ["federal", "state", "local", "party-official", "adjacent"];
  if (body.status && !VALID_STATUS.includes(body.status))
    return json({ error: "Invalid status" }, 400, cors);
  if (body.level && !VALID_LEVEL.includes(body.level))
    return json({ error: "Invalid level" }, 400, cors);
  if (body.state && !/^[A-Z]{2}$/.test(body.state))
    return json({ error: "Invalid state code" }, 400, cors);
  const eventDate = body.event_date !== undefined ? body.event_date : body.eventDate;
  if (eventDate && !/^\d{4}-\d{2}-\d{2}$/.test(eventDate))
    return json({ error: "Invalid event_date format (YYYY-MM-DD)" }, 400, cors);
  if (body.enabled !== undefined && ![0, 1, true, false].includes(body.enabled))
    return json({ error: "Invalid enabled value" }, 400, cors);

  const allowed = ["name", "status", "level", "state", "office", "summary", "crime_description", "offense_year", "conviction_year", "event_date", "still_in_office", "enabled"];
  const sets = [];
  const vals = [];

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

  if (!sets.length) return json({ error: "No valid fields to update" }, 400, cors);

  vals.push(id);
  await db.prepare(`UPDATE people SET ${sets.join(", ")} WHERE id = ?`).bind(...vals).run();

  const [updResult, ctRows, srcRows] = await db.batch([
    db.prepare("SELECT * FROM people WHERE id = ?").bind(id),
    db.prepare("SELECT crime_type FROM crime_types WHERE person_id = ?").bind(id),
    db.prepare("SELECT url FROM sources WHERE person_id = ?").bind(id),
  ]);
  const updated = updResult.results[0];
  return json(formatPerson(updated, { [id]: ctRows.results.map(r => r.crime_type) }, { [id]: srcRows.results.map(r => r.url) }), 200, cors, { "Cache-Control": "no-store" });
}

// ---------------------------------------------------------------------------
// PUT /api/admin/people/:id/sources — replace sources array
// ---------------------------------------------------------------------------
async function handleAdminUpdateSources(id, request, db, cors) {
  const person = await db.prepare("SELECT id FROM people WHERE id = ?").bind(id).first();
  if (!person) return json({ error: "Not found" }, 404, cors);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400, cors);
  }
  const sources = Array.isArray(body.sources) ? body.sources.filter(Boolean).slice(0, 20) : null;
  if (!sources) return json({ error: "sources must be an array" }, 400, cors);

  // Validate each source is a valid http(s) URL
  for (const url of sources) {
    try {
      const u = new URL(url);
      if (u.protocol !== "http:" && u.protocol !== "https:")
        return json({ error: "Source URLs must use http or https" }, 400, cors);
    } catch {
      return json({ error: "Invalid source URL" }, 400, cors);
    }
  }

  const stmts = [db.prepare("DELETE FROM sources WHERE person_id = ?").bind(id)];
  for (const url of sources) {
    stmts.push(db.prepare("INSERT INTO sources (person_id, url) VALUES (?, ?)").bind(id, url));
  }
  await db.batch(stmts);

  return json({ id, sources }, 200, cors, { "Cache-Control": "no-store" });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
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
  // Only include crimeDescription when available (single-person endpoint)
  if (row.crime_description !== undefined) {
    person.crimeDescription = row.crime_description;
  }
  return person;
}

// Named exports for testing
export { formatPerson, json, addInFilter };
