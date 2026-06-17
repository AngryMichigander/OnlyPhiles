#!/usr/bin/env node
// scripts/audit-data.mjs — Read-only audit of data/people.json.
// Emits a master audit report to BOTH .omo/research/ and docs/audits/.
// Atomic writes via same-dir .tmp + rename. Zero deps beyond node:* built-ins.

import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

const TODAY_ISO = "2026-06-17";
const CURRENT_YEAR = 2026;
const AUDIT_DATE = "2026-06-17";

const OUTPUTS = [
  resolve(REPO_ROOT, `.omo/research/data-audit-${AUDIT_DATE}.md`),
  resolve(REPO_ROOT, `docs/audits/data-audit-${AUDIT_DATE}.md`),
];

const ALLOWED_FIELDS = [
  "id", "name", "status", "level", "state", "office",
  "crimeDescription", "summary", "stillInOffice", "offenseYear",
  "convictionYear", "eventDate", "crimeTypes", "sources",
];

const MISSINGNESS_FIELDS = [
  "convictionYear", "offenseYear", "eventDate", "stillInOffice",
  "office", "summary", "state", "level", "crimeTypes",
];

// ----- CLI -----

function parseArgs(argv) {
  const args = { peopleFile: resolve(REPO_ROOT, "data/people.json") };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--people-file") {
      const v = argv[++i];
      if (!v) throw new Error("--people-file requires a path argument");
      args.peopleFile = resolve(v);
    } else {
      throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }
  return args;
}

// ----- I/O helpers -----

async function atomicWrite(destPath, content) {
  const tmpPath = destPath + ".tmp";
  await mkdir(dirname(destPath), { recursive: true });
  await writeFile(tmpPath, content, "utf8");
  await rename(tmpPath, destPath);
}

async function extractBlock(filePath, regex) {
  const src = await readFile(filePath, "utf8");
  const m = src.match(regex);
  return m ? m[1] : null;
}

async function loadCrimeLabels() {
  const path = resolve(REPO_ROOT, "public/app.js");
  const body = await extractBlock(path, /const CRIME_LABELS = (\{[\s\S]*?\});/);
  if (!body) throw new Error("Could not extract CRIME_LABELS from public/app.js");
  const keys = [...body.matchAll(/^\s*"?([a-z][a-z0-9-]*)"?\s*:/gm)].map((m) => m[1]);
  return new Set(keys);
}

async function loadUsStates() {
  const path = resolve(REPO_ROOT, "public/app.js");
  const body = await extractBlock(path, /const US_STATES = \[([\s\S]*?)\];/);
  if (!body) throw new Error("Could not extract US_STATES from public/app.js");
  const items = [...body.matchAll(/"([A-Z]{2})"/g)].map((m) => m[1]);
  return new Set(items);
}

// ----- Utilities -----

function isEmpty(v) {
  if (v === null || v === undefined) return true;
  if (typeof v === "string" && v.trim() === "") return true;
  if (Array.isArray(v) && v.length === 0) return true;
  return false;
}

function nfmt(n) { return Number(n).toLocaleString("en-US"); }

function distinct(arr) { return [...new Set(arr)]; }

function sortCountDesc(map) {
  return [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function hostname(url) {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ""); }
  catch { return null; }
}

function section(name, body) {
  return `## ${name}\n\n${body}\n`;
}

function pickIdOfMax(entries, field) {
  const have = entries.filter((e) => typeof e?.[field] === "number");
  if (!have.length) return null;
  const max = have.reduce((m, e) => (e[field] > m ? e[field] : m), -Infinity);
  const ties = have.filter((e) => e[field] === max);
  ties.sort((a, b) => String(a.id ?? "").localeCompare(String(b.id ?? "")));
  return { value: max, id: ties[0].id ?? "(no id)" };
}

// ----- Sections -----

function buildTotals(entries) {
  const ids = distinct(entries.map((e) => e?.id).filter((x) => typeof x === "string" && x));
  const names = distinct(entries.map((e) => e?.name).filter((x) => typeof x === "string" && x));
  return [
    `- Total entries: ${nfmt(entries.length)}`,
    `- Total distinct ids: ${nfmt(ids.length)}`,
    `- Total distinct names: ${nfmt(names.length)}`,
  ].join("\n");
}

function buildDistribution(entries, key) {
  const map = new Map();
  for (const e of entries) {
    const v = e?.[key];
    const label = v === null || v === undefined || v === "" ? "(missing)" : String(v);
    map.set(label, (map.get(label) || 0) + 1);
  }
  if (!map.size) return "_(none)_";
  const rows = sortCountDesc(map).map(([k, v]) => `| ${k} | ${nfmt(v)} |`);
  return [`| ${key} | count |`, "|---|---:|", ...rows].join("\n");
}

function buildMissingness(entries) {
  const total = entries.length || 1;
  const rows = MISSINGNESS_FIELDS.map((f) => {
    const missing = entries.filter((e) => isEmpty(e?.[f])).length;
    const pct = ((missing / total) * 100).toFixed(1);
    return `| ${f} | ${nfmt(missing)} | ${pct}% |`;
  });
  return ["| field | missing | % of total |", "|---|---:|---:|", ...rows].join("\n");
}

function buildTaxonomyDrift(entries, crimeLabels) {
  const found = new Set();
  for (const e of entries) {
    if (Array.isArray(e?.crimeTypes)) {
      for (const ct of e.crimeTypes) if (typeof ct === "string" && ct) found.add(ct);
    }
  }
  const undeclared = [...found].filter((c) => !crimeLabels.has(c)).sort();
  const lines = [
    `- Distinct crimeTypes in data: ${nfmt(found.size)}`,
    `- Keys in CRIME_LABELS: ${nfmt(crimeLabels.size)}`,
    `- crimeTypes in data NOT in CRIME_LABELS: ${nfmt(undeclared.length)}`,
  ];
  if (undeclared.length) {
    lines.push("", "| undeclared crimeType |", "|---|", ...undeclared.map((c) => `| ${c} |`));
  }
  return lines.join("\n");
}

function buildStateDrift(entries, usStates) {
  const allowed = new Set([...usStates, "PR"]);
  const map = new Map();
  for (const e of entries) {
    const s = e?.state;
    if (typeof s === "string" && s && !allowed.has(s)) {
      map.set(s, (map.get(s) || 0) + 1);
    }
  }
  const lines = [`- Non-whitelisted state values: ${nfmt(map.size)}`];
  if (map.size) {
    lines.push("", "| state | count |", "|---|---:|");
    for (const [k, v] of sortCountDesc(map)) lines.push(`| ${k} | ${nfmt(v)} |`);
  }
  return lines.join("\n");
}

function buildDateSanity(entries) {
  const future = entries
    .filter((e) => typeof e?.eventDate === "string" && e.eventDate > TODAY_ISO)
    .slice()
    .sort((a, b) => String(a.id ?? "").localeCompare(String(b.id ?? "")));
  const futureYear = entries
    .filter((e) => typeof e?.convictionYear === "number" && e.convictionYear > CURRENT_YEAR)
    .slice()
    .sort((a, b) => String(a.id ?? "").localeCompare(String(b.id ?? "")));
  const inverted = entries
    .filter((e) =>
      typeof e?.convictionYear === "number" &&
      typeof e?.offenseYear === "number" &&
      e.convictionYear < e.offenseYear)
    .slice()
    .sort((a, b) => String(a.id ?? "").localeCompare(String(b.id ?? "")));

  const offMax = pickIdOfMax(entries, "offenseYear");
  const convMax = pickIdOfMax(entries, "convictionYear");

  const fmt = (arr, mapper) =>
    arr.length === 0 ? "_(none)_" : arr.map((e) => `- ${mapper(e)}`).join("\n");

  return [
    `### Future eventDate (> ${TODAY_ISO}): ${nfmt(future.length)}`,
    "",
    fmt(future, (e) => `${e.id ?? "(no id)"} (${e.eventDate})`),
    "",
    `### Future convictionYear (> ${CURRENT_YEAR}): ${nfmt(futureYear.length)}`,
    "",
    fmt(futureYear, (e) => `${e.id ?? "(no id)"} (${e.convictionYear})`),
    "",
    `### Year inversion (convictionYear < offenseYear): ${nfmt(inverted.length)}`,
    "",
    fmt(inverted, (e) => `${e.id ?? "(no id)"} (offense=${e.offenseYear}, conviction=${e.convictionYear})`),
    "",
    `### Latest offenseYear: ${offMax ? `${offMax.value} (id=${offMax.id})` : "_(none)_"}`,
    `### Latest convictionYear: ${convMax ? `${convMax.value} (id=${convMax.id})` : "_(none)_"}`,
  ].join("\n");
}

function buildSourceDomains(entries) {
  const allUrls = [];
  const uniqUrls = new Set();
  const domains = new Map();
  for (const e of entries) {
    if (!Array.isArray(e?.sources)) continue;
    for (const u of e.sources) {
      if (typeof u !== "string" || !u) continue;
      allUrls.push(u);
      uniqUrls.add(u);
      const h = hostname(u);
      if (h) domains.set(h, (domains.get(h) || 0) + 1);
    }
  }
  const top = sortCountDesc(domains).slice(0, 20);
  return [
    `- Total source URL occurrences: ${nfmt(allUrls.length)}`,
    `- Total unique URLs: ${nfmt(uniqUrls.size)}`,
    `- Total unique hostnames: ${nfmt(domains.size)}`,
    "",
    "### Top 20 domains by frequency",
    "",
    "| domain | count |",
    "|---|---:|",
    ...top.map(([d, n]) => `| ${d} | ${nfmt(n)} |`),
  ].join("\n");
}

function buildSingleSource(entries) {
  const single = entries.filter((e) => Array.isArray(e?.sources) && e.sources.length === 1);
  const ids = single
    .map((e) => (typeof e?.id === "string" ? e.id : null))
    .filter((x) => x !== null)
    .sort();
  const lines = [`- Entries with exactly 1 source: ${nfmt(single.length)}`];
  if (ids.length) {
    lines.push("", "### First 10 by id (alphabetical)", "");
    for (const id of ids.slice(0, 10)) lines.push(`- ${id}`);
  }
  return lines.join("\n");
}

function buildFieldInventory(entries) {
  const keys = new Set();
  for (const e of entries) {
    if (e && typeof e === "object" && !Array.isArray(e)) {
      for (const k of Object.keys(e)) keys.add(k);
    }
  }
  const allowed = new Set(ALLOWED_FIELDS);
  const sortedKeys = [...keys].sort();
  const unknown = sortedKeys.filter((k) => !allowed.has(k));
  const lines = [
    `- Distinct field keys across all entries: ${nfmt(sortedKeys.length)}`,
    `- Unknown keys (not in documented schema): ${nfmt(unknown.length)}`,
    "",
    "### All keys (sorted)",
    "",
    ...sortedKeys.map((k) => `- ${k}${allowed.has(k) ? "" : " (unknown)"}`),
  ];
  if (unknown.length) {
    lines.push("", "### Unknown keys", "", ...unknown.map((k) => `- ${k}`));
  }
  return lines.join("\n");
}

function buildMalformed(entries) {
  const required = ["id", "name", "status", "sources"];
  const bad = [];
  entries.forEach((e, i) => {
    if (!e || typeof e !== "object") {
      bad.push({ index: i, id: "(non-object)", missing: required });
      return;
    }
    const missing = required.filter((k) => isEmpty(e[k]));
    if (missing.length) bad.push({ index: i, id: e.id ?? "(no id)", missing });
  });
  if (!bad.length) return null;
  bad.sort((a, b) => a.index - b.index);
  return [
    "| index | id | missing |",
    "|---:|---|---|",
    ...bad.map((b) => `| ${b.index} | ${b.id} | ${b.missing.join(", ")} |`),
  ].join("\n");
}

// ----- Main -----

async function main() {
  const args = parseArgs(process.argv);

  let raw;
  try {
    raw = await readFile(args.peopleFile, "utf8");
  } catch (err) {
    process.stderr.write(
      `audit-data: cannot read --people-file ${args.peopleFile}: ${err.message}\n`,
    );
    process.exit(1);
  }

  let entries;
  try {
    entries = JSON.parse(raw);
  } catch (err) {
    process.stderr.write(
      `audit-data: invalid JSON in --people-file ${args.peopleFile}: ${err.message}\n`,
    );
    process.exit(1);
  }

  if (!Array.isArray(entries)) {
    process.stderr.write(
      `audit-data: --people-file must contain a JSON array of entries\n`,
    );
    process.exit(1);
  }

  const [crimeLabels, usStates] = await Promise.all([loadCrimeLabels(), loadUsStates()]);

  const sections = [
    section("Totals", buildTotals(entries)),
    section("Status distribution", buildDistribution(entries, "status")),
    section("Level distribution", buildDistribution(entries, "level")),
    section("Missingness", buildMissingness(entries)),
    section("Taxonomy drift", buildTaxonomyDrift(entries, crimeLabels)),
    section("State enum drift", buildStateDrift(entries, usStates)),
    section("Date sanity", buildDateSanity(entries)),
    section("Source domains", buildSourceDomains(entries)),
    section("Single-source entries", buildSingleSource(entries)),
    section("Field-key inventory", buildFieldInventory(entries)),
  ];

  const malformed = buildMalformed(entries);
  if (malformed) sections.push(section("Malformed entries", malformed));

  const relSource = args.peopleFile.startsWith(REPO_ROOT + "/")
    ? args.peopleFile.slice(REPO_ROOT.length + 1)
    : args.peopleFile;

  const header = [
    `# Data audit — ${AUDIT_DATE}`,
    "",
    `- Source: \`${relSource}\``,
    `- Generated by: \`scripts/audit-data.mjs\``,
    `- Read-only: this report does not mutate \`data/\`, \`worker/\`, or \`public/\`.`,
    "",
  ].join("\n");

  const content = header + sections.join("\n");

  for (const dest of OUTPUTS) await atomicWrite(dest, content);

  process.stdout.write(`audit-data: wrote ${OUTPUTS.length} files\n`);
  for (const d of OUTPUTS) process.stdout.write(`  - ${d}\n`);
}

main().catch((err) => {
  process.stderr.write(`audit-data: fatal: ${err.message}\n`);
  process.exit(1);
});
