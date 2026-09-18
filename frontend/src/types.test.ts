import { describe, it, expect } from 'vitest';
import { toMeeting } from './types';
import type { ChaperonedMeeting, BotStatus } from './types';
import { mockRosterFor } from './mock/roster';

// --- fixtures ---

const BASE_MEETING: ChaperonedMeeting = {
  meetingId: 'mtg-001',
  sipUri: 'sip:test@example.com',
  title: 'Q3 Risk Review',
  createdAt: 1_700_000_000_000,
};

const BOT_STATUS: BotStatus = {
  meetingId: 'mtg-001',
  state: 'connected',
  joinedAt: 1_700_000_060_000,
  lastError: undefined,
  updatedAt: 1_700_000_090_000,
};

const MOCK_DATA = {
  org: 'Meridian Capital Research',
  attendees: [
    {
      id: 'a1',
      name: 'Marcus Delacroix',
      role: 'fo' as const,
      isHost: true,
      joinedAt: 1_700_000_010_000,
      leftAt: null,
    },
    {
      id: 'a2',
      name: 'Compliance Monitor Bot',
      role: 'bot' as const,
      isHost: false,
      joinedAt: 1_700_000_060_000,
      leftAt: null,
    },
  ],
};

// --- toMeeting mapper ---

describe('toMeeting', () => {
  it('maps id from meetingId', () => {
    const result = toMeeting({ ...BASE_MEETING, bot: BOT_STATUS }, MOCK_DATA);
    expect(result.id).toBe('mtg-001');
  });

  it('maps botState from bot.state', () => {
    const result = toMeeting({ ...BASE_MEETING, bot: BOT_STATUS }, MOCK_DATA);
    expect(result.botState).toBe('connected');
  });

  it('maps startedAt from bot.joinedAt', () => {
    const result = toMeeting({ ...BASE_MEETING, bot: BOT_STATUS }, MOCK_DATA);
    expect(result.startedAt).toBe(1_700_000_060_000);
  });

  it('falls back startedAt to createdAt when bot.joinedAt is absent', () => {
    const botNoJoin: BotStatus = { ...BOT_STATUS, joinedAt: undefined };
    const result = toMeeting({ ...BASE_MEETING, bot: botNoJoin }, MOCK_DATA);
    expect(result.startedAt).toBe(1_700_000_000_000);
  });

  it('attaches org and attendees from mock', () => {
    const result = toMeeting({ ...BASE_MEETING, bot: BOT_STATUS }, MOCK_DATA);
    expect(result.org).toBe('Meridian Capital Research');
    expect(result.attendees).toStrictEqual(MOCK_DATA.attendees);
  });

  it('passes lastError through when present', () => {
    const botErr: BotStatus = { ...BOT_STATUS, lastError: 'SIP timeout' };
    const result = toMeeting({ ...BASE_MEETING, bot: botErr }, MOCK_DATA);
    expect(result.lastError).toBe('SIP timeout');
  });

  it('does NOT include dtmf on the result', () => {
    const meetingWithDtmf = { ...BASE_MEETING, dtmf: 'secret123', bot: BOT_STATUS };
    const result = toMeeting(meetingWithDtmf, MOCK_DATA);
    expect(result).not.toHaveProperty('dtmf');
  });

  // bot: null cases
  it('maps botState to idle when bot is null', () => {
    const result = toMeeting({ ...BASE_MEETING, bot: null }, MOCK_DATA);
    expect(result.botState).toBe('idle');
  });

  it('maps startedAt to createdAt when bot is null', () => {
    const result = toMeeting({ ...BASE_MEETING, bot: null }, MOCK_DATA);
    expect(result.startedAt).toBe(1_700_000_000_000);
  });

  it('does not set lastError when bot is null', () => {
    const result = toMeeting({ ...BASE_MEETING, bot: null }, MOCK_DATA);
    expect(result.lastError).toBeUndefined();
  });
});

// --- mockRosterFor ---

describe('mockRosterFor', () => {
  it('is deterministic: same meetingId produces deep-equal results across two calls', () => {
    const a = mockRosterFor(BASE_MEETING);
    const b = mockRosterFor(BASE_MEETING);
    expect(a).toStrictEqual(b);
  });

  it('produces different results for different meetingIds', () => {
    const a = mockRosterFor(BASE_MEETING);
    const b = mockRosterFor({ ...BASE_MEETING, meetingId: 'mtg-999' });
    // At minimum the attendee ids will differ
    expect(a.attendees[0].id).not.toBe(b.attendees[0].id);
  });

  it('includes exactly one host', () => {
    const { attendees } = mockRosterFor(BASE_MEETING);
    expect(attendees.filter(a => a.isHost)).toHaveLength(1);
  });

  it('includes exactly one bot attendee', () => {
    const { attendees } = mockRosterFor(BASE_MEETING);
    expect(attendees.filter(a => a.role === 'bot')).toHaveLength(1);
  });

  it('returns a non-empty org string', () => {
    const { org } = mockRosterFor(BASE_MEETING);
    expect(typeof org).toBe('string');
    expect(org.length).toBeGreaterThan(0);
  });

  it('all attendees have required fields', () => {
    const { attendees } = mockRosterFor(BASE_MEETING);
    for (const a of attendees) {
      expect(typeof a.id).toBe('string');
      expect(typeof a.name).toBe('string');
      expect(['analyst', 'fo', 'bot', 'other']).toContain(a.role);
      expect(typeof a.isHost).toBe('boolean');
      expect(typeof a.joinedAt).toBe('number');
      expect(a.leftAt === null || typeof a.leftAt === 'number').toBe(true);
    }
  });
});

describe('toMeeting — endedAt (ended-meeting history)', () => {
  const base = { meetingId: 'm1', sipUri: 's@x.webex.com', title: 'T', createdAt: 1_000 }
  const noMock = { org: '', attendees: [] }

  it('maps bot.updatedAt to endedAt for every terminal state', () => {
    for (const state of ['ended', 'failed', 'disconnected'] as const) {
      const m = toMeeting({ ...base, bot: { meetingId: 'm1', state, updatedAt: 9_000 } }, noMock)
      expect(m.endedAt).toBe(9_000)
    }
  })

  it('leaves endedAt undefined for live states and missing bot', () => {
    const live = toMeeting(
      { ...base, bot: { meetingId: 'm1', state: 'connected', joinedAt: 2_000, updatedAt: 9_000 } },
      noMock,
    )
    expect(live.endedAt).toBeUndefined()
    expect(toMeeting({ ...base, bot: null }, noMock).endedAt).toBeUndefined()
  })
})

describe('toMeeting — rosterSource/rosterError passthrough (additive)', () => {
  const raw = {
    meetingId: 'm1',
    sipUri: 's@x.webex.com',
    title: 'T',
    createdAt: 10,
    bot: { meetingId: 'm1', state: 'failed' as const, lastError: 'SIP 488', updatedAt: 20 },
  }
  it('carries both through', () => {
    const m = toMeeting(raw, { org: '', attendees: [], rosterSource: 'peek', rosterError: 'x' })
    expect(m.rosterSource).toBe('peek')
    expect(m.rosterError).toBe('x')
  })
  it('absent stays undefined (mock/back-compat)', () => {
    const m = toMeeting(raw, { org: '', attendees: [] })
    expect(m.rosterSource).toBeUndefined()
    expect(m.rosterError).toBeUndefined()
  })
})
