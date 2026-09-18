/**
 * E2E test with fakes: register a meeting → fake bot reaches connected & emits Opus frames
 * → a WS listener on /live/:meetingId receives a binary frame.
 *
 * Four hard integration concerns addressed here:
 * 1. Factory wrapper — captures the per-process fake created on registerMeeting.
 * 2. Real auth tokens — signed with the same APP_SECRET loadConfig reads.
 * 3. Fire-and-forget timing — onRegister returns before bot starts; poll until fake is defined.
 * 4. Hub publisher/TTL ordering — emit connected+frame before WS connects (4404 guard),
 *    emit another frame after subscribing so the subscriber receives ≥1 binary frame.
 *
 * Additional regression cases (I1, I2 from plan-05 review):
 * I1: DELETE /meetings on an active bot must NOT drop the bot_leave audit entry.
 *     Root cause: upsertBotStatus threw FK violation (meetings row already deleted) before
 *     writeAudit ran. Fix: composition-layer persistBotStatus guard on getMeeting(db, id).
 * I2: stop() must be idempotent — a second call must resolve, not throw on already-closed db.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { buildApp } from './composition.js';
import { createFakeBotProcess, type FakeBotProcess } from './media/__fixtures__/fakeBotProcess.js';
import type { BotProcessFactory } from './media/types.js';
import { signAppSession } from './auth/appToken.js';
import { openDb } from './db/index.js';
import { insertMeeting } from './db/meetings.js';
import { upsertBotStatus, getBotStatus } from './db/botStatus.js';
import { queryAudit } from './db/audit.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';

const SECRET = 'e2e-test-secret';

// Force the webex-disabled path — these E2E-with-fakes suites must
// never talk to a real Webex API even when backend/.env has SA credentials.
process.env.WEBEX_SA_CLIENT_ID = '';
process.env.WEBEX_SA_CLIENT_SECRET = '';
process.env.WEBEX_SCHEDULER_EMAIL = '';

describe('buildApp — end-to-end with fakes', () => {
  let app: ReturnType<typeof buildApp>;
  let port: number;
  // Concern 1: factory wrapper captures the single fake for this test
  let fake: FakeBotProcess | undefined;

  beforeAll(async () => {
    // Concern 2: real tokens — loadConfig reads APP_SECRET from env
    process.env.APP_SECRET = SECRET;

    const botFactory: BotProcessFactory = (_spec) => {
      fake = createFakeBotProcess();
      return fake;
    };

    app = buildApp({ botFactory, dbPath: ':memory:' });
    await app.start(0);
    port = (app.server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await app.stop();
    delete process.env.APP_SECRET;
  });

  it('registers a meeting → bot reaches connected → WS receives a binary Opus frame', async () => {
    const adminToken = signAppSession({ email: 'admin@test.com', role: 'admin' }, SECRET);
    const officerToken = signAppSession({ email: 'officer@test.com', role: 'officer' }, SECRET);
    const baseUrl = `http://127.0.0.1:${port}`;

    // POST /meetings requires admin role
    const res = await fetch(`${baseUrl}/meetings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({ sipUri: '999@test.webex.com', title: 'E2E test meeting' }),
    });
    expect(res.status).toBe(201);
    const { meetingId } = (await res.json()) as { meetingId: string };

    // Concern 3: lifecycle.onRegister is fire-and-forget — poll until fake is defined
    const deadline = Date.now() + 1000;
    while (!fake && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(fake, 'botFactory was never called — registerMeeting did not fire').toBeDefined();

    // Concern 4 — part A: emit connected + frame to make hub.hasPublisher(meetingId) = true
    // (hasPublisher is TTL-based: true while a frame was published within the last 3s)
    fake!.emitStatus('connected');
    fake!.emitFrame(new Uint8Array([0xaa, 0xbb]));

    // Concern 4 — part B: connect WS (hasPublisher is now true, 4404 guard passes)
    // then emit another frame AFTER subscribing so the hub subscriber delivers it to the WS
    const wsUrl = `ws://127.0.0.1:${port}/live/${meetingId}?token=${officerToken}`;

    const binaryFrame = await new Promise<Buffer>((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      let settled = false;

      function done(result: Buffer | Error) {
        if (settled) return;
        settled = true;
        if (result instanceof Error) reject(result);
        else resolve(result);
        if (ws.readyState === ws.OPEN) ws.close();
      }

      // Register message listener before 'open' fires to buffer any early messages
      ws.on('message', (data, isBinary) => {
        // The first message is the 'hello' JSON (isBinary=false); skip it.
        // Binary frames carry Opus payload — that is what we assert.
        if (isBinary) done(data as Buffer);
      });

      ws.on('open', () => {
        // By the time 'open' fires, the server-side hub.subscribe() is already set up
        // (handleConnection runs synchronously inside the handleUpgrade callback, before
        // the 101 response is sent to the network).
        // Emit another frame now so the live subscriber delivers it to the WS.
        fake!.emitFrame(new Uint8Array([0xcc, 0xdd]));
      });

      ws.on('close', (code) => {
        if (code !== 1000 && code !== 1005 && code !== 1006) {
          done(new Error(`WS closed with unexpected code ${code} before a binary frame arrived`));
        }
      });

      ws.on('error', (err) => done(err));

      // Hard timeout — if no binary frame arrives within 2s the test fails
      setTimeout(() => done(new Error('timeout: no binary frame received within 2 s')), 2000);
    });

    // Assert a REAL binary frame (not just absence of error)
    expect(binaryFrame).toBeInstanceOf(Buffer);
    expect(binaryFrame.length).toBeGreaterThan(0);
  });
});

// ─── I1: bot_leave audit survives DELETE-of-active-meeting (FK guard) ────────
// Uses real db (:memory:) so the FK actually fires on the un-fixed code path.
describe('I1: DELETE /meetings on active bot — bot_leave audit must be written', () => {
  let app: ReturnType<typeof buildApp>;
  let port: number;
  let fake: FakeBotProcess | undefined;

  beforeAll(async () => {
    process.env.APP_SECRET = SECRET;
    const botFactory: BotProcessFactory = (_spec) => {
      fake = createFakeBotProcess();
      return fake;
    };
    app = buildApp({ botFactory, dbPath: ':memory:' });
    await app.start(0);
    port = (app.server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await app.stop();
  });

  it('bot_leave audit row is present after DELETE /meetings on a connected bot', async () => {
    const adminToken = signAppSession({ email: 'admin@test.com', role: 'admin' }, SECRET);
    const baseUrl = `http://127.0.0.1:${port}`;

    // Register a meeting
    const postRes = await fetch(`${baseUrl}/meetings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ sipUri: '888@fk-guard.webex.com', title: 'FK-guard test' }),
    });
    expect(postRes.status).toBe(201);
    const { meetingId } = (await postRes.json()) as { meetingId: string };

    // Wait for botFactory to be called (fire-and-forget onRegister)
    const fakeDeadline = Date.now() + 1000;
    while (!fake && Date.now() < fakeDeadline) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(fake, 'botFactory was never called — registerMeeting did not fire').toBeDefined();

    // Drive fake bot to connected + emit a frame so botManager.bots has a live record
    fake!.emitStatus('connected');
    fake!.emitFrame(new Uint8Array([0x01, 0x02]));

    // DELETE the meeting (removes DB rows, then fires onDeregister fire-and-forget)
    const delRes = await fetch(`${baseUrl}/meetings/${meetingId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(delRes.status).toBe(204);

    // (a) Poll for bot_leave audit — the fire-and-forget teardown runs async after the 204.
    // RED: absent before fix (upsertBotStatus FK throw swallows audit write).
    // GREEN: present after fix (persistBotStatus guard skips FK write; writeAudit still runs).
    let hasBotLeave = false;
    const auditDeadline = Date.now() + 1500;
    while (!hasBotLeave && Date.now() < auditDeadline) {
      const r = await fetch(`${baseUrl}/audit?meetingId=${meetingId}`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      const body = (await r.json()) as { entries: Array<{ action: string }> };
      hasBotLeave = body.entries.some((e) => e.action === 'bot_leave');
      if (!hasBotLeave) await new Promise((r) => setTimeout(r, 15));
    }
    expect(hasBotLeave, 'bot_leave audit entry was not written after DELETE /meetings on active bot').toBe(true);

    // (b) Meeting must no longer appear in GET /meetings
    const listRes = await fetch(`${baseUrl}/meetings`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const { meetings } = (await listRes.json()) as { meetings: Array<{ meetingId: string }> };
    expect(meetings.find((m) => m.meetingId === meetingId)).toBeUndefined();
  });
});

// ─── I2: stop() idempotency — second call must not throw ─────────────────────
describe('I2: stop() is idempotent — second call resolves without throwing', () => {
  it('calling app.stop() twice does not throw on the second invocation', async () => {
    process.env.APP_SECRET = SECRET;
    const botFactory: BotProcessFactory = (_spec) => createFakeBotProcess();
    const app2 = buildApp({ botFactory, dbPath: ':memory:' });
    await app2.start(0);
    await app2.stop();
    // RED: before fix the second stop() throws because db/server are already closed.
    // GREEN: after fix stop() is idempotent and resolves on re-entry.
    await expect(app2.stop()).resolves.toBeUndefined();
    delete process.env.APP_SECRET;
  });
});

// ─── Startup reconciliation — a restart must not leave false "connected" coverage ─
// Uses a real on-disk DB so the row a *prior* run persisted survives into the
// buildApp of the *next* run (:memory: can't span two connections).
describe('buildApp — startup reconciliation of stale bot_status', () => {
  it('marks a persisted connected bot disconnected on boot (no live process behind it)', async () => {
    process.env.APP_SECRET = SECRET;
    const dbPath = join(tmpdir(), `wcms-reconcile-${randomUUID()}.db`);
    try {
      // A previous run left this meeting's bot `connected`, then the process died.
      const seed = openDb(dbPath);
      const m = insertMeeting(seed, { sipUri: '111@test.webex.com', title: 'stale-on-restart' });
      upsertBotStatus(seed, { meetingId: m.meetingId, state: 'connected', joinedAt: 1, updatedAt: 1 });
      seed.close();

      // Next boot: buildApp reconciles at construction, before start().
      const app = buildApp({ botFactory: () => createFakeBotProcess(), dbPath });
      try {
        // A fresh connection sees the committed reconciliation...
        const check = openDb(dbPath);
        expect(getBotStatus(check, m.meetingId).state).toBe('disconnected');
        // ...and the reconciliation is recorded in the audit trail (parity with a
        // normal disconnect), so the admin /audit view shows the restart-caused gap.
        expect(queryAudit(check, { meetingId: m.meetingId }).some((a) => a.action === 'bot_error')).toBe(true);
        check.close();
      } finally {
        await app.stop();
      }
    } finally {
      // WAL mode leaves -wal/-shm sidecars next to the db file — remove all three.
      for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) rmSync(p, { force: true });
      delete process.env.APP_SECRET;
    }
  });
});
