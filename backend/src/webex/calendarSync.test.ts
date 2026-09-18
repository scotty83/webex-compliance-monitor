import { describe, it, expect, vi } from 'vitest';
import { openDb } from '../db/index.js';
import { insertMeeting, deleteMeeting, getMeetingByWebexId, listMeetings } from '../db/meetings.js';
import type { AuditEntry, BotStatus, ChaperonedMeeting } from '../domain/types.js';
import type { WebexMeeting } from './meetingsClient.js';
import { createCalendarSync, NO_SIP_ERROR } from './calendarSync.js';

const T0 = 1_000_000_000;

function wxMeeting(over: Partial<WebexMeeting> = {}): WebexMeeting {
  return {
    id: 'wx-1',
    title: 'Analyst call',
    start: T0 + 10_000,
    end: T0 + 3_600_000,
    sipAddress: '777@site.webex.example',
    password: '4321',
    ...over,
  };
}

function harness() {
  const db = openDb();
  const registered: ChaperonedMeeting[] = [];
  const statuses: BotStatus[] = [];
  const audits: AuditEntry[] = [];
  let clock = T0;
  let items: WebexMeeting[] = [];
  let failSync = false;
  const windows: Array<{ from: number; to: number }> = [];
  const sync = createCalendarSync({
    client: {
      listUpcomingMeetings: async (w) => {
        windows.push(w);
        if (failSync) throw new Error('api down');
        return items;
      },
    },
    db,
    onRegister: (m) => registered.push(m),
    upsertBotStatus: (s) => statuses.push(s),
    writeAudit: (e) => audits.push(e),
    syncIntervalMs: 300_000,
    windowMs: 24 * 3_600_000,
    now: () => clock,
    newId: () => 'aud-x',
  });
  return {
    db, sync, registered, statuses, audits, windows,
    advance: (ms: number) => { clock += ms; },
    setItems: (m: WebexMeeting[]) => { items = m; },
    setFail: (f: boolean) => { failSync = f; },
  };
}

describe('calendarSync — cache + getUpcoming', () => {
  it('caches the poll window and serves the console UpcomingMeeting shape, future-only', async () => {
    const h = harness();
    h.setItems([
      wxMeeting({ id: 'wx-future', start: T0 + 600_000 }),
      wxMeeting({ id: 'wx-started', start: T0 - 60_000 }), // in progress → not "upcoming"
    ]);
    await h.sync.syncNow();
    expect(h.windows[0]).toEqual({ from: T0 - 3_600_000, to: T0 + 24 * 3_600_000 });
    expect(h.sync.getUpcoming()).toEqual([{
      meetingId: 'wx-future',
      title: 'Analyst call',
      scheduledStart: T0 + 600_000,
      scheduledEnd: T0 + 3_600_000,
      sipUri: '777@site.webex.example',
    }]);
    expect(h.sync.status()).toBe('ok');
  });

  it('keeps the last-good cache on a sync failure', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = harness();
    h.setItems([wxMeeting({ id: 'wx-future', start: T0 + 600_000 })]);
    await h.sync.syncNow();
    h.setFail(true);
    await h.sync.syncNow();
    expect(h.sync.getUpcoming()).toHaveLength(1); // last-good preserved
    expect(errSpy).toHaveBeenCalledOnce(); // the failure is intentional and LOUD
  });
});

describe('calendarSync — due-check auto-registration', () => {
  it('registers when the fake clock crosses scheduledStart: source calendar, dtmf password+#', async () => {
    const h = harness();
    h.setItems([wxMeeting()]); // starts at T0 + 10_000
    await h.sync.syncNow();

    h.sync.checkDue();
    expect(h.registered).toHaveLength(0); // not due yet

    h.advance(10_001);
    h.sync.checkDue();
    expect(h.registered).toHaveLength(1);
    const m = h.registered[0];
    expect(m.webexMeetingId).toBe('wx-1');
    expect(m.sipUri).toBe('777@site.webex.example');
    expect(m.dtmf).toBe('4321#');
    expect(m.source).toBe('calendar');
    expect(m.scheduledStart).toBe(T0 + 10_000);
    expect(getMeetingByWebexId(h.db, 'wx-1')?.source).toBe('calendar');

    h.sync.checkDue(); // idempotent — already registered, matched by webexMeetingId
    expect(h.registered).toHaveLength(1);
    expect(listMeetings(h.db)).toHaveLength(1);
  });

  // The sync window looks back 1h, so a meeting that both started AND ended inside
  // that hour is still cached. Guarding only on `start <= now` would dial a meeting
  // that is already over — e.g. after a restart at 10:50 for a 10:00–10:30 call —
  // producing a spurious failed/instant-solitude bot and a phantom coverage gap.
  it('does NOT auto-register a meeting long past its end — and says so LOUDLY, once', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = harness();
    // Ended well beyond the overrun grace (end + 30 min < now).
    h.setItems([wxMeeting({ id: 'wx-over', start: T0 - 9_000_000, end: T0 - 5_400_000 })]);
    await h.sync.syncNow();

    h.sync.checkDue();
    expect(h.registered).toHaveLength(0);
    expect(getMeetingByWebexId(h.db, 'wx-over')).toBeUndefined();
    // A dropped meeting must never be silent...
    expect(errSpy.mock.calls.map((c) => String(c[0])).some((l) => l.includes('wx-over'))).toBe(true);
    // ...but must not spam every 30s due tick either.
    const after = errSpy.mock.calls.length;
    h.sync.checkDue();
    h.sync.checkDue();
    expect(errSpy.mock.calls.length).toBe(after);
    errSpy.mockRestore();
  });

  it('still registers a due meeting that is under way (started, not yet ended)', async () => {
    const h = harness();
    h.setItems([wxMeeting({ id: 'wx-live', start: T0 - 60_000, end: T0 + 1_800_000 })]);
    await h.sync.syncNow();

    h.sync.checkDue();
    expect(h.registered).toHaveLength(1);
    expect(h.registered[0].webexMeetingId).toBe('wx-live');
  });

  // Scheduled ends are not real ends. A call that runs past its slot — and whose
  // registration was delayed (API outage over its start) — must still be picked
  // up, or the overrun goes unmonitored with nothing on screen to show it.
  it('still registers a meeting that is overrunning its scheduled end (within grace)', async () => {
    const h = harness();
    h.setItems([wxMeeting({ id: 'wx-overrun', start: T0 - 3_600_000, end: T0 - 60_000 })]);
    await h.sync.syncNow();

    h.sync.checkDue();
    expect(h.registered.map((m) => m.webexMeetingId)).toEqual(['wx-overrun']);
  });

  it('registers a due meeting with no scheduled end at all', async () => {
    const h = harness();
    h.setItems([wxMeeting({ id: 'wx-noend', start: T0 - 60_000, end: undefined })]);
    await h.sync.syncNow();

    h.sync.checkDue();
    expect(h.registered.map((m) => m.webexMeetingId)).toEqual(['wx-noend']);
  });

  it('manual-conflict rule: a manual registration with the same webexMeetingId wins', async () => {
    const h = harness();
    insertMeeting(h.db, {
      sipUri: 'manual@site.webex.example', title: 'Manual override', webexMeetingId: 'wx-1',
    });
    h.setItems([wxMeeting({ start: T0 - 1 })]); // already due
    await h.sync.syncNow();
    h.sync.checkDue();
    expect(h.registered).toHaveLength(0);
    expect(listMeetings(h.db)).toHaveLength(1); // only the manual row
  });

  it('no SIP address → registered as failed with loud lastError + bot_error audit, never dialed', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = harness();
    h.setItems([wxMeeting({ start: T0 - 1, sipAddress: undefined, password: undefined })]);
    await h.sync.syncNow();
    h.sync.checkDue();

    expect(h.registered).toHaveLength(0); // no dial
    const row = getMeetingByWebexId(h.db, 'wx-1');
    expect(row?.source).toBe('calendar');
    expect(h.statuses).toEqual([{
      meetingId: row!.meetingId, state: 'failed', lastError: NO_SIP_ERROR, updatedAt: T0,
    }]);
    expect(h.audits).toEqual([{
      id: 'aud-x', action: 'bot_error', meetingId: row!.meetingId, detail: NO_SIP_ERROR, at: T0,
    }]);

    h.sync.checkDue(); // idempotent — the failed row blocks re-registration
    expect(h.statuses).toHaveLength(1);
    expect(errSpy).toHaveBeenCalledOnce(); // LOUD on first registration only
  });

  it('stale-data pause: after one fully missed sync cycle, checkDue registers NOTHING', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = harness();
    h.setItems([wxMeeting({ start: T0 - 1 })]);
    await h.sync.syncNow();
    h.advance(2 * 300_000 + 1); // > 2 × syncIntervalMs since last success
    expect(h.sync.status()).toBe('stale');
    h.sync.checkDue();
    expect(h.registered).toHaveLength(0);
    expect(errSpy).toHaveBeenCalledOnce(); // the pause is intentional and LOUD
  });

  it('before the first successful sync, status is stale and checkDue is a no-op', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = harness();
    expect(h.sync.status()).toBe('stale');
    h.sync.checkDue();
    expect(h.registered).toHaveLength(0);
    expect(errSpy).toHaveBeenCalledOnce(); // paused loudly, even pre-first-sync
  });
});

describe('calendarSync — DELETE tombstone (suppress)', () => {
  it('suppress() tombstones one webexMeetingId: checkDue skips it, a DIFFERENT due meeting still registers', async () => {
    const h = harness();
    h.setItems([
      wxMeeting({ id: 'wx-del', start: T0 - 1 }),
      wxMeeting({ id: 'wx-keep', start: T0 - 1 }),
    ]);
    await h.sync.syncNow();
    h.sync.suppress('wx-del');
    h.sync.checkDue();
    expect(h.registered.map((m) => m.webexMeetingId)).toEqual(['wx-keep']);
    expect(getMeetingByWebexId(h.db, 'wx-del')).toBeUndefined();
  });

  it('DELETE of a due meeting is NOT auto-undone: register → delete row + suppress → next tick re-registers nothing', async () => {
    const h = harness();
    h.setItems([wxMeeting({ id: 'wx-1', start: T0 - 1 })]);
    await h.sync.syncNow();
    h.sync.checkDue();
    expect(h.registered).toHaveLength(1);

    // Simulate DELETE /meetings: row removed, composition onDeregister tombstones the id.
    deleteMeeting(h.db, h.registered[0].meetingId);
    h.sync.suppress('wx-1');

    h.advance(30_000); // next due tick — meeting still in cache and still due
    h.sync.checkDue();
    expect(h.registered).toHaveLength(1); // no re-register → no re-dial
    expect(getMeetingByWebexId(h.db, 'wx-1')).toBeUndefined(); // admin's removal stands
  });

  it('tombstone is pruned when the meeting leaves the sync window; a later re-appearance registers again', async () => {
    const h = harness();
    h.setItems([wxMeeting({ id: 'wx-1', start: T0 - 1 })]);
    await h.sync.syncNow();
    h.sync.suppress('wx-1');
    h.sync.checkDue();
    expect(h.registered).toHaveLength(0);

    h.setItems([]); // meeting left the sync window
    await h.sync.syncNow(); // prune point
    h.setItems([wxMeeting({ id: 'wx-1', start: T0 - 1 })]); // a NEW occurrence re-appears
    await h.sync.syncNow();
    h.sync.checkDue();
    expect(h.registered).toHaveLength(1); // tombstone expired with the window
  });
});

describe('calendarSync — timers seam', () => {
  it('start() runs an immediate sync and arms sync + due-check intervals; stop() clears both', async () => {
    const armed: Array<{ fn: () => void; ms: number }> = [];
    const cleared: unknown[] = [];
    let calls = 0;
    const sync = createCalendarSync({
      client: { listUpcomingMeetings: async () => { calls += 1; return []; } },
      db: openDb(),
      onRegister: () => {},
      upsertBotStatus: () => {},
      writeAudit: () => {},
      syncIntervalMs: 300_000,
      windowMs: 24 * 3_600_000,
      now: () => T0,
      timers: {
        setInterval: (fn, ms) => { const handle = { fn, ms }; armed.push(handle); return handle; },
        clearInterval: (handle) => cleared.push(handle),
      },
    });
    sync.start();
    await Promise.resolve(); // let the immediate syncNow settle
    expect(calls).toBe(1); // immediate first sync = loud startup preflight
    expect(armed.map((a) => a.ms)).toEqual([300_000, 30_000]);
    sync.stop();
    expect(cleared).toHaveLength(2);
  });
});
