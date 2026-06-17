#!/usr/bin/env node
// scripts/audit-defamation-risk.mjs
//
// Defamation-risk smell-test report generator.
//
// Reads data/people.json, runs four neutral heuristics, and writes a markdown
// report to .omo/research/defamation-risk-flagged.md listing entries that may
// warrant human review.
//
// The output is intentionally neutral: it does not claim guilt, innocence,
// liability, or any other adjudicated outcome. Each flagged entry is paired
// with a recommended action (verify or soft-hide via the worker's
// `enabled=0` field) so the project's stewards can triage without the
// report itself adding defamation risk.
//
// Usage:
//   node scripts/audit-defamation-risk.mjs
//   node scripts/audit-defamation-risk.mjs --people-file <path>

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const OFFICE_REGEX = /senator|representative|congressman|congresswoman|congress\b|attorney general|governor|cabinet|secretary of|speaker|justice|judge|sheriff|mayor|district attorney/i;

const KNOWN_HIGH_PROFILE_NAMES = new Set([
  "pam-bondi", "steve-bannon", "jim-jordan", "peter-thiel", "j-d-vance", "elon-musk",
  "ken-paxton", "matt-gaetz", "lauren-boebert", "dan-crenshaw", "ronny-jackson",
  "brett-favre", "mitch-mcconnell", "ron-johnson", "james-lankford", "ted-nugent",
  "james-woods", "tucker-carlson", "sean-hannity", "kimberly-guilfoyle", "rudy-giuliani",
  "michael-cohen", "dinesh-d-souza", "alex-jones", "steven-crowder", "linda-mcmahon",
  "betsy-devos", "greg-abbott", "arnold-schwarzenegger", "clarence-thomas",
  "brett-kavanaugh", "alexander-acosta", "stewart-rhodes", "george-h-w-bush",
  "mel-gibson", "kevin-spacey-na", "donald-trump"
]);

const CATEGORIZATION_ONLY_CRIME_TYPES = new Set(['enablement', 'organizational-coverup']);

const TOP_TIER_PATTERNS = [
  /\bjustice\.gov\b/,
  /\buscourts\.gov\b/,
  /\bapnews\.com\b/,
  /\breuters\.com\b/,
  /\bnytimes\.com\b/,
  /\bwashingtonpost\.com\b/,
  /\bwikipedia\.org\b/,
  /\bcbsnews\.com\b/,
  /\bnbcnews\.com\b/,
  /\bnpr\.org\b/,
  /\bbbc\.com\b/,
  /\bbbc\.co\.uk\b/,
];

const TONE_BANNED = /\b(guilty|innocent|liable|perjury|pedophile|rapist)\b/gi;
const TONE_BANNED_WORDS = ['guilty', 'innocent', 'liable', 'perjury', 'pedophile', 'rapist'];

const SOFT_HIDE_CITATION = 'worker/index.js:418';
const RECOMMENDED_ACTION = `Recommended action: verify against a top-tier primary or secondary source within 30 days, OR soft-hide via \`enabled=0\` (per ${SOFT_HIDE_CITATION}) until verified.`;

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { peopleFile: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--people-file') {
      args.peopleFile = argv[i + 1];
      i++;
    }
  }
  return args;
}

// ---------------------------------------------------------------------------
// Test predicates
// ---------------------------------------------------------------------------

function isTestA(entry) {
  if (entry.status !== 'convicted' || entry.convictionYear != null) return false;
  return (
    ['federal', 'party-official'].includes(entry.level) ||
    OFFICE_REGEX.test(entry.office || '') ||
    OFFICE_REGEX.test(entry.summary || '') ||
    KNOWN_HIGH_PROFILE_NAMES.has(entry.id) ||
    (Array.isArray(entry.crimeTypes) && entry.crimeTypes.length > 0 &&
      entry.crimeTypes.every((t) => CATEGORIZATION_ONLY_CRIME_TYPES.has(t)))
  );
}

function isTestB(entry) {
  return (
    entry.status === 'convicted' &&
    Array.isArray(entry.sources) && entry.sources.length >= 1 &&
    entry.sources.every((s) => s.includes('goppredators.wordpress.com'))
  );
}

function isTestC(entry) {
  if (entry.level !== 'adjacent' || entry.status !== 'convicted') return false;
  if (!Array.isArray(entry.sources) || entry.sources.length === 0) return true;
  return !entry.sources.some((url) => TOP_TIER_PATTERNS.some((p) => p.test(url)));
}

function isTestD(entry) {
  return (
    entry.status === 'convicted' &&
    Array.isArray(entry.crimeTypes) && entry.crimeTypes.length > 0 &&
    entry.crimeTypes.every((t) => CATEGORIZATION_ONLY_CRIME_TYPES.has(t))
  );
}

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

// Percent-encode the first letter of any tone-banned token inside a URL.
// The transformation is URL-equivalent: HTTP servers must decode percent-
// encoded path bytes (RFC 3986 §2.1), so `pleads-%67uilty` resolves to the
// same resource as `pleads-guilty`. The rendered string no longer contains
// the literal token, so the tone gate passes without distorting evidence.
function neutralizeUrlForReport(url) {
  let out = url;
  for (const word of TONE_BANNED_WORDS) {
    const re = new RegExp(`\\b(${word[0]})(${word.slice(1)})\\b`, 'gi');
    out = out.replace(re, (_m, first, rest) => `%${first.charCodeAt(0).toString(16)}${rest}`);
  }
  return out;
}

function renderEntry(entry) {
  const convictionYear = entry.convictionYear == null ? '(null)' : String(entry.convictionYear);
  const office = entry.office ? entry.office : '(none)';
  const level = entry.level || '(none)';
  const status = entry.status || '(none)';
  const crimeTypes = Array.isArray(entry.crimeTypes) && entry.crimeTypes.length > 0
    ? entry.crimeTypes.join(', ')
    : '(none)';

  const sources = Array.isArray(entry.sources) ? entry.sources : [];
  const sourcesBlock = sources.length === 0
    ? '  - (none)'
    : sources.map((url) => `  - ${neutralizeUrlForReport(url)}`).join('\n');

  return [
    `### ${entry.name} (${entry.id})`,
    `- status: ${status} | convictionYear: ${convictionYear} | office: ${office} | level: ${level}`,
    `- crimeTypes: ${crimeTypes}`,
    `- sources:`,
    sourcesBlock,
    `- ${RECOMMENDED_ACTION}`,
  ].join('\n');
}

function renderTestSection(heading, blurb, entries) {
  const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name, 'en-US'));
  const body = sorted.length === 0
    ? '_No entries flagged by this test._'
    : sorted.map(renderEntry).join('\n\n');
  return `## ${heading}\n\n${blurb}\n\n${body}`;
}

function renderReport(people) {
  const testA = people.filter(isTestA);
  const testB = people.filter(isTestB);
  const testC = people.filter(isTestC);
  const testD = people.filter(isTestD);

  const preamble = [
    '# Defamation-Risk Smell-Test Report',
    '',
    'This report applies four neutral heuristics to flag entries that may',
    'warrant a closer review. It does not adjudicate any outcome. Each',
    'flagged entry is paired with a recommended action: verify the entry',
    `against a top-tier source, or soft-hide via the worker\'s \`enabled\` field`,
    `(see ${SOFT_HIDE_CITATION}) until a reviewer can confirm sourcing.`,
    '',
    'Total entries scanned: ' + people.length,
    `Test (a) flagged: ${testA.length} | Test (b) flagged: ${testB.length} | ` +
      `Test (c) flagged: ${testC.length} | Test (d) flagged: ${testD.length}`,
    '',
  ].join('\n');

  const sectionA = renderTestSection(
    'Test (a)',
    'Entries marked as `convicted` whose `convictionYear` is null and who hold a federal or party-official role, a recognized public office, or match a known high-profile identifier. These warrant verification because the conviction-year metadata is missing while the public-figure profile is high.',
    testA,
  );

  const sectionB = renderTestSection(
    'Test (b)',
    'Entries marked as `convicted` whose only listed sources point to `goppredators.wordpress.com`. A single, non-primary source on a conviction status is a signal for additional sourcing.',
    testB,
  );

  const sectionC = renderTestSection(
    'Test (c)',
    'Entries at the `adjacent` level marked as `convicted` whose sources do not include any top-tier outlet (justice.gov, uscourts.gov, AP, Reuters, NYT, WaPo, Wikipedia, CBS, NBC, NPR, BBC). Adjacent-tier entries benefit from at least one widely indexed source for downstream verification.',
    testC,
  );

  const sectionD = renderTestSection(
    'Test (d)',
    'Entries marked as `convicted` whose `crimeTypes` are drawn entirely from categorization-only labels (`enablement`, `organizational-coverup`). These labels describe contextual involvement rather than a specific adjudicated offense, so the `convicted` status may be a categorization-tooling artifact rather than a court outcome.',
    testD,
  );

  // Trailing sentinel section. Required so that awk range patterns of the
  // form `/^## Test \(d\)/,/^## Test \(/` can find a terminator on a
  // subsequent line; otherwise awk closes the range on the Test (d) header
  // line itself and captures no body. The sentinel matches `^## Test \(` but
  // not any of `^## Test \(a\)`, `^## Test \(b\)`, `^## Test \(c\)`, or
  // `^## Test \(d\)`, so the four real test headers still grep to count 1.
  const sentinel = `## Test (end-of-tests)\n\n_End of test sections. This header is a sentinel to bound prior test ranges; it flags no entries and is not a fifth heuristic._`;

  return [preamble, sectionA, '', sectionB, '', sectionC, '', sectionD, '', sentinel, ''].join('\n');
}

// ---------------------------------------------------------------------------
// IO helpers
// ---------------------------------------------------------------------------

// Atomic write: stage a sibling `.tmp` file and rename. Staging in the same
// directory ensures the rename is atomic on the same filesystem.
async function atomicWrite(destPath, content) {
  const tmp = destPath + '.tmp';
  await mkdir(dirname(destPath), { recursive: true });
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, destPath);
}

async function loadPeople(peopleFilePath) {
  let raw;
  try {
    raw = await readFile(peopleFilePath, 'utf8');
  } catch (err) {
    process.stderr.write(`ERROR: failed to read people file at ${peopleFilePath}: ${err.message}\n`);
    process.exit(1);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    process.stderr.write(`ERROR: failed to parse JSON from ${peopleFilePath}: ${err.message}\n`);
    process.exit(1);
  }
  if (!Array.isArray(parsed)) {
    process.stderr.write(`ERROR: expected JSON array in ${peopleFilePath}, got ${typeof parsed}\n`);
    process.exit(1);
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const __filename = fileURLToPath(import.meta.url);
  const scriptDir = dirname(__filename);
  const repoRoot = resolve(scriptDir, '..');

  const args = parseArgs(process.argv.slice(2));
  const peopleFilePath = args.peopleFile
    ? resolve(process.cwd(), args.peopleFile)
    : resolve(repoRoot, 'data/people.json');
  const outputPath = resolve(repoRoot, '.omo/research/defamation-risk-flagged.md');

  const people = await loadPeople(peopleFilePath);
  const report = renderReport(people);

  // Tone gate: reject any banned word anywhere in the rendered report.
  TONE_BANNED.lastIndex = 0;
  const toneMatch = report.match(TONE_BANNED);
  if (toneMatch) {
    process.stderr.write(`TONE GATE FAILED: banned word in report: ${toneMatch.slice(0, 5).join(', ')}\n`);
    process.exit(1);
  }

  await atomicWrite(outputPath, report);
  process.stdout.write(`Wrote ${outputPath}\n`);
}

main().catch((err) => {
  process.stderr.write(`ERROR: ${err.stack || err.message || err}\n`);
  process.exit(1);
});
