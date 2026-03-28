/**
 * Shared link extraction from HTML for enrichment scripts.
 */

const DEFAULT_SKIP_DOMAINS = /twitter\.com|x\.com|facebook\.com|bluesky\.app|spoutible\.com|amazon\.com|rainn\.org|abortionfunds\.org|automattic\.com|wordpress\.com\//i;
const DEFAULT_JUNK_PATHS = /wp-content|gravatar\.com|jetpack|akismet|wp\.me|subscribe\.|feeds\.|gmpg\.org|s1\.wp\.com|opensearch\.xml/i;

/**
 * Extract external links from HTML, filtering out social media, WordPress internals, and junk.
 * @param {string} html - Raw HTML string
 * @param {object} [opts]
 * @param {RegExp} [opts.skipDomains] - Additional domains to skip
 * @param {RegExp} [opts.junkPaths] - Additional junk paths to skip
 * @param {number} [opts.minPathLength] - Minimum URL pathname length (default: 0)
 * @returns {string[]} Array of unique URLs
 */
function extractLinks(html, opts = {}) {
  const skipDomains = opts.skipDomains || DEFAULT_SKIP_DOMAINS;
  const junkPaths = opts.junkPaths || DEFAULT_JUNK_PATHS;
  const minPathLength = opts.minPathLength || 0;

  const seen = new Set();
  const links = [];
  const re = /href="(https?:\/\/[^"]+)"/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const url = m[1];
    if (skipDomains.test(url) || junkPaths.test(url)) continue;
    if (url.includes('goppredators.wordpress.com')) continue;
    try {
      if (minPathLength > 0 && new URL(url).pathname.length <= minPathLength) continue;
    } catch {
      continue;
    }
    if (!seen.has(url)) { seen.add(url); links.push(url); }
  }
  return links;
}

module.exports = { extractLinks, DEFAULT_SKIP_DOMAINS, DEFAULT_JUNK_PATHS };
