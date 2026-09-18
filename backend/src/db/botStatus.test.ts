import { describe, it, expect } from 'vitest';
import { openDb } from './index.js';
import { insertMeeting } from './meetings.js';
import { upsertBotStatus, getBotStatus, reconcileStaleBotStatus } from './botStatus.js';
import type { BotState } from '../domain/types.js';

/** Seed a meeting (its bot_status FK parent) + a bot_status row in `state`.
 *  Returns the generated meetingId so the assertion can read it back. */
function seedBot(db: ReturnType<typeof openDb>, state: BotState, updatedAt = 1000): string {
  const m = insertMeeting(db, { sipUri: `${state}@site.webex.com`, title: `m-${state}` });
  upsertBotStatus(db, { meetingId: m.meetingId, state, joinedAt: 500, updatedAt });
  return m.meetingId;
}

describe('reconcileStaleBotStatus', () => {
  it('flips connected + dialing to disconnected, leaves terminal/idle rows untouched, returns the count', () => {
    const db = openDb(':memory:');
    const states: BotState[] = ['connected', 'dialing', 'ended', 'failed', 'disconnected', 'idle'];
    const ids = Object.fromEntries(states.map((s) => [s, seedBot(db, s)])) as Record<BotState, string>;

    const NOW = 9_999;
    const reconciled = reconcileStaleBotStatus(db, NOW);

    // Only the two non-terminal (implies-a-live-process) states are stale, and
    // the helper returns exactly those meetingIds (so the caller can audit each).
    expect(new Set(reconciled)).toEqual(new Set([ids.connected, ids.dialing]));
    for (const s of ['connected', 'dialing'] as BotState[]) {
      const b = getBotStatus(db, ids[s]);
      expect(b.state).toBe('disconnected');
      expect(b.lastError).toMatch(/restart/i);
      expect(b.updatedAt).toBe(NOW);
    }

    // Terminal states + idle are preserved exactly (state AND updatedAt).
    for (const s of ['ended', 'failed', 'disconnected', 'idle'] as BotState[]) {
      const b = getBotStatus(db, ids[s]);
      expect(b.state).toBe(s);
      expect(b.updatedAt).toBe(1000);
    }

    db.close();
  });

  it('is a no-op returning [] when nothing is connected/dialing', () => {
    const db = openDb(':memory:');
    seedBot(db, 'ended');
    seedBot(db, 'idle');
    expect(reconcileStaleBotStatus(db, 1)).toEqual([]);
    db.close();
  });
});
