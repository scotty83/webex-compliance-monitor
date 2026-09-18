import { describe, it, expect, vi, afterEach } from 'vitest';
import type { WebexParticipant } from './meetingsClient.js';
import type { RosterAttendee } from '../domain/types.js';
import { createRosterMonitor } from './rosterMonitor.js';

afterEach(() => {
  vi.restoreAllMocks();
});

const bot: WebexParticipant = { id: 'p-bot', displayName: 'Compliance Monitor Bot', host: false, state: 'joined', pstn: false };
const fo: WebexParticipant = { id: 'p-fo', displayName: 'Dana Host', email: 'dana@bank.example', host: true, state: 'joined', pstn: false };
const analyst: WebexParticipant = { id: 'p-an', displayName: 'Alex Analyst', email: 'alex@fund.example', host: false, state: 'joined', pstn: false };
const guest: WebexParticipant = { id: 'p-guest', displayName: 'Guest', host: false, state: 'joined', pstn: false };

function harness(opts: {
  timeoutMs?: number;
  gated?: boolean;
  persistRoster?: (meetingId: string, roster: RosterAttendee[]) => void;
} = {}) {
  let clock = 0;
  let participants: WebexParticipant[] | Error = [];
  const solitude: string[] = [];
  const armed: Array<{ fn: () => void; ms: number }> = [];
  const cleared: unknown[] = [];
  const gates: Array<() => void> = []; // gated: polls block in-flight until release()
  const monitor = createRosterMonitor({
    client: {
      listParticipants: async () => {
        if (opts.gated) await new Promise<void>((open) => gates.push(open));
        if (participants instanceof Error) throw participants;
        return participants;
      },
    },
    onSolitude: (id) => solitude.push(id),
    internalEmailDomains: ['bank.example'],
    botDisplayName: 'Compliance Monitor Bot',
    persistRoster: opts.persistRoster,
    pollIntervalMs: 20_000,
    solitudeTimeoutMs: opts.timeoutMs ?? 600_000,
    now: () => clock,
    timers: {
      setInterval: (fn, ms) => { const h = { fn, ms }; armed.push(h); return h; },
      clearInterval: (h) => cleared.push(h),
    },
  });
  return {
    monitor, solitude, armed, cleared,
    advance: (ms: number) => { clock += ms; },
    set: (p: WebexParticipant[] | Error) => { participants = p; },
    /** Unblock the oldest in-flight gated poll (FIFO). */
    release: () => { gates.shift()?.(); },
  };
}

describe('rosterMonitor — diff + classification', () => {
  it('classifies per the authenticated-domain rule and stamps joinedAt', async () => {
    const h = harness();
    h.monitor.startMonitoring('m1', 'wx-1');
    h.set([fo, analyst, guest, bot]);
    h.advance(5);
    await h.monitor.pollNow('m1');
    const roster = h.monitor.getRoster('m1');
    expect(roster.map((a) => [a.id, a.role])).toEqual([
      ['p-fo', 'fo'],        // internal domain
      ['p-an', 'analyst'],   // authenticated, external domain
      ['p-guest', 'other'],  // unauthenticated guest
      ['p-bot', 'bot'],      // BOT_DISPLAY_NAME self-match
    ]);
    expect(roster.every((a) => a.joinedAt === 5 && a.leftAt === null)).toBe(true);
    expect(roster.find((a) => a.id === 'p-fo')?.isHost).toBe(true);
  });

  it('attributes leaves (missing → leftAt: now) and rejoins (same id → leftAt back to null)', async () => {
    const h = harness();
    h.monitor.startMonitoring('m1', 'wx-1');
    h.set([fo, analyst, bot]);
    await h.monitor.pollNow('m1');

    h.set([fo, bot]); // analyst drops
    h.advance(20_000);
    await h.monitor.pollNow('m1');
    expect(h.monitor.getRoster('m1').find((a) => a.id === 'p-an')?.leftAt).toBe(20_000);

    h.set([fo, analyst, bot]); // analyst rejoins with the same participant id
    h.advance(20_000);
    await h.monitor.pollNow('m1');
    const an = h.monitor.getRoster('m1').find((a) => a.id === 'p-an');
    expect(an?.leftAt).toBeNull();
    expect(an?.joinedAt).toBe(0); // original joinedAt preserved
  });

  it('classification precedence: bot name beats internal domain; email-less host is other', async () => {
    const h = harness();
    h.monitor.startMonitoring('m1', 'wx-1');
    h.set([
      // (a) displayName === botDisplayName AND internal-domain email → 'bot' wins
      { id: 'p-bot-int', displayName: 'Compliance Monitor Bot', email: 'bot@bank.example', host: false, state: 'joined', pstn: false },
      // (b) host without any email → unauthenticated → 'other' (hostship is orthogonal)
      { id: 'p-host-noemail', displayName: 'Conference Room', host: true, state: 'joined', pstn: false },
    ]);
    await h.monitor.pollNow('m1');
    const roster = h.monitor.getRoster('m1');
    expect(roster.find((a) => a.id === 'p-bot-int')?.role).toBe('bot');
    const hostEntry = roster.find((a) => a.id === 'p-host-noemail');
    expect(hostEntry?.role).toBe('other');
    expect(hostEntry?.isHost).toBe(true);
  });

  it("participants in 'lobby' or 'end' state are not present (no join stamped)", async () => {
    const h = harness();
    h.monitor.startMonitoring('m1', 'wx-1');
    h.set([{ ...fo, state: 'lobby' }, { ...analyst, state: 'end' }, bot]);
    await h.monitor.pollNow('m1');
    expect(h.monitor.getRoster('m1').map((a) => a.id)).toEqual(['p-bot']);
  });
});

describe('rosterMonitor — solitude', () => {
  it('bot alone accumulating ≥ timeout → onSolitude fires once and monitoring stops', async () => {
    // Suppress the module's intentional solitude LOUD stderr, and verify it fires.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = harness(); // 600_000 ms timeout
    h.monitor.startMonitoring('m1', 'wx-1');
    h.set([bot]);
    await h.monitor.pollNow('m1'); // t=0: alone, accumulator starts at 0
    for (let i = 0; i < 30; i++) {
      h.advance(20_000);
      await h.monitor.pollNow('m1'); // +20 s per successful alone poll
    }
    expect(h.solitude).toEqual(['m1']); // 30 × 20 s = 600 s → fired exactly once
    expect(h.cleared).toHaveLength(1);  // interval cleared (monitoring stopped)
    h.advance(20_000);
    await h.monitor.pollNow('m1'); // no-op — not monitored anymore
    expect(h.solitude).toEqual(['m1']);
    expect(errSpy).toHaveBeenCalledOnce(); // solitude hang-up is intentionally LOUD
  });

  it('a human present at 9m59s resets the timer (spec rejoin case)', async () => {
    // Suppress the module's intentional solitude LOUD stderr, and verify it fires.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = harness();
    h.monitor.startMonitoring('m1', 'wx-1');
    h.set([bot]);
    await h.monitor.pollNow('m1');
    for (let i = 0; i < 29; i++) { // 580 s alone — 20 s short of firing
      h.advance(20_000);
      await h.monitor.pollNow('m1');
    }
    expect(h.solitude).toEqual([]);

    h.set([fo, bot]); // human (re)joins → reset
    h.advance(19_000);
    await h.monitor.pollNow('m1');

    h.set([bot]); // alone again — needs a FULL 600 s from here
    h.advance(20_000);
    await h.monitor.pollNow('m1');
    for (let i = 0; i < 29; i++) {
      h.advance(20_000);
      await h.monitor.pollNow('m1');
    }
    expect(h.solitude).toEqual([]); // 580 s again — still not fired
    h.advance(20_000);
    await h.monitor.pollNow('m1');
    expect(h.solitude).toEqual(['m1']); // 600 s → fired
    expect(errSpy).toHaveBeenCalledOnce(); // LOUD only at the actual hang-up
  });

  it('solitudeTimeoutMs=0 fires on the first alone poll', async () => {
    // Suppress the module's intentional solitude LOUD stderr, and verify it fires.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = harness({ timeoutMs: 0 });
    h.monitor.startMonitoring('m1', 'wx-1');
    h.set([bot]);
    await h.monitor.pollNow('m1');
    expect(h.solitude).toEqual(['m1']);
    expect(errSpy).toHaveBeenCalledOnce();
  });
});

describe('rosterMonitor — overlapping polls (exactly-once solitude)', () => {
  it('a stale in-flight poll after solitude fired is a no-op — onSolitude exactly once', async () => {
    // Suppress the module's intentional solitude LOUD stderr, and verify it fires once.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = harness({ timeoutMs: 0, gated: true });
    h.monitor.startMonitoring('m1', 'wx-1');
    h.set([bot]);
    const first = h.monitor.pollNow('m1');  // in-flight #1
    const second = h.monitor.pollNow('m1'); // in-flight #2 — holds the same MonitorRec
    h.release();
    await first; // alone at timeout 0 → solitude fires, record deleted
    expect(h.solitude).toEqual(['m1']);
    h.advance(20_000);
    h.release();
    await second; // resolves on the orphaned record — must be a no-op
    expect(h.solitude).toEqual(['m1']);     // exactly once
    expect(errSpy).toHaveBeenCalledOnce();  // one LOUD solitude line, not two
  });

  it('a stale in-flight poll cannot mutate the roster after the record was deleted', async () => {
    // Suppress the module's intentional solitude LOUD stderr for this test.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = harness({ timeoutMs: 0, gated: true });
    h.monitor.startMonitoring('m1', 'wx-1');
    h.set([bot]);
    const first = h.monitor.pollNow('m1');
    const second = h.monitor.pollNow('m1');
    h.release();
    await first; // hang-up: monitoring stopped, roster frozen at [bot]
    const frozen = h.monitor.getRoster('m1');
    h.set([fo, bot]); // the stale poll would see a human join
    h.advance(20_000);
    h.release();
    await second;
    expect(h.monitor.getRoster('m1')).toEqual(frozen); // no post-stop mutation
    expect(h.solitude).toEqual(['m1']);
  });

  it('a stale in-flight poll from a previous episode cannot pollute a restarted one', async () => {
    const h = harness({ gated: true });
    h.monitor.startMonitoring('m1', 'wx-1');
    h.set([fo, bot]);
    const stale = h.monitor.pollNow('m1'); // episode 1, in-flight
    h.monitor.stopMonitoring('m1');
    h.monitor.startMonitoring('m1', 'wx-1'); // episode 2 — fresh roster, new record
    h.release();
    await stale; // the record was REPLACED mid-flight — must be a no-op
    expect(h.monitor.getRoster('m1')).toEqual([]); // episode-2 roster untouched
  });
});

describe('rosterMonitor — poll failures (keep-last-good, blind, frozen timer)', () => {
  it('keeps the last-good roster; isBlind() after 3 consecutive failures; recovery resets', async () => {
    // Suppress the module's intentional blind LOUD stderr, and verify it fires.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = harness();
    h.monitor.startMonitoring('m1', 'wx-1');
    h.set([fo, bot]);
    await h.monitor.pollNow('m1');

    h.set(new Error('poll down'));
    await h.monitor.pollNow('m1');
    await h.monitor.pollNow('m1');
    expect(h.monitor.isBlind()).toBe(false); // 2 misses — not blind yet
    await h.monitor.pollNow('m1');
    expect(h.monitor.isBlind()).toBe(true);  // 3rd consecutive miss — loud + blind
    expect(errSpy).toHaveBeenCalledOnce();   // LOUD exactly at the blind threshold
    expect(h.monitor.getRoster('m1')).toHaveLength(2); // last-good kept

    h.set([fo, bot]);
    await h.monitor.pollNow('m1');
    expect(h.monitor.isBlind()).toBe(false); // success resets the failure count
  });

  it('a definitive 404 (meeting gone) concludes the meeting instead of freezing blind', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = harness();
    h.monitor.startMonitoring('m1', 'wx-1');
    h.set([fo, bot]);
    await h.monitor.pollNow('m1'); // last-good roster established

    const gone = Object.assign(new Error('meeting not found'), { status: 404 });
    h.set(gone);
    await h.monitor.pollNow('m1');

    expect(h.solitude).toEqual(['m1']);        // concluded, not frozen
    expect(h.cleared).toHaveLength(1);          // interval stopped
    expect(h.monitor.isBlind()).toBe(false);    // NOT counted as a blind miss
    expect(errSpy.mock.calls.some((c) => String(c[0]).includes('gone'))).toBe(true); // LOUD
  });

  it('the solitude timer FREEZES while blind — blind wall-clock time never counts', async () => {
    // Suppress the module's intentional solitude LOUD stderr, and verify it fires.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = harness();
    h.monitor.startMonitoring('m1', 'wx-1');
    h.set([bot]);
    await h.monitor.pollNow('m1'); // t=0, alone, aloneMs=0
    for (let i = 0; i < 10; i++) {
      h.advance(20_000);
      await h.monitor.pollNow('m1'); // aloneMs = 200_000
    }

    h.set(new Error('poll down'));
    h.advance(500_000); // 500 s of BLINDNESS — must not count
    await h.monitor.pollNow('m1');
    h.advance(500_000);
    await h.monitor.pollNow('m1');

    h.set([bot]); // recovery: still alone
    h.advance(20_000);
    await h.monitor.pollNow('m1'); // anchor was cleared → blind gap NOT added
    expect(h.solitude).toEqual([]); // naive impl would have fired long ago

    // Still needs the remaining 400 s of OBSERVED alone time.
    for (let i = 0; i < 19; i++) {
      h.advance(20_000);
      await h.monitor.pollNow('m1');
    }
    expect(h.solitude).toEqual([]); // 200k + 380k = 580k — not yet
    h.advance(20_000);
    await h.monitor.pollNow('m1');
    expect(h.solitude).toEqual(['m1']); // 600k observed → fires
    expect(errSpy).toHaveBeenCalledOnce(); // solitude LOUD only (2 misses — no blind LOUD)
  });
});

describe('rosterMonitor — lifecycle + timers seam', () => {
  it('startMonitoring arms the poll interval; duplicate start is a no-op; stop clears; roster survives stop', async () => {
    const h = harness();
    h.monitor.startMonitoring('m1', 'wx-1');
    h.monitor.startMonitoring('m1', 'wx-1'); // duplicate
    expect(h.armed).toHaveLength(1);
    expect(h.armed[0].ms).toBe(20_000);

    h.set([fo, bot]);
    await h.monitor.pollNow('m1');
    h.monitor.stopMonitoring('m1');
    expect(h.cleared).toHaveLength(1);
    expect(h.monitor.getRoster('m1')).toHaveLength(2); // keep-last-good after stop

    h.monitor.startMonitoring('m2', 'wx-2');
    h.monitor.stopAll();
    expect(h.cleared).toHaveLength(2);
  });

  it('evictRoster drops the last-known roster (deregister); stopMonitoring alone keeps it', async () => {
    const h = harness();
    h.monitor.startMonitoring('m1', 'wx-1');
    h.set([fo, bot]);
    await h.monitor.pollNow('m1');

    h.monitor.stopMonitoring('m1');
    // Contract: last-known roster survives bot terminal states (meeting row
    // still exists — GET /meetings/:id keeps serving it) ...
    expect(h.monitor.getRoster('m1')).toHaveLength(2);

    // ... and is dropped only on deregister (composition calls evictRoster).
    h.monitor.evictRoster('m1');
    expect(h.monitor.getRoster('m1')).toEqual([]);
    h.monitor.evictRoster('m1'); // idempotent — absent key is a no-op
    expect(h.monitor.getRoster('m1')).toEqual([]);
  });

  it('stopMonitoring stamps leftAt on still-present entries — an ended meeting reads 0 on call', async () => {
    const h = harness()
    h.monitor.startMonitoring('m1', 'wx-1')
    h.set([fo, bot]) // both present, leftAt null
    await h.monitor.pollNow('m1')
    expect(h.monitor.getRoster('m1').filter((a) => a.leftAt === null)).toHaveLength(2)

    h.monitor.stopMonitoring('m1') // meeting ends
    const roster = h.monitor.getRoster('m1')
    expect(roster).toHaveLength(2) // history preserved
    // nobody still "on call" — the bot no longer lingers as a phantom straggler
    expect(roster.filter((a) => a.leftAt === null)).toHaveLength(0)
    for (const a of roster) expect(typeof a.leftAt).toBe('number')
  })

  it('getRoster returns [] for an unknown meeting; pollNow on unknown meeting is a no-op', async () => {
    const h = harness();
    expect(h.monitor.getRoster('nope')).toEqual([]);
    await expect(h.monitor.pollNow('nope')).resolves.toBeUndefined();
  });
});

describe('rosterMonitor — PSTN caller-id propagation', () => {
  it('pstn and phone flow from WebexParticipant into the roster entry', async () => {
    const h = harness();
    h.monitor.startMonitoring('m1', 'wx-1');
    const pstnParticipant: WebexParticipant = {
      id: 'p-pstn', displayName: '8452****46', host: false, state: 'joined',
      pstn: true, phone: '8452338546',
    };
    h.set([pstnParticipant]);
    h.advance(5);
    await h.monitor.pollNow('m1');
    const entry = h.monitor.getRoster('m1').find((a) => a.id === 'p-pstn');
    expect(entry?.pstn).toBe(true);
    expect(entry?.phone).toBe('8452338546');
  });

  it('late-arriving phone updates an existing entry; never downgrades to undefined', async () => {
    const h = harness();
    h.monitor.startMonitoring('m1', 'wx-1');
    // First poll: no phone yet
    const noPhone: WebexParticipant = {
      id: 'p-pstn', displayName: '8452****46', host: false, state: 'joined',
      pstn: true, phone: undefined,
    };
    h.set([noPhone]);
    await h.monitor.pollNow('m1');
    expect(h.monitor.getRoster('m1')[0]?.phone).toBeUndefined();

    // Second poll: phone arrives
    const withPhone: WebexParticipant = {
      id: 'p-pstn', displayName: '8452****46', host: false, state: 'joined',
      pstn: true, phone: '8452338546',
    };
    h.set([withPhone]);
    h.advance(5_000);
    await h.monitor.pollNow('m1');
    expect(h.monitor.getRoster('m1')[0]?.phone).toBe('8452338546');

    // Third poll: phone absent again — should NOT downgrade
    h.set([noPhone]);
    h.advance(5_000);
    await h.monitor.pollNow('m1');
    expect(h.monitor.getRoster('m1')[0]?.phone).toBe('8452338546');
  });
});

describe('rosterMonitor — presence persistence (ended-meeting history)', () => {
  it('persists the full post-diff snapshot on every successful poll (leaves included)', async () => {
    const writes: Array<{ id: string; roster: RosterAttendee[] }> = [];
    const h = harness({ persistRoster: (id, roster) => writes.push({ id, roster }) });
    h.monitor.startMonitoring('m1', 'wx-1');
    h.set([fo, analyst, bot]);
    await h.monitor.pollNow('m1');
    expect(writes).toHaveLength(1);
    expect(writes[0].id).toBe('m1');
    expect(writes[0].roster.map((a) => a.id)).toEqual(['p-fo', 'p-an', 'p-bot']);
    expect(writes[0].roster.every((a) => a.leftAt === null)).toBe(true);

    h.set([fo, bot]); // analyst drops → the persisted snapshot records the leave
    h.advance(20_000);
    await h.monitor.pollNow('m1');
    expect(writes).toHaveLength(2);
    expect(writes[1].roster.find((a) => a.id === 'p-an')?.leftAt).toBe(20_000);
  });

  it('does not persist on a failed poll (keep-last-good — no stale write)', async () => {
    const writes: unknown[] = [];
    const h = harness({ persistRoster: () => writes.push(1) });
    h.monitor.startMonitoring('m1', 'wx-1');
    h.set(new Error('webex down'));
    await h.monitor.pollNow('m1');
    expect(writes).toHaveLength(0);
  });

  it('a throwing persist sink is caught LOUD and the in-memory roster still updates', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = harness({ persistRoster: () => { throw new Error('disk full'); } });
    h.monitor.startMonitoring('m1', 'wx-1');
    h.set([fo, bot]);
    await expect(h.monitor.pollNow('m1')).resolves.toBeUndefined();
    expect(h.monitor.getRoster('m1').map((a) => a.id)).toEqual(['p-fo', 'p-bot']);
    expect(
      errSpy.mock.calls.some((c) => String(c[0]).includes('presence persist failed')),
      'expected the LOUD persist-failure line on console.error',
    ).toBe(true);
  });

  it('stopMonitoring persists the final leftAt-stamped roster — terminal state lands in DB', async () => {
    const writes: Array<{ id: string; roster: RosterAttendee[] }> = [];
    const h = harness({ persistRoster: (id, roster) => writes.push({ id, roster }) });
    h.monitor.startMonitoring('m1', 'wx-1');
    h.set([fo, bot]);
    await h.monitor.pollNow('m1'); // writes[0]: both present, leftAt null
    expect(writes).toHaveLength(1);

    h.monitor.stopMonitoring('m1'); // should persist the leftAt-stamped final roster
    expect(writes).toHaveLength(2);
    expect(writes[1].id).toBe('m1');
    // everyone stamped leftAt — nobody lingering as "on call"
    expect(writes[1].roster.every((a) => a.leftAt !== null)).toBe(true);
  });

  it('a throwing persist sink in stopMonitoring is caught LOUD — stopMonitoring still completes', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let calls = 0;
    const h = harness({
      persistRoster: () => {
        calls += 1;
        if (calls > 1) throw new Error('disk full'); // second call (from stop) throws
      },
    });
    h.monitor.startMonitoring('m1', 'wx-1');
    h.set([fo, bot]);
    await h.monitor.pollNow('m1'); // calls=1, succeeds
    h.monitor.stopMonitoring('m1'); // calls=2, throws → must be caught
    // monitoring fully stopped — stamps applied, no exception escapes
    expect(h.monitor.getRoster('m1').every((a) => a.leftAt !== null)).toBe(true);
    expect(
      errSpy.mock.calls.some((c) => String(c[0]).includes('presence persist failed (stop)')),
    ).toBe(true);
  });

  it('the final pre-solitude snapshot is persisted before the hang-up fires', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {}); // solitude is LOUD
    const writes: Array<{ roster: RosterAttendee[] }> = [];
    const h = harness({ timeoutMs: 0, persistRoster: (_id, roster) => writes.push({ roster }) });
    h.monitor.startMonitoring('m1', 'wx-1');
    h.set([fo, bot]);
    await h.monitor.pollNow('m1');
    h.set([bot]); // last human leaves → alone poll → solitude fires (timeout 0)
    h.advance(20_000);
    await h.monitor.pollNow('m1');
    expect(h.solitude).toEqual(['m1']);
    const last = writes.at(-1);
    expect(last?.roster.find((a) => a.id === 'p-fo')?.leftAt).toBe(20_000);
    expect(errSpy.mock.calls.some((c) => String(c[0]).includes('solitude'))).toBe(true);
  });
});
