#!/usr/bin/env node
// audit-flag-list.mjs — Phase 1 data-freshness audit (Task T2 / Wave 1).
//
// Reads data/people.json (read-only), applies the P0–P3 severity rubric
// (first-match-wins) plus a 14-code reason taxonomy, and emits two CSVs
// under .omo/research/ via atomic .tmp → rename in the same directory:
//
//   flagged-entries.csv          — UTF-8, no BOM, RFC-4180 escaping
//   flagged-entries.utf8-sig.csv — UTF-8 with 0xEF 0xBB 0xBF BOM (Excel)
//
// Tone gate: any notes cell containing a banned word is treated as a
// non-recoverable bug — the script crashes before any file is written.
// Sort order is locale-independent for idempotency (en-US).

import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";

// ───────────── CLI ─────────────
const args = process.argv.slice(2);
let peopleFile = "data/people.json";
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--people-file") {
    if (i + 1 >= args.length) {
      console.error("Error: --people-file requires a path argument");
      process.exit(1);
    }
    peopleFile = args[++i];
  } else if (args[i] === "--help" || args[i] === "-h") {
    process.stdout.write(
      "Usage: audit-flag-list.mjs [--people-file <path>]\n",
    );
    process.exit(0);
  } else {
    console.error(`Error: unknown argument '${args[i]}'`);
    process.exit(1);
  }
}

// ───────────── Allowlists ─────────────
// Keep in sync with public/app.js CRIME_LABELS (17 keys) and US_STATES (50+DC).
const CRIME_LABEL_KEYS = new Set([
  "csam",
  "child-molestation",
  "statutory-rape",
  "assault",
  "rape",
  "trafficking",
  "solicitation",
  "grooming",
  "indecent-exposure",
  "incest",
  "stalking",
  "harassment",
  "domestic-violence",
  "murder",
  "organizational-coverup",
  "enablement",
  "other",
]);

const US_STATES = new Set([
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DC", "DE", "FL", "GA", "HI", "ID",
  "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO",
  "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA",
  "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY",
]);

const OFFICE_REGEX =
  /senator|representative|congressman|congresswoman|congress\b|attorney general|governor|cabinet|secretary of|speaker|justice|judge|sheriff|mayor|district attorney/i;

const KNOWN_HIGH_PROFILE_NAMES = new Set([
  "pam-bondi", "steve-bannon", "jim-jordan", "peter-thiel", "j-d-vance",
  "elon-musk", "ken-paxton", "matt-gaetz", "lauren-boebert", "dan-crenshaw",
  "ronny-jackson", "brett-favre", "mitch-mcconnell", "ron-johnson",
  "james-lankford", "ted-nugent", "james-woods", "tucker-carlson",
  "sean-hannity", "kimberly-guilfoyle", "rudy-giuliani", "michael-cohen",
  "dinesh-d-souza", "alex-jones", "steven-crowder", "linda-mcmahon",
  "betsy-devos", "greg-abbott", "arnold-schwarzenegger", "clarence-thomas",
  "brett-kavanaugh", "alexander-acosta", "stewart-rhodes", "george-h-w-bush",
  "mel-gibson", "kevin-spacey-na", "donald-trump",
]);

const P3_LEVELS = new Set(["federal", "state", "local", "party-official"]);
const ENABLEMENT_TYPES = new Set(["enablement", "organizational-coverup"]);
const TONE_REGEX = /\b(guilty|innocent|liable|perjury|criminal|pedophile|rapist)\b/i;

const CURRENT_YEAR = new Date().getUTCFullYear();

// ───────────── Helpers ─────────────
function isFiniteNumber(n) {
  return typeof n === "number" && Number.isFinite(n);
}

function eventYear(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  const d = new Date(value);
  const t = d.getTime();
  if (!Number.isFinite(t)) return null;
  return d.getUTCFullYear();
}

function csvEscape(val) {
  const s = String(val ?? "").normalize("NFC");
  if (/[,"\r\n]/.test(s)) {
    return '"' + s.replace(/\r\n/g, "\n").replace(/"/g, '""') + '"';
  }
  return s;
}

async function atomicWrite(destPath, content) {
  // CRITICAL: .tmp MUST be in the SAME directory as destination so rename(2)
  // is atomic on the same filesystem. Never use os.tmpdir().
  const tmp = destPath + ".tmp";
  await mkdir(dirname(destPath), { recursive: true });
  await writeFile(tmp, content);
  await rename(tmp, destPath);
}

// ───────────── Classification ─────────────
//
// Reason codes accumulate independently (semicolon-joined in the CSV).
// Severity is first-match-wins on P0 → P1 → P2 → P3.
function classify(entry) {
  const reasons = new Set();
  const status = entry.status;
  const level = entry.level;
  const office = typeof entry.office === "string" ? entry.office : "";
  const summary = typeof entry.summary === "string" ? entry.summary : "";
  const crimeTypes = Array.isArray(entry.crimeTypes) ? entry.crimeTypes : [];
  const sources = Array.isArray(entry.sources) ? entry.sources : [];

  // General reason codes (independent of severity bucket).
  const convictedNoYear =
    status === "convicted" && entry.convictionYear == null;
  if (convictedNoYear) reasons.add("convicted-no-conviction-year");

  const evtYear = eventYear(entry.eventDate);
  if (status === "charged" && evtYear != null && evtYear <= 2020) {
    reasons.add("charged-too-old");
  }
  if (status === "alleged" && evtYear != null && evtYear <= 2020) {
    reasons.add("alleged-too-old");
  }
  if (evtYear != null && evtYear > CURRENT_YEAR) {
    reasons.add("future-event-date");
  }

  if (
    sources.length >= 1 &&
    sources.every(
      (s) => typeof s === "string" && s.includes("goppredators.wordpress.com"),
    )
  ) {
    reasons.add("sole-source-goppredators");
  }
  if (sources.length === 1) reasons.add("single-source");

  if (
    typeof entry.state === "string" &&
    entry.state.length > 0 &&
    !US_STATES.has(entry.state)
  ) {
    reasons.add("state-out-of-whitelist");
  }

  if (
    crimeTypes.length > 0 &&
    crimeTypes.some((t) => !CRIME_LABEL_KEYS.has(t))
  ) {
    reasons.add("crime-type-out-of-whitelist");
  }

  if (
    isFiniteNumber(entry.offenseYear) &&
    isFiniteNumber(entry.convictionYear) &&
    entry.convictionYear < entry.offenseYear
  ) {
    reasons.add("year-inversion");
  }

  if (
    isFiniteNumber(entry.convictionYear) &&
    entry.convictionYear > CURRENT_YEAR
  ) {
    reasons.add("future-conviction-year");
  }

  if (entry.stillInOffice == null) reasons.add("missing-still-in-office");

  // Severity (first-match-wins).
  let severity = null;

  if (convictedNoYear) {
    const condHighLevel = level === "federal" || level === "party-official";
    const condOfficeText = OFFICE_REGEX.test(office);
    // Catches 725 entries (49%) where `office` is empty — apply to summary too.
    const condSummaryText = OFFICE_REGEX.test(summary);
    const condKnownName = KNOWN_HIGH_PROFILE_NAMES.has(entry.id);
    const condEnablement =
      crimeTypes.length > 0 &&
      crimeTypes.every((t) => ENABLEMENT_TYPES.has(t));

    if (
      condHighLevel ||
      condOfficeText ||
      condSummaryText ||
      condKnownName ||
      condEnablement
    ) {
      severity = "P0";
      // P0 invariant: must carry at least one of the three flag codes.
      if (condHighLevel || condOfficeText || condSummaryText) {
        reasons.add("suspect-high-profile-convicted");
      }
      if (condKnownName) reasons.add("known-high-profile-name");
      if (condEnablement) reasons.add("convicted-of-enablement-only");
    }
  }

  if (
    severity == null &&
    (status === "charged" || status === "alleged") &&
    evtYear != null &&
    evtYear <= 2020
  ) {
    severity = "P1";
  }

  if (severity == null && convictedNoYear) {
    severity = "P2";
  }

  if (
    severity == null &&
    entry.stillInOffice == null &&
    P3_LEVELS.has(level)
  ) {
    severity = "P3";
  }

  if (severity == null) return null;
  return { severity, reasons };
}

function suggestedAction(severity) {
  switch (severity) {
    case "P0":
      return "verify";
    case "P1":
      return "soft-hide";
    case "P2":
      return "backfill";
    case "P3":
      return "backfill";
    default:
      return "verify";
  }
}

// ───────────── Main ─────────────
async function main() {
  let raw;
  try {
    raw = await readFile(resolve(process.cwd(), peopleFile), "utf8");
  } catch (err) {
    console.error(
      `Error reading --people-file '${peopleFile}': ${err.message}`,
    );
    process.exit(1);
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    console.error(
      `Error parsing JSON from --people-file '${peopleFile}': ${err.message}`,
    );
    process.exit(1);
  }

  if (!Array.isArray(data)) {
    console.error(
      `Error: --people-file '${peopleFile}' did not contain a JSON array`,
    );
    process.exit(1);
  }

  const rows = [];
  for (const entry of data) {
    if (!entry || typeof entry !== "object") continue;
    const result = classify(entry);
    if (!result) continue;

    const reasonList = [...result.reasons].sort();
    const action = suggestedAction(result.severity);
    const notes = `Reason codes: ${reasonList.join(";")}. Suggested action: ${action}.`;

    // P0 reason-code invariant — must include at least one P0 flag code.
    if (result.severity === "P0") {
      const hasP0Reason = reasonList.some(
        (r) =>
          r === "suspect-high-profile-convicted" ||
          r === "convicted-of-enablement-only" ||
          r === "known-high-profile-name",
      );
      if (!hasP0Reason) {
        console.error(
          `P0 invariant violation for id='${entry.id}': missing required reason code`,
        );
        process.exit(1);
      }
    }

    rows.push({
      id: entry.id ?? "",
      name: entry.name ?? "",
      status: entry.status ?? "",
      level: entry.level ?? "",
      state: entry.state ?? "",
      severity: result.severity,
      reason_codes: reasonList.join(";"),
      suggested_action: action,
      notes,
    });
  }

  // Tone gate — assert across ALL notes BEFORE any writes. Strict.
  for (const row of rows) {
    if (TONE_REGEX.test(row.notes)) {
      console.error(
        `Tone gate violation in notes for id='${row.id}': ${row.notes}`,
      );
      process.exit(1);
    }
  }

  // Sort: severity ASC, then name ASC (locale-independent for idempotency).
  const sevOrder = { P0: 0, P1: 1, P2: 2, P3: 3 };
  rows.sort((a, b) => {
    const sd = sevOrder[a.severity] - sevOrder[b.severity];
    if (sd !== 0) return sd;
    return a.name.localeCompare(b.name, "en-US");
  });

  const header =
    "id,name,status,level,state,severity,reason_codes,suggested_action,notes";
  const lines = [header];
  for (const r of rows) {
    lines.push(
      [
        csvEscape(r.id),
        csvEscape(r.name),
        csvEscape(r.status),
        csvEscape(r.level),
        csvEscape(r.state),
        csvEscape(r.severity),
        csvEscape(r.reason_codes),
        csvEscape(r.suggested_action),
        csvEscape(r.notes),
      ].join(","),
    );
  }
  // No trailing newline: keeps the CSV byte-identical to a parser that splits
  // strictly on '\n' (a trailing newline produces a spurious empty trailing
  // row in naive RFC-4180 parsers — see acceptance criterion 4).
  const csvText = lines.join("\n");

  const primary = resolve(process.cwd(), ".omo/research/flagged-entries.csv");
  const excel = resolve(
    process.cwd(),
    ".omo/research/flagged-entries.utf8-sig.csv",
  );

  const utf8Buf = Buffer.from(csvText, "utf8");
  // 0xEF 0xBB 0xBF — UTF-8 BOM for Excel auto-detection.
  const bomBuf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), utf8Buf]);

  await atomicWrite(primary, utf8Buf);
  await atomicWrite(excel, bomBuf);

  const counts = { P0: 0, P1: 0, P2: 0, P3: 0 };
  for (const r of rows) counts[r.severity]++;
  process.stdout.write(`Wrote ${rows.length} flagged rows to ${primary}\n`);
  process.stdout.write(`Wrote ${rows.length} flagged rows to ${excel}\n`);
  process.stdout.write(
    `Counts: P0=${counts.P0} P1=${counts.P1} P2=${counts.P2} P3=${counts.P3}\n`,
  );
}

main().catch((err) => {
  console.error(`Fatal error: ${err.message}`);
  process.exit(1);
});
