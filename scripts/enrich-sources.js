#!/usr/bin/env node
// Scrape each goppredators post to get real news source links
// Rate limited to ~2-3 second delays to be polite

const fs = require('fs');
const path = require('path');

const PEOPLE_FILE = path.join(__dirname, '../data/people.json');
const PROGRESS_FILE = path.join(__dirname, '../data/enrich-progress.json');

const { extractLinks } = require('./lib/extract-links');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchPost(url) {
  const resp = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' }
  });
  if (!resp.ok) return null;
  return resp.text();
}

async function main() {
  const people = JSON.parse(fs.readFileSync(PEOPLE_FILE, 'utf8'));

  // Load progress
  let progress = {};
  if (fs.existsSync(PROGRESS_FILE)) {
    progress = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
  }

  // Find all people with goppredators sources
  const targets = [];
  people.forEach((p, i) => {
    const gopSrc = (p.sources || []).find(s => s.includes('goppredators.wordpress.com'));
    if (gopSrc) targets.push({ idx: i, url: gopSrc });
  });

  console.log(`Found ${targets.length} entries with goppredators sources`);

  let processed = 0;
  let enriched = 0;
  let errors = 0;

  for (const { idx, url } of targets) {
    if (progress[url]) {
      processed++;
      continue;
    }

    try {
      const html = await fetchPost(url);
      if (!html) {
        errors++;
        progress[url] = { done: true, error: 'fetch failed' };
        await sleep(3000);
        continue;
      }

      const links = extractLinks(html);
      // Filter to likely news/article links (has path segments, not just domain)
      const newsLinks = links.filter(l => {
        try {
          const u = new URL(l);
          return u.pathname.length > 5;
        } catch { return false; }
      });

      if (newsLinks.length > 0) {
        const existing = (people[idx].sources || []).filter(s => !s.includes('goppredators'));
        people[idx].sources = [url, ...newsLinks.slice(0, 5), ...existing].slice(0, 8);
        enriched++;
      }

      progress[url] = { done: true, links: newsLinks.length };
      processed++;

      if (processed % 25 === 0) {
        console.log(`[${processed}/${targets.length}] enriched=${enriched} errors=${errors}`);
        fs.writeFileSync(PEOPLE_FILE, JSON.stringify(people, null, 2));
        fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress));
      }

      // Random delay 2-4 seconds
      await sleep(2000 + Math.random() * 2000);

    } catch (e) {
      errors++;
      progress[url] = { done: true, error: e.message };
      await sleep(3000);
    }
  }

  // Final save
  fs.writeFileSync(PEOPLE_FILE, JSON.stringify(people, null, 2));
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress));
  console.log(`\nDone! ${processed} processed, ${enriched} enriched, ${errors} errors`);

}

main().catch(console.error);
