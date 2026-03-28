#!/usr/bin/env node
/**
 * Extract event dates from raw cache files and update people.json.
 * Looks for dates near keywords like arrested/sentenced/charged/convicted.
 * Falls back to first full date in body text.
 */

const fs = require('fs');
const path = require('path');

const PEOPLE_FILE = path.join(__dirname, '../data/people.json');
const RAW_DIR = path.join(__dirname, '../data/raw');

const MONTHS = 'January|February|March|April|May|June|July|August|September|October|November|December';
const DATE_RE = new RegExp(`\\b(${MONTHS})\\s+(\\d{1,2}),?\\s+(20\\d{2}|19\\d{2})\\b`, 'g');

// Keywords that suggest the date is related to the legal event
const EVENT_KEYWORDS = /arrested|sentenced|convicted|charged|indicted|pled guilty|pleaded guilty|found guilty|prison|guilty plea/i;

function extractEventDate(bodyText) {
  // Try to find a date near an event keyword
  const matches = [];
  let m;
  DATE_RE.lastIndex = 0;
  while ((m = DATE_RE.exec(bodyText)) !== null) {
    const context = bodyText.slice(Math.max(0, m.index - 100), m.index + 100);
    const isEvent = EVENT_KEYWORDS.test(context);
    matches.push({ date: m[0], month: m[1], day: parseInt(m[2]), year: parseInt(m[3]), index: m.index, isEvent });
  }
  if (!matches.length) return null;

  // Prefer event-adjacent dates; otherwise take first date
  const eventMatch = matches.find(m => m.isEvent) || matches[0];
  
  const monthNum = new Date(`${eventMatch.month} 1`).getMonth() + 1;
  return `${eventMatch.year}-${String(monthNum).padStart(2,'0')}-${String(eventMatch.day).padStart(2,'0')}`;
}

const people = JSON.parse(fs.readFileSync(PEOPLE_FILE, 'utf8'));

// Build goppredators URL → person index map
const urlMap = {};
people.forEach((p, i) => {
  for (const s of (p.sources || [])) {
    if (s.includes('goppredators.wordpress.com')) urlMap[s] = i;
  }
});

let updated = 0, skipped = 0, noDate = 0;

const rawFiles = fs.readdirSync(RAW_DIR);
for (const f of rawFiles) {
  const cached = JSON.parse(fs.readFileSync(path.join(RAW_DIR, f), 'utf8'));
  const idx = urlMap[cached.url];
  if (idx === undefined) { skipped++; continue; }

  const eventDate = extractEventDate(cached.bodyText);
  if (!eventDate) { noDate++; continue; }

  people[idx].eventDate = eventDate;
  updated++;
}

fs.writeFileSync(PEOPLE_FILE, JSON.stringify(people, null, 2));

// Stats
const withDate = people.filter(p => p.eventDate).length;
console.log(`Updated: ${updated}, Skipped: ${skipped}, No date found: ${noDate}`);
console.log(`Total with eventDate: ${withDate} / ${people.length}`);

// Sample
const samples = people.filter(p => p.eventDate).slice(0, 5);
samples.forEach(p => console.log(`  ${p.name}: ${p.eventDate} (${p.status})`));
