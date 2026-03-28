import { describe, it, expect } from "vitest";
import {
  extractLinks,
  DEFAULT_SKIP_DOMAINS,
  DEFAULT_JUNK_PATHS,
} from "../scripts/lib/extract-links.js";

describe("extractLinks", () => {
  it("extracts http and https links from HTML", () => {
    const html = `
      <a href="https://example.com/article">Link 1</a>
      <a href="http://news.org/story">Link 2</a>
    `;
    const links = extractLinks(html);
    expect(links).toEqual([
      "https://example.com/article",
      "http://news.org/story",
    ]);
  });

  it("deduplicates repeated URLs", () => {
    const html = `
      <a href="https://example.com/article">Link 1</a>
      <a href="https://example.com/article">Link 2</a>
      <a href="https://other.com">Link 3</a>
    `;
    const links = extractLinks(html);
    expect(links).toEqual([
      "https://example.com/article",
      "https://other.com",
    ]);
  });

  it("skips social media domains by default", () => {
    const html = `
      <a href="https://twitter.com/user">Twitter</a>
      <a href="https://x.com/user">X</a>
      <a href="https://facebook.com/page">Facebook</a>
      <a href="https://bluesky.app/profile">Bluesky</a>
      <a href="https://news.com/article">Real link</a>
    `;
    const links = extractLinks(html);
    expect(links).toEqual(["https://news.com/article"]);
  });

  it("skips WordPress junk paths by default", () => {
    const html = `
      <a href="https://site.com/wp-content/uploads/image.jpg">WP upload</a>
      <a href="https://gravatar.com/avatar/abc">Gravatar</a>
      <a href="https://site.com/real-article">Real link</a>
    `;
    const links = extractLinks(html);
    expect(links).toEqual(["https://site.com/real-article"]);
  });

  it("skips goppredators.wordpress.com links", () => {
    const html = `
      <a href="https://goppredators.wordpress.com/2024/01/01/post">Self-link</a>
      <a href="https://example.com/article">External</a>
    `;
    const links = extractLinks(html);
    expect(links).toEqual(["https://example.com/article"]);
  });

  it("filters by minimum path length", () => {
    const html = `
      <a href="https://example.com/">Root</a>
      <a href="https://example.com/a">Short path</a>
      <a href="https://example.com/long-article-path">Long path</a>
    `;
    const links = extractLinks(html, { minPathLength: 5 });
    expect(links).toEqual(["https://example.com/long-article-path"]);
  });

  it("accepts custom skip domains", () => {
    const html = `
      <a href="https://skip-me.com/page">Skip</a>
      <a href="https://keep-me.com/page">Keep</a>
    `;
    const links = extractLinks(html, { skipDomains: /skip-me\.com/i });
    expect(links).toEqual(["https://keep-me.com/page"]);
  });

  it("returns empty array for HTML with no links", () => {
    expect(extractLinks("<p>No links here</p>")).toEqual([]);
  });

  it("returns empty array for empty string", () => {
    expect(extractLinks("")).toEqual([]);
  });

  it("ignores malformed URLs gracefully", () => {
    const html = `<a href="https://[invalid">Bad URL</a>`;
    // extractLinks uses regex, so this will be extracted as a string
    // The minPathLength filter would try to parse it — test with minPathLength
    const links = extractLinks(html, { minPathLength: 5 });
    // Invalid URL causes new URL() to throw, which is caught and skipped
    expect(links).toEqual([]);
  });

  it("exports default regex constants", () => {
    expect(DEFAULT_SKIP_DOMAINS).toBeInstanceOf(RegExp);
    expect(DEFAULT_JUNK_PATHS).toBeInstanceOf(RegExp);
    expect(DEFAULT_SKIP_DOMAINS.test("twitter.com")).toBe(true);
    expect(DEFAULT_JUNK_PATHS.test("wp-content/uploads")).toBe(true);
  });
});
