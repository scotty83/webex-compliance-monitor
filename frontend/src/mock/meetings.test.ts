import { describe, expect, it } from 'vitest';
import { mockGetMeetings, mockGetMeeting, mockGetUpcomingMeetings } from './meetings';
import { toMeeting } from '../types';
import { mockRosterFor } from './roster';

describe('mock/meetings (dev mock data)', () => {
  it('returns rows that cover every overview card state, incl. fail-LOUD ones', async () => {
    const rows = await mockGetMeetings();
    expect(rows.length).toBeGreaterThanOrEqual(5);

    const states = new Set(rows.map((r) => r.bot?.state ?? 'idle'));
    for (const required of ['connected', 'dialing', 'failed', 'disconnected', 'idle']) {
      expect(states).toContain(required);
    }

    // fail-LOUD rows must carry a lastError so the UI has detail to surface
    for (const r of rows) {
      if (r.bot?.state === 'failed' || r.bot?.state === 'disconnected') {
        expect(r.bot.lastError).toBeTruthy();
      }
    }
  });

  it('rows are wire-shaped: they map through toMeeting and never carry dtmf', async () => {
    const rows = await mockGetMeetings();
    for (const r of rows) {
      expect(r).not.toHaveProperty('dtmf');
      const m = toMeeting(r, mockRosterFor(r));
      expect(m.id).toBe(r.meetingId);
      expect(m.title).toBe(r.title);
      expect(m.startedAt).toBeGreaterThan(0);
      expect(m.attendees.length).toBeGreaterThan(0);
    }
  });

  it('mockGetMeeting returns the contract detail shape (roster stub [])', async () => {
    const rows = await mockGetMeetings();
    const first = rows[0];
    const detail = await mockGetMeeting(first.meetingId);
    expect(detail.meeting.meetingId).toBe(first.meetingId);
    expect(detail.roster).toEqual([]);
    await expect(mockGetMeeting('nope')).rejects.toMatchObject({ status: 404 });
  });
});

describe('mock upcoming meetings (VITE_MOCK stand-in for GET /meetings/upcoming)', () => {
  const MIN = 60_000;

  it('returns 3 rows starting ~10m / ~45m / ~2h30m from module-load NOW, ascending', async () => {
    const rows = await mockGetUpcomingMeetings();
    expect(rows).toHaveLength(3);

    // NOW is anchored at module load; the test runs moments later, so offsets
    // are bounded above by the seeded value and loosely bounded below.
    const now = Date.now();
    const offsets = rows.map((r) => r.scheduledStart - now);
    expect(offsets[0]).toBeGreaterThan(5 * MIN);
    expect(offsets[0]).toBeLessThanOrEqual(10 * MIN);
    expect(offsets[1]).toBeGreaterThan(40 * MIN);
    expect(offsets[1]).toBeLessThanOrEqual(45 * MIN);
    expect(offsets[2]).toBeGreaterThan(145 * MIN);
    expect(offsets[2]).toBeLessThanOrEqual(150 * MIN);
  });

  it('rows carry required fields and never dtmf', async () => {
    const rows = await mockGetUpcomingMeetings();
    for (const r of rows) {
      expect(r).not.toHaveProperty('dtmf');
      expect(r.meetingId).toBeTruthy();
      expect(r.title).toBeTruthy();
      expect(typeof r.scheduledStart).toBe('number');
    }
  });
});
