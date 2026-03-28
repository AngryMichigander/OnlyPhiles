-- NOTE: CREATE TABLE IF NOT EXISTS will NOT add new columns or constraints to existing tables.
-- For existing D1 databases, drop all tables first then re-run this schema + seed:
--   DROP TABLE IF EXISTS sources; DROP TABLE IF EXISTS crime_types; DROP TABLE IF EXISTS people;
CREATE TABLE IF NOT EXISTS people (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'alleged',
  level TEXT DEFAULT 'adjacent',
  state TEXT,
  office TEXT,
  crime_description TEXT,
  summary TEXT,
  still_in_office INTEGER, -- 0/1/null
  offense_year INTEGER,
  conviction_year INTEGER,
  event_date TEXT,
  enabled INTEGER NOT NULL DEFAULT 1 -- 0 = hidden from public, 1 = visible
);

CREATE TABLE IF NOT EXISTS crime_types (
  person_id TEXT NOT NULL,
  crime_type TEXT NOT NULL,
  UNIQUE(person_id, crime_type),
  FOREIGN KEY (person_id) REFERENCES people(id)
);

CREATE TABLE IF NOT EXISTS sources (
  person_id TEXT NOT NULL,
  url TEXT NOT NULL,
  FOREIGN KEY (person_id) REFERENCES people(id)
);

CREATE INDEX IF NOT EXISTS idx_people_status ON people(status);
CREATE INDEX IF NOT EXISTS idx_people_state ON people(state);
CREATE INDEX IF NOT EXISTS idx_people_level ON people(level);
CREATE INDEX IF NOT EXISTS idx_crime_types_person ON crime_types(person_id);
CREATE INDEX IF NOT EXISTS idx_crime_types_type ON crime_types(crime_type);
CREATE INDEX IF NOT EXISTS idx_sources_person ON sources(person_id);

CREATE INDEX IF NOT EXISTS idx_people_name ON people(name);
CREATE INDEX IF NOT EXISTS idx_people_offense_year ON people(offense_year);
CREATE INDEX IF NOT EXISTS idx_crime_types_covering ON crime_types(crime_type, person_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sources_unique ON sources(person_id, url);
