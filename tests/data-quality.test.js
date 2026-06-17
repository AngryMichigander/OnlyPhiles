import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Ratchet helper
// ---------------------------------------------------------------------------
const BASELINES_PATH = resolve(
  import.meta.dirname ?? new URL(".", import.meta.url).pathname,
  "data-quality.baselines.json",
);

let _baselines = null;
function getBaselines() {
  if (!_baselines) {
    _baselines = JSON.parse(readFileSync(BASELINES_PATH, "utf8"));
  }
  return _baselines;
}

function ratchet(baselineKey, currentCount) {
  const baselines = getBaselines();
  if (!(baselineKey in baselines)) {
    throw new Error(
      `Missing baseline: ${baselineKey}. Add it to tests/data-quality.baselines.json before this test can pass.`,
    );
  }
  const b = baselines[baselineKey];
  if (currentCount > b) {
    throw new Error(
      `${baselineKey}: current=${currentCount} baseline=${b} (regressed by ${currentCount - b})`,
    );
  }
  console.log(`${baselineKey}: current=${currentCount} baseline=${b}`);
}

// ---------------------------------------------------------------------------
// Load shared data once
// ---------------------------------------------------------------------------
const PEOPLE = JSON.parse(
  readFileSync(resolve(process.cwd(), "data/people.json"), "utf8"),
);

const appJs = readFileSync(resolve(process.cwd(), "public/app.js"), "utf8");

const crimeLabelsMatch = appJs.match(/const CRIME_LABELS = (\{[\s\S]*?\});/);
const CRIME_LABELS = new Set(
  Object.keys(eval("(" + crimeLabelsMatch[1] + ")")),
);

const usStatesMatch = appJs.match(/const US_STATES = (\[[\s\S]*?\]);/);
const US_STATES = new Set(eval(usStatesMatch[1]));
US_STATES.add("PR"); // documented exception

// Documented state exceptions (appear in data but are NOT valid US state codes)
const STATE_EXCEPTIONS = new Set([
  "NW",
  "EV",
  "MR",
  "US",
  "PH",
  "MX",
  "RU",
  "MF",
]);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("data quality invariants", () => {
  it("state whitelist — unknown states do not grow", () => {
    const unknownStates = PEOPLE.map((p) => p.state).filter(
      (s) => s && !US_STATES.has(s) && !STATE_EXCEPTIONS.has(s),
    );
    ratchet("unknownStates", unknownStates.length);
  });

  it("crime-type whitelist — all crimeTypes are in CRIME_LABELS", () => {
    const allTypes = new Set(PEOPLE.flatMap((p) => p.crimeTypes ?? []));
    const missing = [...allTypes].filter((t) => !CRIME_LABELS.has(t));
    expect(missing, `Unknown crimeTypes: ${missing.join(", ")}`).toHaveLength(0);
  });

  it("future eventDate — known count does not grow", () => {
    const today = new Date().toISOString().slice(0, 10);
    const future = PEOPLE.filter((p) => p.eventDate && p.eventDate > today);
    ratchet("futureDates", future.length);
  });

  it("year inversion — convictionYear never before offenseYear", () => {
    const inversions = PEOPLE.filter(
      (p) =>
        p.convictionYear != null &&
        p.offenseYear != null &&
        p.convictionYear < p.offenseYear,
    );
    expect(inversions.map((p) => p.id)).toHaveLength(0);
  });

  it("required fields — every entry has id, name, status, and at least one source", () => {
    const bad = PEOPLE.filter(
      (p) =>
        !p.id ||
        !p.name ||
        !p.status ||
        !Array.isArray(p.sources) ||
        p.sources.length === 0,
    );
    expect(bad.map((p) => p?.id ?? "(no id)")).toHaveLength(0);
  });

  it("status enum — only convicted/charged/alleged", () => {
    const VALID = new Set(["convicted", "charged", "alleged"]);
    const bad = PEOPLE.filter((p) => !VALID.has(p.status));
    expect(bad.map((p) => `${p.id}:${p.status}`)).toHaveLength(0);
  });

  it("level enum — only known level values or unset", () => {
    const VALID = new Set([
      "federal",
      "state",
      "local",
      "party-official",
      "adjacent",
    ]);
    const bad = PEOPLE.filter((p) => p.level && !VALID.has(p.level));
    expect(bad.map((p) => `${p.id}:${p.level}`)).toHaveLength(0);
  });

  it("source URL protocol — every URL is http or https", () => {
    const bad = [];
    for (const p of PEOPLE) {
      for (const url of p.sources ?? []) {
        try {
          const u = new URL(url);
          if (u.protocol !== "http:" && u.protocol !== "https:") {
            bad.push(`${p.id}:${url}`);
          }
        } catch {
          bad.push(`${p.id}:${url} (invalid URL)`);
        }
      }
    }
    expect(bad).toHaveLength(0);
  });

  it("unique id — no duplicate ids in dataset", () => {
    const counts = new Map();
    PEOPLE.forEach((p, i) => {
      if (!counts.has(p.id)) counts.set(p.id, []);
      counts.get(p.id).push(i);
    });
    const duplicates = [...counts.entries()]
      .filter(([, indices]) => indices.length > 1)
      .map(([id, indices]) => `id="${id}" at indices ${indices.join(",")}`);
    expect(duplicates, "Duplicate ids found").toHaveLength(0);
  });

  it("baselines file completeness — every ratchet key has a baseline entry", () => {
    const RATCHET_KEYS = ["unknownStates", "futureDates"];
    const baselines = getBaselines();
    const missing = RATCHET_KEYS.filter((k) => !(k in baselines));
    if (missing.length > 0) {
      throw new Error(`Missing baselines for: ${missing.join(", ")}`);
    }
    expect(missing).toHaveLength(0);
  });
});
