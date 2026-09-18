/**
 * Composition-level Webex-integration E2E with fakes (no live Webex, no real timers):
 * calendar meeting auto-dials → roster appears in GET /meetings/:id →
 * all humans leave → solitude fires → bot_leave audit carries reason 'solitude'.
 *
 * Timers stay real-but-unref'd; the test drives ticks deterministically via
 * the exposed seams (syncNow/checkDue/pollNow), mirroring how orchestrator
 * tests drive scheduleRetry.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { buildApp } from './composition.js';
import { createFakeBotProcess, type FakeBotProcess } from './media/__fixtures__/fakeBotProcess.js';
import type { BotProcessFactory } from './media/types.js';
import { signAppSession } from './auth/appToken.js';

const SECRET = 'webex-e2e-secret';

const ENV_KEYS = [
  'APP_SECRET', 'WEBEX_API_BASE', 'WEBEX_SA_CLIENT_ID', 'WEBEX_SA_CLIENT_SECRET',
  'WEBEX_SA_REFRESH_TOKEN', 'WEBEX_SCHEDULER_EMAIL', 'INTERNAL_EMAIL_DOMAINS',
  'SOLITUDE_TIMEOUT_S', 'BOT_DISPLAY_NAME',
] as const;

interface FakeWebexState {
  meetings: Array<Record<string, unknown>>;
  participants: Array<Record<string, unknown>>;
  tokenRequests: number;
  /** Bodies received by POST /meetings (the create endpoint). */
  createBodies: Array<Record<string, unknown>>;
  /** Response the fake returns for POST /meetings. */
  createResponse: Record<string, unknown>;
  /** When true, GET /meetings returns 500 — simulates a sync hiccup. */
  failMeetingsList: boolean;
}

function startFakeWebexApi(state: FakeWebexState): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'POST' && url.pathname === '/access_token') {
      state.tokenRequests += 1;
      res.end(JSON.stringify({ access_token: 'fake-at', expires_in: 3600, refresh_token: 'fake-rt-2' }));
    } else if (url.pathname === '/meetings' && req.method === 'POST') {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        state.createBodies.push(JSON.parse(raw) as Record<string, unknown>);
        res.end(JSON.stringify(state.createResponse));
      });
    } else if (url.pathname === '/meetings') {
      if (state.failMeetingsList) {
        res.statusCode = 500;
        res.end('{}');
        return;
      }
      // The admin-scope rule: every call must carry the scheduler hostEmail.
      if (url.searchParams.get('hostEmail') !== 'scheduler@bank.example') {
        res.statusCode = 403;
        res.end('{}');
        return;
      }
      res.end(JSON.stringify({ items: state.meetings }));
    } else if (url.pathname === '/meetingParticipants') {
      res.end(JSON.stringify({ items: state.participants }));
    } else {
      res.statusCode = 404;
      res.end('{}');
    }
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }),
    ),
  );
}

describe('Webex integration E2E: calendar auto-dial → roster → solitude → bot_leave(solitude)', () => {
  const savedEnv: Record<string, string | undefined> = {};
  const state: FakeWebexState = {
    meetings: [], participants: [], tokenRequests: 0,
    createBodies: [], createResponse: {}, failMeetingsList: false,
  };
  let fakeApi: { server: Server; url: string };
  let app: ReturnType<typeof buildApp>;
  let port: number;
  let fake: FakeBotProcess | undefined;
  let dialCount = 0; // every botFactory call = one auto-dial

  beforeAll(async () => {
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    fakeApi = await startFakeWebexApi(state);
    process.env.APP_SECRET = SECRET;
    process.env.WEBEX_API_BASE = fakeApi.url; // ALL Webex URLs route here
    process.env.WEBEX_SA_CLIENT_ID = 'e2e-ci';
    process.env.WEBEX_SA_CLIENT_SECRET = 'e2e-cs';
    process.env.WEBEX_SA_REFRESH_TOKEN = 'e2e-boot-rt';
    process.env.WEBEX_SCHEDULER_EMAIL = 'scheduler@bank.example';
    process.env.INTERNAL_EMAIL_DOMAINS = 'bank.example';
    process.env.SOLITUDE_TIMEOUT_S = '0'; // solitude fires on the first alone poll
    // The fixtures assume the config default 'Compliance Monitor Bot' — a developer
    // shell exporting BOT_DISPLAY_NAME would misclassify the fake bot (flake).
    delete process.env.BOT_DISPLAY_NAME;

    const botFactory: BotProcessFactory = () => {
      dialCount += 1;
      fake = createFakeBotProcess();
      return fake;
    };
    app = buildApp({ botFactory, dbPath: ':memory:' });
    await app.start(0);
    port = (app.server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await app.stop();
    await new Promise<void>((r) => fakeApi.server.close(() => r()));
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  it('runs the full flow', async () => {
    const officerToken = signAppSession({ email: 'officer@test.com', role: 'officer' }, SECRET);
    const adminToken = signAppSession({ email: 'admin@test.com', role: 'admin' }, SECRET);
    const baseUrl = `http://127.0.0.1:${port}`;
    const authed = (tok: string) => ({ headers: { Authorization: `Bearer ${tok}` } });

    // ── 1. Calendar has one meeting already due (started 1 min ago) ─────────
    state.meetings = [{
      id: 'wx-100',
      title: 'Calendar auto-dial',
      start: new Date(Date.now() - 60_000).toISOString(),
      end: new Date(Date.now() + 3_600_000).toISOString(),
      sipAddress: '777@fake.webex.example',
      password: '4321',
    }];
    expect(app.calendarSync).toBeDefined();
    expect(app.rosterMonitor).toBeDefined();
    await app.calendarSync!.syncNow();
    app.calendarSync!.checkDue(); // registers + fire-and-forget auto-dial

    // Auto-dial is fire-and-forget: poll until the fake SIP process exists.
    const dialDeadline = Date.now() + 1000;
    while (!fake && Date.now() < dialDeadline) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(fake, 'calendar auto-dial never spawned a SIP process').toBeDefined();

    // ── 2. Registered with source calendar; integration healthy ─────────────
    const listRes = await fetch(`${baseUrl}/meetings`, authed(officerToken));
    const list = (await listRes.json()) as {
      meetings: Array<{ meetingId: string; webexMeetingId?: string; source?: string; sipUri: string }>;
      webex_integration: string;
    };
    expect(list.webex_integration).toBe('ok');
    const registered = list.meetings.find((m) => m.webexMeetingId === 'wx-100');
    expect(registered).toBeDefined();
    expect(registered!.source).toBe('calendar');
    expect(registered!.sipUri).toBe('777@fake.webex.example');
    const meetingId = registered!.meetingId;

    // ── 3. Bot connects → roster poll → participants visible with roles ─────
    fake!.emitStatus('connected'); // composition hook starts rosterMonitor synchronously
    state.participants = [
      { id: 'p-fo', displayName: 'Dana Host', email: 'dana@bank.example', host: true, state: 'joined' },
      { id: 'p-an', displayName: 'Alex Analyst', email: 'alex@fund.example', host: false, state: 'joined' },
      { id: 'p-bot', displayName: 'Compliance Monitor Bot', host: false, state: 'joined' },
    ];
    await app.rosterMonitor!.pollNow(meetingId);

    const detailRes = await fetch(`${baseUrl}/meetings/${meetingId}`, authed(officerToken));
    const detail = (await detailRes.json()) as {
      roster: Array<{ id: string; role: string; leftAt: number | null }>;
    };
    expect(detail.roster).toHaveLength(3);
    expect(Object.fromEntries(detail.roster.map((a) => [a.id, a.role]))).toEqual({
      'p-fo': 'fo',
      'p-an': 'analyst',
      'p-bot': 'bot',
    });
    expect(detail.roster.every((a) => a.leftAt === null)).toBe(true);

    // ── 4. All humans leave → solitude fires (timeout 0) → SIP BYE ──────────
    state.participants = [
      { id: 'p-fo', displayName: 'Dana Host', email: 'dana@bank.example', host: true, state: 'end' },
      { id: 'p-an', displayName: 'Alex Analyst', email: 'alex@fund.example', host: false, state: 'end' },
      { id: 'p-bot', displayName: 'Compliance Monitor Bot', host: false, state: 'joined' },
    ];
    // Repo convention (T8 review): the solitude hang-up is intentionally LOUD —
    // silence the expected console.error AND assert it actually fired.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await app.rosterMonitor!.pollNow(meetingId); // marks leaves, then onSolitude
    expect(
      errSpy.mock.calls.some((c) => String(c[0]).includes('solitude')),
      'expected the LOUD solitude hang-up line on console.error',
    ).toBe(true);
    errSpy.mockRestore();

    // ── 5. bot_leave audit with reason 'solitude' (deregister is async) ─────
    let solitudeAudit: { action: string; detail?: string } | undefined;
    const auditDeadline = Date.now() + 1500;
    while (!solitudeAudit && Date.now() < auditDeadline) {
      const r = await fetch(`${baseUrl}/audit?meetingId=${meetingId}`, authed(adminToken));
      const body = (await r.json()) as { entries: Array<{ action: string; detail?: string }> };
      solitudeAudit = body.entries.find((e) => e.action === 'bot_leave' && e.detail === 'solitude');
      if (!solitudeAudit) await new Promise((r2) => setTimeout(r2, 15));
    }
    expect(solitudeAudit, "no bot_leave audit with detail 'solitude' was written").toBeDefined();
    expect(fake!.stopped).toBe(true); // SIP BYE happened

    // Roster kept-last-good after hang-up: humans show leftAt timestamps.
    const afterRes = await fetch(`${baseUrl}/meetings/${meetingId}`, authed(officerToken));
    const after = (await afterRes.json()) as {
      roster: Array<{ id: string; leftAt: number | null }>;
    };
    expect(after.roster.find((a) => a.id === 'p-fo')?.leftAt).toBeTypeOf('number');
    expect(after.roster.find((a) => a.id === 'p-an')?.leftAt).toBeTypeOf('number');

    // Upcoming endpoint serves the cache (wx-100 already started → not upcoming).
    const upRes = await fetch(`${baseUrl}/meetings/upcoming`, authed(officerToken));
    expect(((await upRes.json()) as { meetings: unknown[] }).meetings).toEqual([]);

    // Token refresh happened exactly once (single-flight across all calls).
    expect(state.tokenRequests).toBe(1);

    // ── 6. Ended-meeting history: evicting the cache simulates a RESTART
    //       (cache empty, meetings row + db file intact) — the route must now
    //       serve the PERSISTED roster with rosterSource 'stored'.
    app.rosterMonitor!.evictRoster(meetingId);
    const storedRes = await fetch(`${baseUrl}/meetings/${meetingId}`, authed(officerToken));
    const stored = (await storedRes.json()) as {
      roster: Array<{ id: string; role: string; leftAt: number | null }>;
      rosterSource?: string;
    };
    expect(stored.rosterSource).toBe('stored');
    expect(stored.roster).toHaveLength(3);
    expect(stored.roster.find((a) => a.id === 'p-fo')?.leftAt).toBeTypeOf('number');
    expect(stored.roster.find((a) => a.id === 'p-an')?.leftAt).toBeTypeOf('number');
    // The solitude hang-up drove the bot to a terminal status → stopMonitoring,
    // which stamps leftAt on everyone still present (incl. the bot, so the frozen
    // roster reads "0 on call") and does a second, more-complete persist. So the
    // STORED bot entry carries a leftAt too — the ended-meeting-history invariant.
    expect(stored.roster.find((a) => a.id === 'p-bot')?.leftAt).toBeTypeOf('number');
  });

  it('DELETE of a due calendar meeting is NOT auto-undone by the next due tick', async () => {
    const officerToken = signAppSession({ email: 'officer@test.com', role: 'officer' }, SECRET);
    const adminToken = signAppSession({ email: 'admin@test.com', role: 'admin' }, SECRET);
    const baseUrl = `http://127.0.0.1:${port}`;
    const authed = (tok: string) => ({ headers: { Authorization: `Bearer ${tok}` } });

    // A due calendar meeting (started 1 min ago, inside the 1 h look-back)…
    state.meetings = [{
      id: 'wx-200',
      title: 'Deleted while still due',
      start: new Date(Date.now() - 60_000).toISOString(),
      end: new Date(Date.now() + 3_600_000).toISOString(),
      sipAddress: '888@fake.webex.example',
    }];
    await app.calendarSync!.syncNow();
    app.calendarSync!.checkDue(); // auto-registers (insert is synchronous)
    const listRes = await fetch(`${baseUrl}/meetings`, authed(officerToken));
    const list = (await listRes.json()) as {
      meetings: Array<{ meetingId: string; webexMeetingId?: string }>;
    };
    const registered = list.meetings.find((m) => m.webexMeetingId === 'wx-200');
    expect(registered, 'precondition: due calendar meeting auto-registered').toBeDefined();

    // …the admin explicitly deletes it…
    const delRes = await fetch(`${baseUrl}/meetings/${registered!.meetingId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(delRes.status).toBe(204);
    const dialsAfterDelete = dialCount;

    // …and the NEXT 30 s due tick must NOT revert the admin's removal.
    app.calendarSync!.checkDue();
    const afterRes = await fetch(`${baseUrl}/meetings`, authed(officerToken));
    const after = (await afterRes.json()) as { meetings: Array<{ webexMeetingId?: string }> };
    expect(
      after.meetings.find((m) => m.webexMeetingId === 'wx-200'),
      'DELETE was auto-undone: the due tick re-registered the deleted calendar meeting',
    ).toBeUndefined();

    // No re-dial either — a re-registration is what fires the fire-and-forget dial.
    await new Promise((r) => setTimeout(r, 50));
    expect(dialCount, 'the due tick re-dialed the deleted meeting').toBe(dialsAfterDelete);
  });

  it('POST /meetings/schedule: creates via the fake Webex API and the immediate syncNow surfaces it in Upcoming', async () => {
    const adminToken = signAppSession({ email: 'admin@test.com', role: 'admin' }, SECRET);
    const officerToken = signAppSession({ email: 'officer@test.com', role: 'officer' }, SECRET);
    const baseUrl = `http://127.0.0.1:${port}`;
    const authed = (tok: string) => ({ headers: { Authorization: `Bearer ${tok}` } });

    const start = Date.now() + 3_600_000; // future → shows in Upcoming
    state.createResponse = {
      id: 'wx-300',
      title: 'Scheduled from console',
      start: new Date(start).toISOString(),
      sipAddress: '999@fake.webex.example',
      webLink: 'https://fake.webex.example/meet/300',
    };
    // The calendar list the post-create syncNow will fetch.
    state.meetings = [{
      id: 'wx-300',
      title: 'Scheduled from console',
      start: new Date(start).toISOString(),
      end: new Date(start + 1_800_000).toISOString(),
      sipAddress: '999@fake.webex.example',
    }];

    const res = await fetch(`${baseUrl}/meetings/schedule`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        title: 'Scheduled from console',
        start,
        durationMinutes: 30,
        invitees: ['alex@fund.example'],
      }),
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      webexMeetingId: 'wx-300',
      title: 'Scheduled from console',
      start,
      sipAddress: '999@fake.webex.example',
      joinUrl: 'https://fake.webex.example/meet/300',
    });

    // The wire carried the bot-dialability contract + scheduler hostEmail.
    const sent = state.createBodies.at(-1)!;
    expect(sent.hostEmail).toBe('scheduler@bank.example');
    expect(sent.unlockedMeetingJoinSecurity).toBe('allowJoin');
    expect(sent.enabledJoinBeforeHost).toBe(true);
    expect(sent.joinBeforeHostMinutes).toBe(15);
    expect(sent.enableConnectAudioBeforeHost).toBe(true);
    expect(sent.sendEmail).toBe(true);
    expect(sent.invitees).toEqual([{ email: 'alex@fund.example' }]);
    expect(sent.end).toBe(new Date(start + 30 * 60_000).toISOString());

    // Decision B: the immediate (fire-and-forget) syncNow makes the meeting
    // visible in Upcoming within moments — poll like the other async checks.
    let seen = false;
    const deadline = Date.now() + 1500;
    while (!seen && Date.now() < deadline) {
      const r = await fetch(`${baseUrl}/meetings/upcoming`, authed(officerToken));
      const up = (await r.json()) as { meetings: Array<{ meetingId: string }> };
      seen = up.meetings.some((m) => m.meetingId === 'wx-300');
      if (!seen) await new Promise((r2) => setTimeout(r2, 15));
    }
    expect(seen, 'post-create syncNow did not surface the meeting in Upcoming').toBe(true);
  });

  it('persist-after-DELETE does not FK-throw — the getMeeting guard holds (regression)', async () => {
    const officerToken = signAppSession({ email: 'officer@test.com', role: 'officer' }, SECRET);
    const adminToken = signAppSession({ email: 'admin@test.com', role: 'admin' }, SECRET);
    const baseUrl = `http://127.0.0.1:${port}`;
    const authed = (tok: string) => ({ headers: { Authorization: `Bearer ${tok}` } });

    // A due calendar meeting → auto-register + auto-dial.
    state.meetings = [{
      id: 'wx-guard',
      title: 'Guarded persist on delete',
      start: new Date(Date.now() - 60_000).toISOString(),
      end: new Date(Date.now() + 3_600_000).toISOString(),
      sipAddress: 'guard@fake.webex.example',
    }];
    fake = undefined;
    await app.calendarSync!.syncNow();
    app.calendarSync!.checkDue(); // registers + fire-and-forget auto-dial
    const dialDeadline = Date.now() + 1000;
    while (!fake && Date.now() < dialDeadline) await new Promise((r) => setTimeout(r, 5));
    expect(fake, 'auto-dial never spawned a SIP process').toBeDefined();

    const listRes = await fetch(`${baseUrl}/meetings`, authed(officerToken));
    const list = (await listRes.json()) as {
      meetings: Array<{ meetingId: string; webexMeetingId?: string }>;
    };
    const meetingId = list.meetings.find((m) => m.webexMeetingId === 'wx-guard')!.meetingId;

    // Bot connects → monitoring starts; one poll persists a roster so a later
    // stopMonitoring will actually call persistRoster (rosters map populated).
    // A human keeps liveHumans > 0 so solitude does NOT fire & deregister early.
    fake!.emitStatus('connected');
    state.participants = [
      { id: 'g-fo', displayName: 'Dana Host', email: 'dana@bank.example', host: true, state: 'joined' },
      { id: 'g-bot', displayName: 'Compliance Monitor Bot', host: false, state: 'joined' },
    ];
    await app.rosterMonitor!.pollNow(meetingId);

    // DELETE deletes the meetings row FIRST (routes.ts), THEN fires onDeregister
    // → stopMonitoring (synchronous) → the guarded persistRoster. The row is
    // already gone, so the getMeeting guard SKIPS upsertPresence. Without the
    // guard, upsertPresence would violate the roster_presence FK; rosterMonitor
    // swallows that throw but logs it LOUDLY ("presence persist failed (stop)").
    // The guard's observable is the ABSENCE of that LOUD line. stopMonitoring
    // runs synchronously inside the handler, so the log (if any) is captured
    // before the 204 is received. (FK-on-deregister regression guard.)
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const delRes = await fetch(`${baseUrl}/meetings/${meetingId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const fkFail = errSpy.mock.calls.some((c) => String(c[0]).includes('presence persist failed (stop)'));
    errSpy.mockRestore();
    expect(delRes.status).toBe(204);
    expect(fkFail, 'guarded persist FK-threw on delete (regression)').toBe(false);

    // Cascade: the meeting row (and its roster_presence rows) are gone → 404.
    const goneRes = await fetch(`${baseUrl}/meetings/${meetingId}`, authed(officerToken));
    expect(goneRes.status).toBe(404);
  });

  it('a failing immediate sync does NOT fail the create — 201 anyway, hiccup logged loudly', async () => {
    const adminToken = signAppSession({ email: 'admin@test.com', role: 'admin' }, SECRET);
    const baseUrl = `http://127.0.0.1:${port}`;
    const start = Date.now() + 7_200_000;
    state.createResponse = {
      id: 'wx-301',
      title: 'Create survives sync hiccup',
      start: new Date(start).toISOString(),
      sipAddress: '998@fake.webex.example',
      webLink: 'https://fake.webex.example/meet/301',
    };
    state.failMeetingsList = true; // the post-create syncNow will 500
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Prove the fire-and-forget syncNow can NEVER surface as an unhandled
    // rejection: any escape from the seam's void-catch would land here.
    const rejections: unknown[] = [];
    const onUnhandled = (reason: unknown) => rejections.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const res = await fetch(`${baseUrl}/meetings/schedule`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({ title: 'Create survives sync hiccup', start, durationMinutes: 60 }),
      });
      expect(res.status).toBe(201); // the create already succeeded
      // Give the fire-and-forget sync a beat to fail LOUDLY (calendarSync's own line).
      await new Promise((r) => setTimeout(r, 50));
      expect(
        errSpy.mock.calls.some((c) => String(c[0]).includes('calendar sync failed')),
        'expected the LOUD calendarSync failure line',
      ).toBe(true);
      expect(rejections, 'the fire-and-forget syncNow leaked an unhandled rejection').toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      state.failMeetingsList = false;
      errSpy.mockRestore();
    }
  });
});
