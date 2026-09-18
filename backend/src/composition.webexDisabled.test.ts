/** Webex-integration wiring gate: WITH service-app credentials buildApp exposes the
 *  calendarSync/rosterMonitor seams; WITHOUT them the integration is LOUDLY
 *  disabled and GET /meetings reports webex_integration 'failed'. */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { AddressInfo } from 'node:net';
import { buildApp } from './composition.js';
import { createFakeBotProcess, type FakeBotProcess } from './media/__fixtures__/fakeBotProcess.js';
import type { BotProcessFactory } from './media/types.js';
import { signAppSession } from './auth/appToken.js';

const SECRET = 'webex-wiring-secret';
// WEBEX_API_BASE is saved/restored too: the roster-lifecycle suite points it
// at an unroutable local port so the configured path stays hermetic.
const ENV_KEYS = [
  'APP_SECRET',
  'WEBEX_SA_CLIENT_ID',
  'WEBEX_SA_CLIENT_SECRET',
  'WEBEX_SCHEDULER_EMAIL',
  'WEBEX_API_BASE',
] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.APP_SECRET = SECRET;
});
afterAll(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe('buildApp — webex wiring gate', () => {
  it('exposes calendarSync + rosterMonitor when the service app is configured', async () => {
    process.env.WEBEX_SA_CLIENT_ID = 'dummy-ci';
    process.env.WEBEX_SA_CLIENT_SECRET = 'dummy-cs';
    process.env.WEBEX_SCHEDULER_EMAIL = 'scheduler@bank.example';

    const botFactory: BotProcessFactory = () => createFakeBotProcess();
    const app = buildApp({ botFactory, dbPath: ':memory:' });
    // RED before this task: buildApp does not return these seams.
    expect(app.calendarSync).toBeDefined();
    expect(app.rosterMonitor).toBeDefined();
    // No network happens: calendarSync.start() only runs inside app.start().
    await app.stop(); // cleanup (idempotent; server was never listening)
  });

  it('manual-register-only: CALENDAR_SYNC_ENABLED=false → calendarSync undefined, rosterMonitor still defined', async () => {
    // Full Webex creds, but the manual-register-only gate is ON. The SDK stack
    // must NOT create calendar auto-sync/scheduling (so a parallel deployment
    // cannot double-dial), while roster/solitude + the guest identity stay live.
    process.env.WEBEX_SA_CLIENT_ID = 'dummy-ci';
    process.env.WEBEX_SA_CLIENT_SECRET = 'dummy-cs';
    process.env.WEBEX_SCHEDULER_EMAIL = 'scheduler@bank.example';
    const prevFlag = process.env.CALENDAR_SYNC_ENABLED;
    process.env.CALENDAR_SYNC_ENABLED = 'false';
    // Silence the expected loud manual-register-only console.warn banner.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const botFactory: BotProcessFactory = () => createFakeBotProcess();
      const app = buildApp({ botFactory, dbPath: ':memory:' });
      expect(app.calendarSync).toBeUndefined();
      expect(app.rosterMonitor).toBeDefined();
      await app.stop(); // idempotent; server never listened
    } finally {
      warnSpy.mockRestore();
      if (prevFlag === undefined) delete process.env.CALENDAR_SYNC_ENABLED;
      else process.env.CALENDAR_SYNC_ENABLED = prevFlag;
    }
  });

  it("without credentials: boots, seams undefined, GET /meetings carries webex_integration 'failed'", async () => {
    // Explicitly empty (dotenv may have populated real values from .env).
    process.env.WEBEX_SA_CLIENT_ID = '';
    process.env.WEBEX_SA_CLIENT_SECRET = '';
    process.env.WEBEX_SCHEDULER_EMAIL = '';

    const botFactory: BotProcessFactory = () => createFakeBotProcess();
    const app = buildApp({ botFactory, dbPath: ':memory:' });
    expect(app.calendarSync).toBeUndefined();
    expect(app.rosterMonitor).toBeUndefined();
    await app.start(0);
    const port = (app.server.address() as AddressInfo).port;

    const officerToken = signAppSession({ email: 'officer@test.com', role: 'officer' }, SECRET);
    const res = await fetch(`http://127.0.0.1:${port}/meetings`, {
      headers: { Authorization: `Bearer ${officerToken}` },
    });
    const body = (await res.json()) as { meetings: unknown[]; webex_integration: string };
    expect(res.status).toBe(200);
    expect(body.webex_integration).toBe('failed');

    // Loud-disable: no seam ⇒ scheduling answers 503, named.
    const adminToken = signAppSession({ email: 'admin@test.com', role: 'admin' }, SECRET);
    const schedRes = await fetch(`http://127.0.0.1:${port}/meetings/schedule`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        title: 'Should not exist',
        start: Date.now() + 3_600_000,
        durationMinutes: 30,
        invitees: [],
      }),
    });
    expect(schedRes.status).toBe(503);
    expect(((await schedRes.json()) as { error: string }).error).toContain('not configured');

    await app.stop();
  });
});

// ─── Roster lifecycle wiring + eviction contract (T5 review debt) ────────────
// Pins the composition-supplied roster lifecycle: startMonitoring on
// 'connected', stopMonitoring (WITHOUT eviction — last-known roster survives)
// on a terminal bot state, and eviction ONLY on deregister (DELETE /meetings,
// where the meetings row — and thus GET /meetings/:id — is gone).
describe('buildApp — roster lifecycle wiring + eviction on deregister', () => {
  it('connected → startMonitoring; terminal → stop without evict; DELETE → evict', async () => {
    process.env.WEBEX_SA_CLIENT_ID = 'dummy-ci';
    process.env.WEBEX_SA_CLIENT_SECRET = 'dummy-cs';
    process.env.WEBEX_SCHEDULER_EMAIL = 'scheduler@bank.example';
    // Hermetic: any accidental token/calendar call dies fast on a closed local
    // port (caught + logged loudly by the units themselves — never unhandled).
    process.env.WEBEX_API_BASE = 'http://127.0.0.1:1';

    let fake: FakeBotProcess | undefined;
    const botFactory: BotProcessFactory = () => {
      fake = createFakeBotProcess();
      return fake;
    };
    const app = buildApp({ botFactory, dbPath: ':memory:' });
    expect(app.rosterMonitor).toBeDefined();
    // The wiring calls through this exact object, so spies observe it.
    const startSpy = vi.spyOn(app.rosterMonitor!, 'startMonitoring');
    const stopSpy = vi.spyOn(app.rosterMonitor!, 'stopMonitoring');
    const evictSpy = vi.spyOn(app.rosterMonitor!, 'evictRoster');
    // Silence the expected loud calendar-preflight failure lines (dummy creds
    // against a closed port) without hiding them from the assertion trail.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await app.start(0);
      const port = (app.server.address() as AddressInfo).port;
      const adminToken = signAppSession({ email: 'admin@test.com', role: 'admin' }, SECRET);
      const baseUrl = `http://127.0.0.1:${port}`;

      const postRes = await fetch(`${baseUrl}/meetings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({
          sipUri: '777@evict.webex.com',
          title: 'Eviction wiring test',
          webexMeetingId: 'wx-evict-1',
        }),
      });
      expect(postRes.status).toBe(201);
      const { meetingId } = (await postRes.json()) as { meetingId: string };

      // onRegister is fire-and-forget — wait for the bot process to exist.
      const deadline = Date.now() + 1000;
      while (!fake && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
      expect(fake, 'botFactory was never called').toBeDefined();

      // connected → the status hook starts roster monitoring with the webex id.
      fake!.emitStatus('connected');
      expect(startSpy).toHaveBeenCalledWith(meetingId, 'wx-evict-1');

      // Terminal state → polling stops but the roster cache is KEPT.
      fake!.emitStatus('disconnected');
      expect(stopSpy).toHaveBeenCalledWith(meetingId);
      expect(evictSpy).not.toHaveBeenCalled();

      // DELETE /meetings (deregister) → the cache entry is evicted.
      const delRes = await fetch(`${baseUrl}/meetings/${meetingId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      expect(delRes.status).toBe(204);
      expect(evictSpy).toHaveBeenCalledWith(meetingId);
      expect(app.rosterMonitor!.getRoster(meetingId)).toEqual([]);
    } finally {
      await app.stop();
      errSpy.mockRestore();
    }
  });
});

// ─── Roster peek seam wiring (view-failed-meeting) ───────────────────────────
describe('buildApp — roster peek seam wiring', () => {
  it('configured: GET /meetings/:id?peek=1 reaches the peek path (hermetic Webex failure → loud rosterError)', async () => {
    process.env.WEBEX_SA_CLIENT_ID = 'dummy-ci';
    process.env.WEBEX_SA_CLIENT_SECRET = 'dummy-cs';
    process.env.WEBEX_SCHEDULER_EMAIL = 'scheduler@bank.example';
    process.env.WEBEX_API_BASE = 'http://127.0.0.1:1'; // hermetic: dies fast on a closed port

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const botFactory: BotProcessFactory = () => createFakeBotProcess();
    const app = buildApp({ botFactory, dbPath: ':memory:' });
    try {
      await app.start(0);
      const port = (app.server.address() as AddressInfo).port;
      const adminToken = signAppSession({ email: 'admin@test.com', role: 'admin' }, SECRET);
      const officerToken = signAppSession({ email: 'officer@test.com', role: 'officer' }, SECRET);
      const baseUrl = `http://127.0.0.1:${port}`;

      const postRes = await fetch(`${baseUrl}/meetings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({ sipUri: '888@peek.webex.com', title: 'Peek wiring', webexMeetingId: 'wx-peek-1' }),
      });
      expect(postRes.status).toBe(201);
      const { meetingId } = (await postRes.json()) as { meetingId: string };

      const res = await fetch(`${baseUrl}/meetings/${meetingId}?peek=1`, {
        headers: { Authorization: `Bearer ${officerToken}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { roster: unknown[]; rosterSource: string; rosterError?: string };
      // The seam IS wired (we did NOT get 'not configured'); the hermetic base
      // makes the Webex call fail → the loud-but-honest error path.
      expect(body.rosterSource).toBe('none');
      expect(body.rosterError).toMatch(/roster peek failed/);
      expect(body.roster).toEqual([]);
    } finally {
      errSpy.mockRestore();
      await app.stop();
    }
  });

  it("disabled: GET /meetings/:id?peek=1 reports 'not configured'", async () => {
    process.env.WEBEX_SA_CLIENT_ID = '';
    process.env.WEBEX_SA_CLIENT_SECRET = '';
    process.env.WEBEX_SCHEDULER_EMAIL = '';

    const botFactory: BotProcessFactory = () => createFakeBotProcess();
    const app = buildApp({ botFactory, dbPath: ':memory:' });
    try {
      await app.start(0);
      const port = (app.server.address() as AddressInfo).port;
      const adminToken = signAppSession({ email: 'admin@test.com', role: 'admin' }, SECRET);
      const officerToken = signAppSession({ email: 'officer@test.com', role: 'officer' }, SECRET);
      const baseUrl = `http://127.0.0.1:${port}`;

      const postRes = await fetch(`${baseUrl}/meetings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({ sipUri: '889@peek.webex.com', title: 'Peek disabled', webexMeetingId: 'wx-peek-2' }),
      });
      expect(postRes.status).toBe(201);
      const { meetingId } = (await postRes.json()) as { meetingId: string };

      const res = await fetch(`${baseUrl}/meetings/${meetingId}?peek=1`, {
        headers: { Authorization: `Bearer ${officerToken}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { rosterSource: string; rosterError?: string };
      expect(body.rosterSource).toBe('none');
      expect(body.rosterError).toMatch(/not configured/);
    } finally {
      await app.stop();
    }
  });
});
