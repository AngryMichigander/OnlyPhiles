#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";

const manifest = JSON.parse(await readFile("vendor/network-manifest/network.json", "utf8"));
const hub = manifest.sites.find((s) => s.role === "hub");
const members = manifest.sites.filter((s) => s.role !== "hub");

const linkHTML = (s) => `<a href="${s.url}">${s.name}</a>`;
const footerHTML = `<footer class="network-footer"><p>Part of the <a href="${hub.url}">${manifest.network_name}</a> — ${members.map(linkHTML).join(" · ")}</p></footer>`;

const MARKER = "<!-- NETWORK_FOOTER -->";

// Files to inject — explicit list excludes admin.html
const TARGETS = ["public/index.html", "public/about.html"];

let failed = false;

for (const target of TARGETS) {
  const html = await readFile(target, "utf8");
  if (!html.includes(MARKER)) {
    console.error(`FAIL: ${target} lacks ${MARKER}`);
    failed = true;
    continue;
  }
  await writeFile(target, html.replace(MARKER, footerHTML + "\n" + MARKER));
  console.log(`Injected footer into ${target}`);
}

// Also fail if admin.html accidentally has the marker (it should not per policy)
const adminHtml = await readFile("public/admin.html", "utf8").catch(() => "");
if (adminHtml.includes(MARKER)) {
  console.error("FAIL: public/admin.html should NOT contain NETWORK_FOOTER marker per policy");
  failed = true;
}

if (failed) process.exit(1);
