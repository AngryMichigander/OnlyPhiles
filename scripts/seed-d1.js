#!/usr/bin/env node
/**
 * Reads data/people.json and generates worker/seed.sql
 * with INSERT statements for people, crime_types, and sources tables.
 */

const fs = require("fs");
const path = require("path");

function esc(val) {
  if (val === null || val === undefined) return "NULL";
  return "'" + String(val).replace(/'/g, "''") + "'";
}

function boolToInt(val) {
  if (val === true) return "1";
  if (val === false) return "0";
  return "NULL";
}

function intOrNull(val) {
  if (val === null || val === undefined) return "NULL";
  const n = parseInt(val, 10);
  if (isNaN(n)) return "NULL";
  return String(n);
}

module.exports = { esc, boolToInt, intOrNull };

if (require.main === module) {
  const dataPath = path.join(__dirname, "..", "data", "people.json");
  const outPath = path.join(__dirname, "..", "worker", "seed.sql");

  const people = JSON.parse(fs.readFileSync(dataPath, "utf-8"));

  const lines = [];

  // D1 remote execution doesn't support SQL BEGIN TRANSACTION.
  // D1 batch imports are already atomic.

  const dataCols = [
    "id", "name", "status", "level", "state", "office", "crime_description",
    "summary", "still_in_office", "offense_year", "conviction_year", "event_date",
  ];

  for (const p of people) {
    const values = [
      esc(p.id), esc(p.name), esc(p.status), esc(p.level), esc(p.state),
      esc(p.office), esc(p.crimeDescription), esc(p.summary),
      boolToInt(p.stillInOffice), intOrNull(p.offenseYear),
      intOrNull(p.convictionYear), esc(p.eventDate),
    ];

    // Upsert: update all data columns but NOT `enabled`
    const updates = dataCols.slice(1).map((col) => `${col} = excluded.${col}`).join(", ");

    lines.push(
      `INSERT INTO people (${dataCols.join(", ")}) VALUES (${values.join(", ")}) ON CONFLICT(id) DO UPDATE SET ${updates};`
    );

    // Replace crime_types for this person
    lines.push(`DELETE FROM crime_types WHERE person_id = ${esc(p.id)};`);
    if (Array.isArray(p.crimeTypes)) {
      for (const ct of p.crimeTypes) {
        lines.push(
          `INSERT INTO crime_types (person_id, crime_type) VALUES (${esc(p.id)}, ${esc(ct)});`
        );
      }
    }

    // Replace sources for this person
    lines.push(`DELETE FROM sources WHERE person_id = ${esc(p.id)};`);
    if (Array.isArray(p.sources)) {
      for (const url of p.sources) {
        lines.push(
          `INSERT INTO sources (person_id, url) VALUES (${esc(p.id)}, ${esc(url)});`
        );
      }
    }
  }

  // Orphan cleanup: remove people not in people.json
  if (people.length > 0) {
    const allIds = people.map((p) => esc(p.id)).join(", ");
    lines.push("");
    lines.push("-- Orphan cleanup: remove entries not in people.json");
    lines.push(`DELETE FROM sources WHERE person_id NOT IN (${allIds});`);
    lines.push(`DELETE FROM crime_types WHERE person_id NOT IN (${allIds});`);
    lines.push(`DELETE FROM people WHERE id NOT IN (${allIds});`);
  }

  fs.writeFileSync(outPath, lines.join("\n"), "utf-8");
  console.log(`Wrote ${lines.length} lines to ${outPath}`);
  console.log(`  ${people.length} people (upsert)`);
}
