import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync, DatabaseSyncOptions } from 'node:sqlite';
import { openDb, type DB } from '../src/db/index.js';
import { insertMeeting, deleteMeeting } from '../src/db/meetings.js';
import { upsertPresence, getPresence } from '../src/db/presence.js';
import type { RosterAttendee } from '../src/domain/types.js';

// Same vite-node workaround as src/db/index.ts: node:sqlite must be loaded
// through Node's native loader, not Vite's module graph.
const { DatabaseSync: RawDb } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string, options?: DatabaseSyncOptions) => DatabaseSync;
};

function att(over: Partial<RosterAttendee> = {}): RosterAttendee {
  return {
    id: 'p-an',
    name: 'Alex Analyst',
    role: 'analyst',
    isHost: false,
    joinedAt: 1_000,
    leftAt: null,
    ...over,
  };
}

function withMeeting(db: DB) {
  return insertMeeting(db, { sipUri: 'x@site.webex.com', title: 'Presence test' });
}

describe('db/presence — upsertPresence + getPresence', () => {
  it('round-trips a snapshot with exact RosterAttendee field mapping', () => {
    const db = openDb();
    const m = withMeeting(db);
    const dana = att({ id: 'p-fo', name: 'Dana Host', role: 'fo', isHost: true, joinedAt: 900 });
    upsertPresence(db, m.meetingId, [dana, att({ leftAt: 5_000 })]);
    expect(getPresence(db, m.meetingId)).toEqual([
      { id: 'p-fo', name: 'Dana Host', role: 'fo', isHost: true, joinedAt: 900, leftAt: null },
      { id: 'p-an', name: 'Alex Analyst', role: 'analyst', isHost: false, joinedAt: 1_000, leftAt: 5_000 },
    ]);
  });

  it('is an upsert: a second snapshot updates leftAt/isHost in place — one row per participant', () => {
    const db = openDb();
    const m = withMeeting(db);
    upsertPresence(db, m.meetingId, [att()]);
    upsertPresence(db, m.meetingId, [att({ leftAt: 9_000, isHost: true })]);
    const rows = getPresence(db, m.meetingId);
    expect(rows).toHaveLength(1);
    expect(rows[0].leftAt).toBe(9_000);
    expect(rows[0].isHost).toBe(true);
  });

  it('preserves the EARLIEST joined_at defensively — a later snapshot cannot re-originate first-join', () => {
    const db = openDb();
    const m = withMeeting(db);
    upsertPresence(db, m.meetingId, [att({ joinedAt: 1_000 })]);
    // a later snapshot passes a LATER joinedAt (e.g. a caller bug after restart);
    // the DB keeps the original first-join via MIN().
    upsertPresence(db, m.meetingId, [att({ joinedAt: 5_000, leftAt: 8_000 })]);
    const rows = getPresence(db, m.meetingId);
    expect(rows).toHaveLength(1);
    expect(rows[0].joinedAt).toBe(1_000); // earliest wins, not overwritten to 5_000
    expect(rows[0].leftAt).toBe(8_000);
  });

  it('never downgrades pstn/phone: a later snapshot without them keeps the captured values', () => {
    const db = openDb();
    const m = withMeeting(db);
    upsertPresence(db, m.meetingId, [att({ pstn: true, phone: '8452338546' })]);
    // A later poll may lose the enrichment (e.g. Webex omits phoneNumber on
    // that response) — the DB must keep what an earlier poll captured.
    upsertPresence(db, m.meetingId, [att({ leftAt: 9_000 })]);
    const rows = getPresence(db, m.meetingId);
    expect(rows).toHaveLength(1);
    expect(rows[0].pstn).toBe(true);
    expect(rows[0].phone).toBe('8452338546');
    expect(rows[0].leftAt).toBe(9_000); // the rest of the snapshot still applied
  });

  it('orders by joined_at ASC (the getRoster contract)', () => {
    const db = openDb();
    const m = withMeeting(db);
    upsertPresence(db, m.meetingId, [
      att({ id: 'p-late', joinedAt: 3_000 }),
      att({ id: 'p-early', joinedAt: 100 }),
    ]);
    expect(getPresence(db, m.meetingId).map((a) => a.id)).toEqual(['p-early', 'p-late']);
  });

  it('returns [] for a meeting with no stored presence', () => {
    const db = openDb();
    const m = withMeeting(db);
    expect(getPresence(db, m.meetingId)).toEqual([]);
  });

  it('fails LOUD on an unknown meeting_id (FK) and rolls back atomically', () => {
    const db = openDb();
    withMeeting(db); // unrelated meeting so the table is live
    expect(() => upsertPresence(db, 'no-such-meeting', [att()])).toThrow();
    const orphans = db
      .prepare('SELECT COUNT(*) AS n FROM roster_presence WHERE meeting_id = ?')
      .get('no-such-meeting') as unknown as { n: number };
    expect(orphans.n).toBe(0); // ROLLBACK left no partial snapshot
  });

  it('deleteMeeting removes the presence rows in the same transaction', () => {
    const db = openDb();
    const m = withMeeting(db);
    upsertPresence(db, m.meetingId, [att()]);
    deleteMeeting(db, m.meetingId);
    const left = db
      .prepare('SELECT COUNT(*) AS n FROM roster_presence WHERE meeting_id = ?')
      .get(m.meetingId) as unknown as { n: number };
    expect(left.n).toBe(0);
  });

  it('pstn=true and phone survive a full upsert/get round-trip', () => {
    const db = openDb();
    const m = withMeeting(db);
    upsertPresence(db, m.meetingId, [att({ id: 'p-pstn', pstn: true, phone: '8452338546' })]);
    const rows = getPresence(db, m.meetingId);
    expect(rows[0]?.pstn).toBe(true);
    expect(rows[0]?.phone).toBe('8452338546');
  });

  it('non-PSTN attendee: pstn undefined, phone undefined after round-trip', () => {
    const db = openDb();
    const m = withMeeting(db);
    upsertPresence(db, m.meetingId, [att()]);
    const rows = getPresence(db, m.meetingId);
    expect(rows[0]?.pstn).toBeUndefined();
    expect(rows[0]?.phone).toBeUndefined();
  });

  it('in-place migration: pre-PSTN db file (roster_presence without pstn/phone) gains columns on open', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wcms-pstn-'));
    const path = join(dir, 'app.db');
    // Simulate a pre-PSTN db: roster_presence exists but lacks pstn/phone
    const old = new RawDb(path);
    old.exec(`PRAGMA foreign_keys = ON`);
    old.exec(`CREATE TABLE meetings (
      meeting_id TEXT PRIMARY KEY, webex_meeting_id TEXT, sip_uri TEXT NOT NULL,
      title TEXT NOT NULL, scheduled_start INTEGER, scheduled_end INTEGER,
      dtmf TEXT, source TEXT NOT NULL DEFAULT 'manual', created_at INTEGER NOT NULL)`);
    old.exec(`CREATE TABLE roster_presence (
      meeting_id TEXT NOT NULL REFERENCES meetings(meeting_id),
      participant_id TEXT NOT NULL,
      name TEXT NOT NULL, role TEXT NOT NULL, is_host INTEGER NOT NULL,
      joined_at INTEGER NOT NULL, left_at INTEGER, updated_at INTEGER NOT NULL,
      PRIMARY KEY (meeting_id, participant_id))`);
    old.close();

    const db = openDb(path);
    const cols = db.prepare('PRAGMA table_info(roster_presence)').all() as unknown as Array<{ name: string }>;
    expect(cols.some((c) => c.name === 'pstn')).toBe(true);
    expect(cols.some((c) => c.name === 'phone')).toBe(true);
    // Immediately usable for PSTN writes
    const m = withMeeting(db);
    upsertPresence(db, m.meetingId, [att({ pstn: true, phone: '8452338546' })]);
    const rows = getPresence(db, m.meetingId);
    expect(rows[0]?.pstn).toBe(true);
    expect(rows[0]?.phone).toBe('8452338546');
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('in-place migration: opening a PRE-EXISTING db file creates roster_presence', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wcms-presence-'));
    const path = join(dir, 'app.db');
    // Simulate a pre-feature db file: only the old meetings table exists.
    const old = new RawDb(path);
    old.exec(`CREATE TABLE meetings (
      meeting_id TEXT PRIMARY KEY, webex_meeting_id TEXT, sip_uri TEXT NOT NULL,
      title TEXT NOT NULL, scheduled_start INTEGER, scheduled_end INTEGER,
      dtmf TEXT, source TEXT NOT NULL DEFAULT 'manual', created_at INTEGER NOT NULL)`);
    old.close();

    const db = openDb(path); // schema.sql runs on every open → table appears in place
    const t = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='roster_presence'")
      .get();
    expect(t).toBeTruthy();
    const m = withMeeting(db); // and it is immediately usable
    upsertPresence(db, m.meetingId, [att()]);
    expect(getPresence(db, m.meetingId)).toHaveLength(1);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
