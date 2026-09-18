import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { openDb, type DB } from '../src/db/index.js';
import { getServiceRefreshToken, saveServiceRefreshToken } from '../src/db/serviceTokens.js';
import { insertMeeting, getMeeting, getMeetingByWebexId, listMeetings } from '../src/db/meetings.js';

describe('service_tokens persistence', () => {
  let db: DB;
  beforeEach(() => { db = openDb(); });

  it('returns undefined when the table is empty (bootstrap case)', () => {
    expect(getServiceRefreshToken(db)).toBeUndefined();
  });

  it('saves and round-trips the rotated refresh token', () => {
    saveServiceRefreshToken(db, 'rt-1', 1111);
    expect(getServiceRefreshToken(db)).toEqual({ refreshToken: 'rt-1', rotatedAt: 1111 });
  });

  it('is a single row — a second save replaces the first (rotation)', () => {
    saveServiceRefreshToken(db, 'rt-1', 1111);
    saveServiceRefreshToken(db, 'rt-2', 2222);
    expect(getServiceRefreshToken(db)).toEqual({ refreshToken: 'rt-2', rotatedAt: 2222 });
    const rows = db.prepare('SELECT COUNT(*) AS n FROM service_tokens').get() as { n: number };
    expect(rows.n).toBe(1);
  });
});

describe('meetings.source + getMeetingByWebexId', () => {
  let db: DB;
  beforeEach(() => { db = openDb(); });

  it("defaults source to 'manual' when not given", () => {
    const m = insertMeeting(db, { sipUri: '1@s.webex.com', title: 'A' });
    expect(getMeeting(db, m.meetingId)?.source).toBe('manual');
  });

  it("round-trips source 'calendar'", () => {
    const m = insertMeeting(db, {
      sipUri: '2@s.webex.com', title: 'B', webexMeetingId: 'wx-1', source: 'calendar',
    });
    expect(getMeeting(db, m.meetingId)?.source).toBe('calendar');
  });

  it('getMeetingByWebexId finds by webex id and misses cleanly', () => {
    insertMeeting(db, { sipUri: '3@s.webex.com', title: 'C', webexMeetingId: 'wx-9' });
    expect(getMeetingByWebexId(db, 'wx-9')?.title).toBe('C');
    expect(getMeetingByWebexId(db, 'wx-nope')).toBeUndefined();
    expect(listMeetings(db)).toHaveLength(1);
  });
});

describe('openDb migration — pre-Plan-07 db file gains meetings.source', () => {
  it('ALTERs an existing meetings table in place', () => {
    // Build an OLD-schema db file directly (CREATE TABLE IF NOT EXISTS in
    // schema.sql will NOT add columns to an existing table — the openDb
    // migration guard must).
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
      DatabaseSync: new (path: string) => { exec(sql: string): void; close(): void };
    };
    const dir = mkdtempSync(join(tmpdir(), 'wcms-mig-'));
    const path = join(dir, 'old.db');
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE meetings (
      meeting_id TEXT PRIMARY KEY, webex_meeting_id TEXT, sip_uri TEXT NOT NULL,
      title TEXT NOT NULL, scheduled_start INTEGER, scheduled_end INTEGER,
      dtmf TEXT, created_at INTEGER NOT NULL)`);
    old.exec(`INSERT INTO meetings (meeting_id, sip_uri, title, created_at)
              VALUES ('m-old', '1@s.webex.com', 'Old', 1)`);
    old.close();

    const db = openDb(path);
    expect(getMeeting(db, 'm-old')?.source).toBe('manual');
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
