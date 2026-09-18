import { describe, it, expect, vi } from 'vitest';
import { createRosterPeek } from './rosterPeek.js';
import type { WebexParticipant } from './meetingsClient.js';

const RULES = { internalEmailDomains: ['bank.example'], botDisplayName: 'Compliance Bot' };

function participant(over: Partial<WebexParticipant> = {}): WebexParticipant {
  return { id: 'p1', displayName: 'Ana Lyst', email: 'ana@fund.example', host: false, state: 'joined', pstn: false, ...over };
}

function harness(participants: WebexParticipant[] | Error, opts: { ttlMs?: number } = {}) {
  let t = 1_000_000;
  const listParticipants = vi.fn(async (_webexMeetingId: string) => {
    if (participants instanceof Error) throw participants;
    return participants;
  });
  const peek = createRosterPeek({
    client: { listParticipants },
    ...RULES,
    ttlMs: opts.ttlMs ?? 20_000,
    now: () => t,
  });
  return { peek, listParticipants, advance: (ms: number) => { t += ms; }, nowValue: () => t };
}

describe('createRosterPeek', () => {
  it('maps joined participants to RosterAttendee with classification', async () => {
    const { peek, nowValue } = harness([
      participant(),
      participant({ id: 'p2', displayName: 'Fred Officer', email: 'FRED@Bank.Example', host: true }),
      participant({ id: 'p3', displayName: 'Compliance Bot' }),
      participant({ id: 'p4', displayName: 'Guest', email: undefined }),
    ]);
    const roster = await peek.peek('wx-1');
    expect(roster).toEqual([
      { id: 'p1', name: 'Ana Lyst',     role: 'analyst', isHost: false, joinedAt: nowValue(), leftAt: null },
      { id: 'p2', name: 'Fred Officer', role: 'fo',      isHost: true,  joinedAt: nowValue(), leftAt: null },
      { id: 'p3', name: 'Compliance Bot',      role: 'bot',     isHost: false, joinedAt: nowValue(), leftAt: null },
      { id: 'p4', name: 'Guest',        role: 'other',   isHost: false, joinedAt: nowValue(), leftAt: null },
    ]);
  });

  it('drops lobby/end participants — a peek is a presence snapshot', async () => {
    const { peek } = harness([
      participant(),
      participant({ id: 'p2', state: 'lobby' }),
      participant({ id: 'p3', state: 'end' }),
    ]);
    expect((await peek.peek('wx-1')).map((a) => a.id)).toEqual(['p1']);
  });

  it('TTL: a second peek inside the window is served from cache (no client call)', async () => {
    const { peek, listParticipants, advance } = harness([participant()]);
    await peek.peek('wx-1');
    advance(5_000);
    await peek.peek('wx-1');
    expect(listParticipants).toHaveBeenCalledTimes(1);
    advance(20_001); // beyond ttl from the original fetch
    await peek.peek('wx-1');
    expect(listParticipants).toHaveBeenCalledTimes(2);
  });

  it('joinedAt is STABLE across refetches (first-seen retained)', async () => {
    const { peek, advance } = harness([participant()]);
    const first = await peek.peek('wx-1');
    advance(60_000); // > ttl, < sweep
    const second = await peek.peek('wx-1');
    expect(second[0]!.joinedAt).toBe(first[0]!.joinedAt);
  });

  it('idle entries are swept after 15 min — first-seen resets (bounded memory)', async () => {
    const { peek, advance } = harness([participant()]);
    const first = await peek.peek('wx-1');
    advance(16 * 60_000);
    const second = await peek.peek('wx-1');
    expect(second[0]!.joinedAt).not.toBe(first[0]!.joinedAt);
  });

  it('pstn and phone from WebexParticipant appear in the RosterAttendee', async () => {
    const pstnP: WebexParticipant = {
      id: 'p-pstn', displayName: '8452****46', host: false, state: 'joined',
      pstn: true, phone: '8452338546',
    };
    const { peek } = harness([pstnP]);
    const roster = await peek.peek('wx-1');
    expect(roster[0]?.pstn).toBe(true);
    expect(roster[0]?.phone).toBe('8452338546');
  });

  it('client failure rejects (fail-LOUD) — no stale success is fabricated', async () => {
    const { peek } = harness(new Error('Webex API error 502 for /meetingParticipants'));
    await expect(peek.peek('wx-1')).rejects.toThrow(/502/);
  });

  it('returned rosters are copies — callers cannot mutate the cache', async () => {
    const { peek } = harness([participant()]);
    const a = await peek.peek('wx-1');
    a[0]!.name = 'MUTATED';
    const b = await peek.peek('wx-1'); // cache hit
    expect(b[0]!.name).toBe('Ana Lyst');
  });
});
