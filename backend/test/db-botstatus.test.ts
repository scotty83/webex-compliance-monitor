import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db/index.js';
import { insertMeeting } from '../src/db/meetings.js';
import { upsertBotStatus, getBotStatus } from '../src/db/botStatus.js';

describe('bot_status data-access', () => {
  it('returns an idle default when no row exists', () => {
    const db = openDb();
    const s = getBotStatus(db, 'nope');
    expect(s.state).toBe('idle');
    expect(s.meetingId).toBe('nope');
    expect(s.updatedAt).toBeGreaterThan(0);
  });

  it('upserts and reads back, then updates on conflict', () => {
    const db = openDb();
    const m = insertMeeting(db, { sipUri: '1@s.webex.com', title: 'A' });
    upsertBotStatus(db, { meetingId: m.meetingId, state: 'dialing', updatedAt: 10 });
    expect(getBotStatus(db, m.meetingId).state).toBe('dialing');
    upsertBotStatus(db, { meetingId: m.meetingId, state: 'failed', lastError: 'no SIP', updatedAt: 20 });
    const s = getBotStatus(db, m.meetingId);
    expect(s.state).toBe('failed');
    expect(s.lastError).toBe('no SIP');
    expect(s.updatedAt).toBe(20);
  });
});
