CREATE TABLE IF NOT EXISTS meetings (
  meeting_id      TEXT PRIMARY KEY,
  webex_meeting_id TEXT,
  sip_uri         TEXT NOT NULL,
  title           TEXT NOT NULL,
  scheduled_start INTEGER,
  scheduled_end   INTEGER,
  dtmf            TEXT,
  source          TEXT NOT NULL DEFAULT 'manual',  -- 'manual' | 'calendar'
  created_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS bot_status (
  meeting_id TEXT PRIMARY KEY REFERENCES meetings(meeting_id),
  state      TEXT NOT NULL,
  joined_at  INTEGER,
  last_error TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id            TEXT PRIMARY KEY,
  action        TEXT NOT NULL,
  meeting_id    TEXT NOT NULL,
  officer_email TEXT,
  detail        TEXT,
  at            INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_meeting ON audit_log(meeting_id, at);

-- Single-row store for the service-app refresh token. The env
-- WEBEX_SA_REFRESH_TOKEN is only a bootstrap; after the first rotation this
-- row is authoritative.
CREATE TABLE IF NOT EXISTS service_tokens (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  refresh_token TEXT NOT NULL,
  rotated_at    INTEGER NOT NULL
);

-- Ended-meeting history: last-known presence per (meeting, participant).
-- Upsert-per-participant mirror of the in-memory rosterMonitor cache
-- (RosterAttendee) — survives eviction and restart. Deleted with its
-- meeting (deregister = gone, matching the evictRoster contract).
-- NEW table ⇒ CREATE TABLE IF NOT EXISTS on every openDb IS the in-place
-- upgrade for pre-existing db files (no ALTER needed, unlike Plan-07 source).
CREATE TABLE IF NOT EXISTS roster_presence (
  meeting_id     TEXT NOT NULL REFERENCES meetings(meeting_id),
  participant_id TEXT NOT NULL,
  name           TEXT NOT NULL,
  role           TEXT NOT NULL,          -- 'analyst' | 'fo' | 'bot' | 'other'
  is_host        INTEGER NOT NULL,       -- 0 | 1
  joined_at      INTEGER NOT NULL,       -- epoch ms — first seen by the poller
  left_at        INTEGER,                -- epoch ms — NULL while present
  updated_at     INTEGER NOT NULL,       -- epoch ms — last poll that wrote the row
  pstn           INTEGER NOT NULL DEFAULT 0, -- 0 | 1 — PSTN dial-in flag
  phone          TEXT,                   -- unmasked phone number; NULL when absent
  PRIMARY KEY (meeting_id, participant_id)
);
