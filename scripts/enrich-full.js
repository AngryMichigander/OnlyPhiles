#!/usr/bin/env node
/**
 * Full enrichment scraper for goppredators individual post pages.
 * Extracts: summary, office, level, status, conviction year from narrative text.
 * Stores raw text in data/raw/ (gitignored) to avoid re-scraping.
 * 
 * Usage:
 *   node scripts/enrich-full.js --test    # run on 10 sample entries, print results
 *   node scripts/enrich-full.js           # run on all entries, update people.json
 */

const fs = require('fs');
const path = require('path');

const PEOPLE_FILE = path.join(__dirname, '../data/people.json');
const RAW_DIR = path.join(__dirname, '../data/raw');
const PROGRESS_FILE = path.join(__dirname, '../data/enrich-full-progress.json');

const TEST_MODE = process.argv.includes('--test');
const TEST_SAMPLE = [
  'https://goppredators.wordpress.com/2026/03/13/213-charles-k-young/',
  'https://goppredators.wordpress.com/2024/05/23/1300-mike-mcclendon/',
  'https://goppredators.wordpress.com/2025/11/29/1482-george-bell/',
  'https://goppredators.wordpress.com/2023/05/22/965-christopher-haenel/',
  'https://goppredators.wordpress.com/2023/06/18/1027-milton-martin-iii/',
  'https://goppredators.wordpress.com/2023/07/01/1071-steven-crowder/',
  'https://goppredators.wordpress.com/2024/01/25/1243-andy-sanborn/',
  'https://goppredators.wordpress.com/2022/02/25/3-jim-jordan/',
  'https://goppredators.wordpress.com/2024/07/06/1319-jonathan-elwing/',
  'https://goppredators.wordpress.com/2022/07/17/137-bruce-barclay/',
];

const { extractLinks: _extractLinks } = require('./lib/extract-links');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function extractLinks(html) {
  return _extractLinks(html, { minPathLength: 5 });
}

function extractBodyText(html) {
  // Get content between entry-content div and next major section
  const match = html.match(/class="entry-content[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/);
  if (match) {
    // Strip HTML tags
    return match[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }
  // Fallback: strip all tags from body
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 2000);
}

function inferLevel(text, office) {
  const t = (text + ' ' + (office||'')).toLowerCase();
  if (/\bu\.?s\.?\s*(senator|representative|congressman|congress)\b|\bspeaker of the house\b|\bcabinet\b|\bsecretary of\b|\bfederal (judge|official)\b/.test(t)) return 'federal';
  if (/state (senator|representative|rep|assemblyman|legislator|judge)\b|governor|attorney general|state house|state senate|legislature/.test(t)) return 'state';
  if (/\b(mayor|city council|county commissioner|county chair|sheriff|constable|alderman|selectman|parish president|county clerk|city manager|school board|city commissioner|county judge|recorder|registrar)\b/.test(t)) return 'local';
  if (/\b(gop chair|republican chair|party chair|campaign (manager|chair)|party leader|rnc|committeeman|committee chair|party official)\b/.test(t)) return 'party-official';
  return 'adjacent';
}

function inferStatus(text) {
  const t = text.toLowerCase();
  if (/\b(convicted|sentenced|guilty plea|pled guilty|pleaded guilty|found guilty|prison|imprisonment|serving time)\b/.test(t)) return 'convicted';
  if (/\b(charged|indicted|arrested|facing charges|pleaded not guilty|pled not guilty|awaiting trial)\b/.test(t)) return 'charged';
  return 'alleged';
}

function inferOffice(text) {
  // Only check first 500 chars (the subject's bio, not news article text)
  const t = text.slice(0, 500).toLowerCase();
  const patterns = [
    [/was a deputy|deputy .{0,20}sheriff's office|sheriff'?s? (deputy|officer)/, 'Sheriff Deputy'],
    [/was a police officer|police officer|police department/, 'Police Officer'],
    [/state senator/, 'State Senator'],
    [/state rep(resentative)?/, 'State Representative'],
    [/\bmayor\b/, 'Mayor'],
    [/city council(man|woman|member)?/, 'City Councilmember'],
    [/county commissioner/, 'County Commissioner'],
    [/school board/, 'School Board Member'],
    [/\bwas (the |a )?sheriff\b/, 'Sheriff'],
    [/\bpastor\b|\bminister\b|\bpreacher\b/, 'Pastor'],
    [/\bwas a teacher\b|\bteacher at\b/, 'Teacher'],
    [/\bcoach\b/, 'Coach'],
    [/\bjudge\b/, 'Judge'],
    [/\blobbyist\b/, 'Lobbyist'],
    [/campaign (manager|chair|official)/, 'Campaign Official'],
    [/\bactivist\b/, 'Political Activist'],
    [/\binfluencer\b/, 'Media/Influencer'],
    [/congressman|u\.?s\.? rep(resentative)?/, 'U.S. Congressman'],
    [/u\.?s\.? senator/, 'U.S. Senator'],
  ];
  for (const [re, label] of patterns) {
    if (re.test(t)) return label;
  }
  return null;
}

function extractConvictionYear(text) {
  // Look for sentencing/conviction year patterns
  const patterns = [
    /sentenced[^.]{0,50}(20\d\d|19\d\d)/i,
    /convicted[^.]{0,50}(20\d\d|19\d\d)/i,
    /(?:pled|pleaded) guilty[^.]{0,30}(20\d\d|19\d\d)/i,
    /guilty plea[^.]{0,30}(20\d\d|19\d\d)/i,
    /in (20\d\d|19\d\d)[^.]{0,30}(?:sentenced|convicted|guilty)/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) return parseInt(m[1]);
  }
  return null;
}

async function fetchAndParse(url) {
  // Check cache first
  const slug = url.match(/\/(\d+-[^/]+)\/?$/)?.[1] || url.split('/').slice(-2).join('-');
  const cachePath = path.join(RAW_DIR, `${slug}.txt`);

  let bodyText, links;

  if (fs.existsSync(cachePath)) {
    const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    bodyText = cached.bodyText;
    links = cached.links;
  } else {
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0' }
    });
    if (!resp.ok) return null;
    const html = await resp.text();
    bodyText = extractBodyText(html);
    links = extractLinks(html);
    fs.writeFileSync(cachePath, JSON.stringify({ bodyText, links, url, fetchedAt: new Date().toISOString() }));
  }

  const office = inferOffice(bodyText);
  const level = inferLevel(bodyText, office);
  const status = inferStatus(bodyText);
  const convictionYear = extractConvictionYear(bodyText);

  // Clean summary: first 2 sentences of body text, max 300 chars
  const cleanText = bodyText
    .replace(/&#8217;/g, "'").replace(/&#8216;/g, "'").replace(/&#8220;/g, '"').replace(/&#8221;/g, '"')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ');
  const sentences = cleanText.split(/(?<=[.!?])\s+/);
  const summary = sentences.slice(0, 2).join(' ').slice(0, 300).trim();

  return { office, level, status, convictionYear, summary, sources: links.slice(0, 6), bodyText };
}

async function main() {
  if (!fs.existsSync(RAW_DIR)) fs.mkdirSync(RAW_DIR, { recursive: true });

  const people = JSON.parse(fs.readFileSync(PEOPLE_FILE, 'utf8'));

  // Build URL -> person index map
  const urlMap = {};
  people.forEach((p, i) => {
    for (const s of (p.sources || [])) {
      if (s.includes('goppredators.wordpress.com')) urlMap[s] = i;
    }
  });

  let targets;
  if (TEST_MODE) {
    targets = TEST_SAMPLE.map(url => ({ url, idx: urlMap[url] })).filter(t => t.idx !== undefined);
    // Also try matching by partial URL
    if (targets.length < TEST_SAMPLE.length) {
      for (const url of TEST_SAMPLE) {
        const num = url.match(/\/(\d+)-/)?.[1];
        if (num && !targets.find(t => t.url === url)) {
          const idx = people.findIndex(p => (p.sources||[]).some(s => s.includes(`/${num}-`)));
          if (idx >= 0) targets.push({ url, idx });
        }
      }
    }
    console.log(`TEST MODE: processing ${targets.length} entries\n`);
  } else {
    // All people with goppredators sources
    targets = people
      .map((p, i) => ({ url: (p.sources||[]).find(s => s.includes('goppredators.wordpress.com')), idx: i }))
      .filter(t => t.url);
  }

  let progress = {};
  if (!TEST_MODE && fs.existsSync(PROGRESS_FILE)) {
    progress = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
  }

  let processed = 0, updated = 0, errors = 0;

  for (const { url, idx } of targets) {
    if (!TEST_MODE && progress[url]) { processed++; continue; }

    try {
      const result = await fetchAndParse(url);
      if (!result) { errors++; continue; }

      const p = people[idx];

      if (TEST_MODE) {
        console.log(`\n=== ${p.name} ===`);
        console.log(`  URL: ${url}`);
        console.log(`  Office: ${result.office}`);
        console.log(`  Level: ${result.level} (was: ${p.level})`);
        console.log(`  Status: ${result.status} (was: ${p.status})`);
        console.log(`  ConvictionYear: ${result.convictionYear}`);
        console.log(`  Summary: ${result.summary.slice(0, 150)}...`);
        console.log(`  Sources (${result.sources.length}): ${result.sources.slice(0,2).join(', ')}`);
      } else {
        // Update person
        if (result.office) p.office = result.office;
        p.level = result.level;
        p.status = result.status;
        if (result.convictionYear) p.convictionYear = result.convictionYear;
        if (result.summary && result.summary.length > p.summary?.length) p.summary = result.summary;
        if (result.sources.length > 0) {
          const gopSrc = (p.sources||[]).find(s => s.includes('goppredators'));
          p.sources = [...new Set([gopSrc, ...result.sources].filter(Boolean))].slice(0, 8);
        }
        updated++;
        progress[url] = { done: true };

        if (processed % 50 === 0) {
          console.log(`[${processed}/${targets.length}] updated=${updated} errors=${errors}`);
          fs.writeFileSync(PEOPLE_FILE, JSON.stringify(people, null, 2));
          fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress));
        }

        await sleep(3000 + Math.random() * 3000);
      }
      processed++;
    } catch (e) {
      errors++;
      console.error(`Error on ${url}: ${e.message}`);
      if (!TEST_MODE) await sleep(5000);
    }
  }

  if (!TEST_MODE) {
    fs.writeFileSync(PEOPLE_FILE, JSON.stringify(people, null, 2));
    fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress));
    console.log(`\nDone! ${processed} processed, ${updated} updated, ${errors} errors`);
  } else {
    console.log(`\nTest complete. ${processed} parsed, ${errors} errors.`);
  }
}

main().catch(console.error);
