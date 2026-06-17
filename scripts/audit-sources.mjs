#!/usr/bin/env node
// scripts/audit-sources.mjs
// Unique source URLs in data/people.json: 5,752 across 1,675 hostnames (pre-scan 2026-06-17)
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// ── CLI args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const getArg = (flag) => { const i = args.indexOf(flag); return i !== -1 ? args[i+1] : null; };
const hasFlag = (flag) => args.includes(flag);

const PEOPLE_FILE  = resolve(ROOT, getArg('--people-file') ?? 'data/people.json');
const LIMIT        = getArg('--limit') ? parseInt(getArg('--limit'), 10) : Infinity;
const FORCE        = hasFlag('--force');
const TIMEOUT_MS   = parseInt(getArg('--per-request-timeout-ms') ?? '15000', 10);
const PRINT_CONFIG = hasFlag('--print-config');

// ── Output paths ──────────────────────────────────────────────────────────────
const RESEARCH_DIR = resolve(ROOT, '.omo/research');
const CSV_PATH     = resolve(RESEARCH_DIR, 'source-liveness.csv');
const CACHE_PATH   = resolve(RESEARCH_DIR, 'source-liveness-cache.json');

// ── Config output ─────────────────────────────────────────────────────────────
if (PRINT_CONFIG) {
  console.log('redirect: manual');
  console.log('concurrency: 5 global, 1 per host');
  console.log('UA: OnlyPhiles-Audit/1.0 (+https://onlyphiles.com)');
  process.exit(0);
}

const UA = 'OnlyPhiles-Audit/1.0 (+https://onlyphiles.com)';
const GLOBAL_LIMIT = 5;
const HOST_DELAY_MS = 250;
const MAX_HOPS = 5;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// ── Concurrency ───────────────────────────────────────────────────────────────
let globalActive = 0;
let globalMaxSeen = 0;
const globalQueue = [];

function acquireGlobal() {
  if (globalActive < GLOBAL_LIMIT) {
    globalActive++;
    if (globalActive > globalMaxSeen) globalMaxSeen = globalActive;
    return Promise.resolve();
  }
  return new Promise(res => globalQueue.push(res));
}

function releaseGlobal() {
  globalActive--;
  if (globalQueue.length > 0) {
    const next = globalQueue.shift();
    globalActive++;
    if (globalActive > globalMaxSeen) globalMaxSeen = globalActive;
    next();
  }
}

// Per-host chain (serial queue per hostname, 250ms delay between requests)
const hostChains = new Map();
const hostLastReq = new Map();

function withHostLock(hostname, fn) {
  const prev = hostChains.get(hostname) ?? Promise.resolve();
  const next = prev.then(async () => {
    const last = hostLastReq.get(hostname) ?? 0;
    const wait = HOST_DELAY_MS - (Date.now() - last);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    hostLastReq.set(hostname, Date.now());
    return fn();
  });
  hostChains.set(hostname, next.catch(() => {}));
  return next;
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────
async function fetchWithTimeout(url, opts) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function probeSingle(url, method = 'HEAD') {
  const headers = { 'User-Agent': UA };
  if (method === 'GET') headers['Range'] = 'bytes=0-2047';
  try {
    const res = await fetchWithTimeout(url, { method, redirect: "manual", headers });
    return res;
  } catch (e) {
    return null; // network/timeout error
  }
}

// Follow redirects manually (up to MAX_HOPS)
async function probeUrl(startUrl) {
  let url = startUrl;
  let hops = 0;

  while (hops <= MAX_HOPS) {
    try { new URL(url).hostname; } catch { return { status: 0, error: 'invalid-url', final_url: url, content_type: '', bytes: null, redirect_hops: hops }; }

    let res = await probeSingle(url, 'HEAD');
    if (!res || [405, 403].includes(res?.status) || res?.status === 0) {
      res = await probeSingle(url, 'GET');
    }
    if (!res) {
      return { status: 0, error: 'network-error', final_url: url, content_type: '', bytes: null, redirect_hops: hops };
    }

    // Handle 429
    if (res.status === 429) {
      const retryAfter = Math.min(parseInt(res.headers.get('retry-after') ?? '5', 10), 60);
      await new Promise(r => setTimeout(r, retryAfter * 1000));
      continue;
    }

    // Handle 3xx
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) return { status: res.status, error: 'no-location-header', final_url: url, content_type: '', bytes: null, redirect_hops: hops };
      let nextUrl;
      try { nextUrl = new URL(loc, url).href; } catch { return { status: res.status, error: 'invalid-redirect-target', final_url: url, content_type: '', bytes: null, redirect_hops: hops }; }
      if (nextUrl === url) return { status: res.status, error: 'redirect-loop', final_url: url, content_type: '', bytes: null, redirect_hops: hops };
      url = nextUrl;
      hops++;
      continue;
    }

    // Success or terminal status
    const ct = res.headers.get('content-type') ?? '';
    const cl = res.headers.get('content-length') ?? '';
    return {
      status: res.status,
      final_url: url,
      content_type: ct.split(';')[0].trim(),
      bytes: cl ? parseInt(cl, 10) : null,
      redirect_hops: hops,
      error: null,
    };
  }
  return { status: 0, error: 'too-many-redirects', final_url: url, content_type: '', bytes: null, redirect_hops: hops };
}

// ── Robots.txt (minimal — full-site block only) ───────────────────────────────
const robotsCache = new Map();

async function isBlocked(hostname) {
  if (robotsCache.has(hostname)) return robotsCache.get(hostname);
  let blocked = false;
  try {
    const res = await fetchWithTimeout(`https://${hostname}/robots.txt`, {
      method: "GET", redirect: "manual",
      headers: { 'User-Agent': UA },
    });
    if (res && res.status === 200) {
      const text = await res.text();
      // Parse minimal subset: Disallow: / for User-agent: * or OnlyPhiles-Audit
      let currentAgents = [];
      for (const rawLine of text.split('\n')) {
        const line = rawLine.trim();
        if (line.startsWith('#') || line === '') { currentAgents = []; continue; }
        const idx = line.indexOf(':');
        if (idx === -1) continue;
        const key = line.slice(0, idx).trim().toLowerCase();
        const val = line.slice(idx + 1).trim().toLowerCase();
        if (key === 'user-agent') {
          if (val === '*' || val === 'onlyphiles-audit') currentAgents.push(val);
        } else if (key === 'disallow' && val === '/' && currentAgents.length > 0) {
          blocked = true; break;
        }
      }
    }
  } catch { /* ignore robots errors */ }
  robotsCache.set(hostname, blocked);
  return blocked;
}

// ── Cache ─────────────────────────────────────────────────────────────────────
let cache = {};
let cacheDirty = false;

async function loadCache() {
  try {
    cache = JSON.parse(await readFile(CACHE_PATH, 'utf8'));
  } catch { cache = {}; }
}

async function saveCache() {
  await mkdir(RESEARCH_DIR, { recursive: true });
  const tmp = CACHE_PATH + '.tmp';
  await writeFile(tmp, JSON.stringify(cache, null, 2), 'utf8');
  await rename(tmp, CACHE_PATH);
  cacheDirty = false;
}

// ── CSV helpers ───────────────────────────────────────────────────────────────
function csvField(val) {
  const s = String(val ?? '');
  if (/[,"\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function csvRow(...fields) {
  return fields.map(csvField).join(',');
}

// ── SIGTERM handling ──────────────────────────────────────────────────────────
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  try { await saveCache(); } catch (e) { process.stderr.write('cache-save-error: ' + e.message + '\n'); }
  console.log(`[concurrency-max-seen=${globalMaxSeen}]`);
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  await mkdir(RESEARCH_DIR, { recursive: true });
  await loadCache();

  const raw = JSON.parse(await readFile(PEOPLE_FILE, 'utf8'));

  // Build map: url -> [person_ids]
  const urlToIds = new Map();
  for (const person of raw) {
    for (const src of (person.sources ?? [])) {
      if (!urlToIds.has(src)) urlToIds.set(src, []);
      urlToIds.get(src).push(person.id ?? '(unknown)');
    }
  }

  // Unique URLs, capped by --limit
  const uniqueUrls = [...urlToIds.keys()].slice(0, LIMIT);
  const now = Date.now();
  const results = new Map(); // url -> result

  await Promise.allSettled(uniqueUrls.map(async (url) => {
    if (shuttingDown) return;
    // Check cache
    const cached = cache[url];
    if (!FORCE && cached && cached.checked_at && (now - new Date(cached.checked_at).getTime()) < CACHE_TTL_MS) {
      results.set(url, cached);
      return;
    }

    let hostname;
    try { hostname = new URL(url).hostname; } catch {
      const r = { status: 0, error: 'invalid-url', final_url: url, content_type: '', bytes: null, checked_at: new Date().toISOString(), redirect_hops: 0 };
      results.set(url, r);
      cache[url] = r; cacheDirty = true;
      return;
    }

    await withHostLock(hostname, async () => {
      if (shuttingDown) return;
      await acquireGlobal();
      try {
        // Robots check
        if (await isBlocked(hostname)) {
          const r = { status: 0, error: 'robots-disallow', final_url: url, content_type: '', bytes: null, checked_at: new Date().toISOString(), redirect_hops: 0 };
          results.set(url, r);
          cache[url] = r; cacheDirty = true;
          return;
        }
        const res = await probeUrl(url);
        const r = { ...res, checked_at: new Date().toISOString() };
        results.set(url, r);
        cache[url] = r; cacheDirty = true;
      } finally {
        releaseGlobal();
      }
    });
  }));

  await saveCache();

  // Emit CSV
  const lines = ['person_id,source_url,http_status,final_url,content_type,bytes,checked_at,error'];
  for (const url of uniqueUrls) {
    const r = results.get(url) ?? cache[url];
    if (!r) continue;
    const ids = urlToIds.get(url) ?? [];
    for (const pid of ids) {
      lines.push(csvRow(
        pid,
        url,
        r.status ?? 0,
        r.final_url ?? '',
        r.content_type ?? '',
        r.bytes ?? '',
        r.checked_at ?? '',
        r.error ?? ''
      ));
    }
  }

  const csvContent = lines.join('\n') + '\n';
  const csvTmp = CSV_PATH + '.tmp';
  await writeFile(csvTmp, csvContent, 'utf8');
  await rename(csvTmp, CSV_PATH);

  console.log(`[concurrency-max-seen=${globalMaxSeen}]`);
  console.log(`Probed ${uniqueUrls.length} unique URLs, wrote ${lines.length - 1} CSV rows`);
}

main().catch(e => { process.stderr.write(e.message + '\n'); process.exit(1); });
