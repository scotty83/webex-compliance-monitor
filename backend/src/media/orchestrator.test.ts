import { describe, it, expect, vi } from 'vitest';
import { createOrchestrator } from './orchestrator.js';
import { createFakeBotManager } from './__fixtures__/fakeBotManager.js';
import { createBotManager } from './botManager.js';
import { createMediaHub } from './hub.js';
import { createFakeBotProcess } from './__fixtures__/fakeBotProcess.js';
import type { BotStatus, ChaperonedMeeting, AuditEntry } from '../domain/types.js';

const meeting: ChaperonedMeeting = { meetingId: 'm1', sipUri: '1@s.webex.com', title: 'T', createdAt: 0 };

function harness() {
  const botManager = createFakeBotManager();
  const statuses: BotStatus[] = [];
  const audits: string[] = [];
  const orch = createOrchestrator({
    botManager,
    upsertBotStatus: (s) => statuses.push(s),
    writeAudit: (e) => audits.push(`${e.action}:${e.detail ?? ''}`),
    now: () => 9000, newId: () => 'x',
  });
  return { botManager, statuses, audits, orch };
}

describe('createOrchestrator — start/stop + persist', () => {
  it('registerMeeting persists idle then starts the bot', async () => {
    const h = harness();
    await h.orch.registerMeeting(meeting);
    expect(h.statuses[0]).toMatchObject({ meetingId: 'm1', state: 'idle' });
    expect(h.botManager.started).toEqual([meeting]);
  });

  it('persists every status; on connected audits bot_join', async () => {
    const h = harness();
    await h.orch.registerMeeting(meeting);
    h.botManager.emit({ meetingId: 'm1', state: 'connected', joinedAt: 9000, updatedAt: 9000 });
    expect(h.statuses.at(-1)).toMatchObject({ state: 'connected' });
    expect(h.audits).toContain('bot_join:');
  });

  it('on ended audits bot_leave', async () => {
    const h = harness();
    await h.orch.registerMeeting(meeting);
    h.botManager.emit({ meetingId: 'm1', state: 'ended', updatedAt: 9000 });
    expect(h.statuses.at(-1)).toMatchObject({ state: 'ended' });
    expect(h.audits).toContain('bot_leave:');
  });

  it('on disconnected audits bot_error (fail-LOUD), not bot_leave', async () => {
    const h = harness();
    await h.orch.registerMeeting(meeting);
    h.botManager.emit({ meetingId: 'm1', state: 'disconnected', lastError: 'net drop', updatedAt: 9000 });
    expect(h.statuses.at(-1)).toMatchObject({ state: 'disconnected' });
    expect(h.audits).toContain('bot_error:net drop');
    expect(h.audits).not.toContain('bot_leave:');
  });

  it('on disconnected without lastError audits bot_error with fallback detail', async () => {
    const h = harness();
    await h.orch.registerMeeting(meeting);
    h.botManager.emit({ meetingId: 'm1', state: 'disconnected', updatedAt: 9000 });
    expect(h.audits).toContain('bot_error:bot disconnected');
  });

  it('on failed audits bot_error with lastError as detail', async () => {
    const h = harness();
    await h.orch.registerMeeting(meeting);
    h.botManager.emit({ meetingId: 'm1', state: 'failed', lastError: 'timeout', updatedAt: 9000 });
    expect(h.statuses.at(-1)).toMatchObject({ state: 'failed' });
    expect(h.audits).toContain('bot_error:timeout');
  });

  it('on dialing persists only — no audit', async () => {
    const h = harness();
    await h.orch.registerMeeting(meeting);
    const auditsBefore = h.audits.length;
    h.botManager.emit({ meetingId: 'm1', state: 'dialing', updatedAt: 9000 });
    expect(h.statuses.at(-1)).toMatchObject({ state: 'dialing' });
    expect(h.audits.length).toBe(auditsBefore);
  });

  it('deregisterMeeting stops the bot', async () => {
    const h = harness();
    await h.orch.registerMeeting(meeting);
    await h.orch.deregisterMeeting('m1');
    expect(h.botManager.stopped).toEqual(['m1']);
  });

  it('duplicate-audit guard: same state twice yields one audit but both persisted', async () => {
    const h = harness();
    await h.orch.registerMeeting(meeting);
    h.botManager.emit({ meetingId: 'm1', state: 'connected', joinedAt: 9000, updatedAt: 9000 });
    h.botManager.emit({ meetingId: 'm1', state: 'connected', joinedAt: 9000, updatedAt: 9000 });
    const botJoinAudits = h.audits.filter((a) => a === 'bot_join:');
    expect(botJoinAudits).toHaveLength(1);
    const connectedStatuses = h.statuses.filter((s) => s.meetingId === 'm1' && s.state === 'connected');
    expect(connectedStatuses).toHaveLength(2);
  });

  it('multi-meeting isolation: interleaved statuses do not bleed across meetings', async () => {
    const meeting2: ChaperonedMeeting = { meetingId: 'm2', sipUri: '2@s.webex.com', title: 'T2', createdAt: 0 };
    const h = harness();
    await h.orch.registerMeeting(meeting);
    await h.orch.registerMeeting(meeting2);

    h.botManager.emit({ meetingId: 'm1', state: 'connected', joinedAt: 9000, updatedAt: 9000 });
    h.botManager.emit({ meetingId: 'm2', state: 'connected', joinedAt: 9000, updatedAt: 9000 });
    h.botManager.emit({ meetingId: 'm1', state: 'ended', updatedAt: 9000 });
    h.botManager.emit({ meetingId: 'm2', state: 'failed', lastError: 'crash', updatedAt: 9000 });

    const m1Statuses = h.statuses.filter((s) => s.meetingId === 'm1');
    const m2Statuses = h.statuses.filter((s) => s.meetingId === 'm2');
    expect(m1Statuses.every((s) => s.meetingId === 'm1')).toBe(true);
    expect(m2Statuses.every((s) => s.meetingId === 'm2')).toBe(true);
    expect(m1Statuses.map((s) => s.state)).toContain('connected');
    expect(m1Statuses.map((s) => s.state)).toContain('ended');
    expect(m2Statuses.map((s) => s.state)).toContain('connected');
    expect(m2Statuses.map((s) => s.state)).toContain('failed');
    expect(h.audits).toContain('bot_error:crash');
    expect(h.audits.filter((a) => a === 'bot_join:')).toHaveLength(2);
  });
});

// ── Task 8: retry / backoff / give-up ──────────────────────────────────────

function retryHarness(retry: { maxAttempts: number; baseDelayMs: number; maxDelayMs: number }) {
  const botManager = createFakeBotManager();
  const statuses: BotStatus[] = [];
  const audits: { action: string; detail?: string }[] = [];
  const scheduled: { fn: () => void; delay: number }[] = [];
  const orch = createOrchestrator({
    botManager,
    upsertBotStatus: (s) => statuses.push(s),
    writeAudit: (e: AuditEntry) => audits.push({ action: e.action, detail: e.detail }),
    now: () => 0, newId: () => 'x', retry,
    scheduleRetry: (fn, delay) => { scheduled.push({ fn, delay }); },
  });
  return { botManager, statuses, audits, scheduled, orch };
}

describe('createOrchestrator — retry/backoff + fail-LOUD', () => {
  it('retries with exponential, capped backoff and audits each failure', async () => {
    const h = retryHarness({ maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 150 });
    await h.orch.registerMeeting(meeting);

    h.botManager.emit({ meetingId: 'm1', state: 'failed', lastError: 'no answer', updatedAt: 0 });
    expect(h.audits).toContainEqual({ action: 'bot_error', detail: 'no answer' });
    expect(h.scheduled[0].delay).toBe(100); // base * 2^0
    h.scheduled[0].fn();                     // fire retry -> redial
    expect(h.botManager.started).toHaveLength(2);

    h.botManager.emit({ meetingId: 'm1', state: 'failed', lastError: 'no answer', updatedAt: 0 });
    expect(h.scheduled[1].delay).toBe(150);  // min(base*2^1=200, max 150)
    h.scheduled[1].fn();
    expect(h.botManager.started).toHaveLength(3);
  });

  it('after maxAttempts gives up LOUDLY: terminal failed status + bot_error, no further retry', async () => {
    const h = retryHarness({ maxAttempts: 2, baseDelayMs: 100, maxDelayMs: 1000 });
    await h.orch.registerMeeting(meeting);

    h.botManager.emit({ meetingId: 'm1', state: 'failed', lastError: 'boom', updatedAt: 0 }); // attempt 1
    h.scheduled[0].fn();
    h.botManager.emit({ meetingId: 'm1', state: 'failed', lastError: 'boom', updatedAt: 0 }); // attempt 2
    h.scheduled[1].fn();
    h.botManager.emit({ meetingId: 'm1', state: 'failed', lastError: 'boom', updatedAt: 0 }); // exhausted

    expect(h.scheduled).toHaveLength(2); // no third retry scheduled
    const terminal = h.statuses.filter((s) => s.state === 'failed').at(-1)!;
    expect(terminal.lastError).toContain('gave up after 2 retries');
    expect(h.audits.some((a) => a.action === 'bot_error' && a.detail?.includes('gave up'))).toBe(true);
  });

  it('a connected status resets the attempt counter (next failure backs off from base again)', async () => {
    const h = retryHarness({ maxAttempts: 5, baseDelayMs: 100, maxDelayMs: 10_000 });
    await h.orch.registerMeeting(meeting);
    h.botManager.emit({ meetingId: 'm1', state: 'failed', lastError: 'x', updatedAt: 0 });
    expect(h.scheduled.at(-1)!.delay).toBe(100);
    h.botManager.emit({ meetingId: 'm1', state: 'connected', joinedAt: 0, updatedAt: 0 });
    h.botManager.emit({ meetingId: 'm1', state: 'failed', lastError: 'x', updatedAt: 0 });
    expect(h.scheduled.at(-1)!.delay).toBe(100); // reset, not 200
  });

  it('disconnected emits per-attempt bot_error (loud), distinct from give-up bot_error', async () => {
    const h = retryHarness({ maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1000 });
    await h.orch.registerMeeting(meeting);

    // First disconnect: triggers bot_error and schedules retry.
    h.botManager.emit({ meetingId: 'm1', state: 'disconnected', lastError: 'net drop', updatedAt: 0 });
    expect(h.audits).toContainEqual({ action: 'bot_error', detail: 'net drop' });
    expect(h.scheduled).toHaveLength(1);

    // Fire retry; bot re-dials (emitting dialing resets the dedup guard), then disconnects again.
    h.scheduled[0].fn();
    expect(h.botManager.started).toHaveLength(2);
    h.botManager.emit({ meetingId: 'm1', state: 'dialing', updatedAt: 0 }); // intermediate — resets dedup
    h.botManager.emit({ meetingId: 'm1', state: 'disconnected', lastError: 'net drop', updatedAt: 0 });

    // Two per-attempt bot_error audits written (one per disconnect, not bot_leave).
    expect(h.audits.filter((a) => a.action === 'bot_error' && a.detail === 'net drop')).toHaveLength(2);
    expect(h.audits.some((a) => a.action === 'bot_leave')).toBe(false);
    // No give-up audit yet (only 2 of 3 attempts exhausted).
    expect(h.audits.some((a) => a.action === 'bot_error' && a.detail?.includes('gave up'))).toBe(false);
  });

  it('deregisterMeeting cancels a pending retry (no further startBot after stop)', async () => {
    const h = retryHarness({ maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1000 });
    await h.orch.registerMeeting(meeting);
    h.botManager.emit({ meetingId: 'm1', state: 'failed', lastError: 'net', updatedAt: 0 });
    expect(h.scheduled).toHaveLength(1);

    await h.orch.deregisterMeeting('m1');

    h.scheduled[0].fn(); // fire the pending retry callback
    expect(h.botManager.started).toHaveLength(1); // only initial startBot, no retry
  });

  it('give-up fires exactly once — a subsequent failure does not re-fire the give-up audit', async () => {
    const h = retryHarness({ maxAttempts: 2, baseDelayMs: 100, maxDelayMs: 1000 });
    await h.orch.registerMeeting(meeting);

    // Exhaust all attempts
    h.botManager.emit({ meetingId: 'm1', state: 'failed', lastError: 'boom', updatedAt: 0 }); // n=0 → retry
    h.scheduled[0].fn();
    h.botManager.emit({ meetingId: 'm1', state: 'failed', lastError: 'boom', updatedAt: 0 }); // n=1 → retry
    h.scheduled[1].fn();
    h.botManager.emit({ meetingId: 'm1', state: 'failed', lastError: 'boom', updatedAt: 0 }); // n=2 → give-up

    const giveUpAuditsAfterExhaustion = h.audits.filter(
      (a) => a.action === 'bot_error' && a.detail?.includes('gave up'),
    );
    expect(giveUpAuditsAfterExhaustion).toHaveLength(1);

    // A further failure (e.g. stale event, same bot) must NOT produce another give-up audit.
    h.botManager.emit({ meetingId: 'm1', state: 'failed', lastError: 'boom', updatedAt: 0 });
    const giveUpAuditsAfterExtra = h.audits.filter(
      (a) => a.action === 'bot_error' && a.detail?.includes('gave up'),
    );
    expect(giveUpAuditsAfterExtra).toHaveLength(1); // still exactly one
    expect(h.scheduled).toHaveLength(2);            // no third retry ever scheduled
  });
});

// ── stopAll ────────────────────────────────────────────────────────────────

describe('createOrchestrator — stopAll()', () => {
  const meeting2: ChaperonedMeeting = { meetingId: 'm2', sipUri: '2@s.webex.com', title: 'T2', createdAt: 0 };

  it('resolves cleanly with an empty registry — calls nothing', async () => {
    const h = harness();
    await expect(h.orch.stopAll()).resolves.toBeUndefined();
    expect(h.botManager.stopped).toHaveLength(0);
  });

  it('stops every registered meeting exactly once', async () => {
    const h = harness();
    await h.orch.registerMeeting(meeting);
    await h.orch.registerMeeting(meeting2);

    await h.orch.stopAll();

    expect(h.botManager.stopped).toHaveLength(2);
    expect(h.botManager.stopped).toContain('m1');
    expect(h.botManager.stopped).toContain('m2');
  });

  it('leaves the registry empty — second stopAll is a no-op (idempotent)', async () => {
    const h = harness();
    await h.orch.registerMeeting(meeting);
    await h.orch.registerMeeting(meeting2);

    await h.orch.stopAll();
    const stoppedAfterFirst = h.botManager.stopped.length;

    await h.orch.stopAll(); // nothing registered anymore
    expect(h.botManager.stopped).toHaveLength(stoppedAfterFirst); // unchanged
  });

  it('one stop failure does not prevent the other meetings from being stopped', async () => {
    const { stopped, ...rest } = createFakeBotManager();
    // Override stopBot so 'm1' throws but 'm2' succeeds
    const failingManager = {
      ...rest,
      stopped,
      async stopBot(id: string): Promise<void> {
        if (id === 'm1') throw new Error('stop failed');
        stopped.push(id);
      },
    };
    const orch = createOrchestrator({
      botManager: failingManager,
      upsertBotStatus: () => {},
      writeAudit: () => {},
      now: () => 0,
      newId: () => 'x',
    });

    await orch.registerMeeting(meeting);
    await orch.registerMeeting(meeting2);

    await expect(orch.stopAll()).resolves.toBeUndefined(); // does not throw
    expect(stopped).toContain('m2'); // m2 was stopped despite m1 failure
  });
});

// ── Composing test: real createBotManager + fake BotProcessFactory ────────────
// Proves the BotManager ↔ Orchestrator seam works end-to-end:
// the real startBot/record-freeing path is exercised, not the fake.

function composingHarness(retry = { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1000 }) {
  const fakeProcesses: ReturnType<typeof createFakeBotProcess>[] = [];
  const botFactory = vi.fn().mockImplementation(() => {
    const p = createFakeBotProcess();
    fakeProcesses.push(p);
    return p;
  });
  const hub = createMediaHub();
  const botManager = createBotManager({ hub, botFactory, now: () => 0 });
  const statuses: BotStatus[] = [];
  const audits: { action: string; detail?: string }[] = [];
  const scheduled: { fn: () => void; delay: number }[] = [];
  const orch = createOrchestrator({
    botManager,
    upsertBotStatus: (s) => statuses.push(s),
    writeAudit: (e: AuditEntry) => audits.push({ action: e.action, detail: e.detail }),
    now: () => 0,
    newId: () => 'x',
    retry,
    scheduleRetry: (fn, delay) => { scheduled.push({ fn, delay }); },
  });
  return { botFactory, fakeProcesses, hub, botManager, statuses, audits, scheduled, orch };
}

// ── Deregister reason → bot_leave audit detail ─────────────────────

describe('createOrchestrator — deregister reason lands in bot_leave detail', () => {
  it("deregisterMeeting(id, 'solitude') stamps the reason on the bot_leave audit", async () => {
    const h = harness();
    await h.orch.registerMeeting(meeting);
    h.botManager.emit({ meetingId: 'm1', state: 'connected', joinedAt: 9000, updatedAt: 9000 });
    await h.orch.deregisterMeeting('m1', 'solitude');
    // Fake botManager does not emit on stopBot — emit the terminal status manually.
    h.botManager.emit({ meetingId: 'm1', state: 'ended', updatedAt: 9000 });
    expect(h.audits).toContain('bot_leave:solitude');
  });

  it('deregisterMeeting without a reason keeps bot_leave detail empty (unchanged behavior)', async () => {
    const h = harness();
    await h.orch.registerMeeting(meeting);
    await h.orch.deregisterMeeting('m1');
    h.botManager.emit({ meetingId: 'm1', state: 'ended', updatedAt: 9000 });
    expect(h.audits).toContain('bot_leave:');
    expect(h.audits.some((a) => a.startsWith('bot_leave:') && a !== 'bot_leave:')).toBe(false);
  });

  it('the reason is consumed once — a re-registered meeting ends with a clean bot_leave', async () => {
    const h = harness();
    await h.orch.registerMeeting(meeting);
    await h.orch.deregisterMeeting('m1', 'solitude');
    h.botManager.emit({ meetingId: 'm1', state: 'ended', updatedAt: 9000 });
    expect(h.audits.filter((a) => a === 'bot_leave:solitude')).toHaveLength(1);

    await h.orch.registerMeeting(meeting); // fresh episode
    h.botManager.emit({ meetingId: 'm1', state: 'ended', updatedAt: 9000 });
    expect(h.audits.filter((a) => a === 'bot_leave:solitude')).toHaveLength(1); // no stale reason
    expect(h.audits.filter((a) => a === 'bot_leave:')).toHaveLength(1);
  });

  it('composing: real BotManager emits ended during stopBot — reason still lands', async () => {
    const h = composingHarness();
    await h.orch.registerMeeting(meeting);
    h.fakeProcesses[0].emitStatus('connected');
    await h.orch.deregisterMeeting('m1', 'solitude');
    expect(h.audits).toContainEqual({ action: 'bot_leave', detail: 'solitude' });
  });
});

describe('createOrchestrator — composing: real BotManager + fake BotProcessFactory', () => {
  it('retry after disconnected spawns a NEW BotProcess (factory called a second time — real re-dial)', async () => {
    const h = composingHarness({ maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1000 });
    await h.orch.registerMeeting(meeting);

    expect(h.botFactory).toHaveBeenCalledTimes(1); // initial dial

    // First process disconnects — BotManager must free the record
    h.fakeProcesses[0].emitStatus('disconnected', { error: 'rtp timeout' });

    // Orchestrator must have scheduled a retry
    expect(h.scheduled).toHaveLength(1);

    // Firing the retry callback must spawn a FRESH BotProcess (not a no-op)
    h.scheduled[0].fn();

    expect(h.botFactory).toHaveBeenCalledTimes(2); // second factory call = new process
    expect(h.fakeProcesses).toHaveLength(2);
    expect(h.fakeProcesses[1].started).toBe(true);
  });

  it('after maxAttempts give-up fires exactly once; no further retries schedule', async () => {
    const h = composingHarness({ maxAttempts: 2, baseDelayMs: 100, maxDelayMs: 1000 });
    await h.orch.registerMeeting(meeting);

    // Exhaust all retry attempts
    h.fakeProcesses[0].emitStatus('failed', { error: 'boom' }); // attempt 0 → retry
    h.scheduled[0].fn();                                          // spawns process 1
    h.fakeProcesses[1].emitStatus('failed', { error: 'boom' }); // attempt 1 → retry
    h.scheduled[1].fn();                                          // spawns process 2
    h.fakeProcesses[2].emitStatus('failed', { error: 'boom' }); // exhausted → give-up

    expect(h.scheduled).toHaveLength(2); // no third retry
    const terminal = h.statuses.filter((s) => s.state === 'failed').at(-1)!;
    expect(terminal.lastError).toContain('gave up after 2 retries');

    const giveUpAudits = h.audits.filter(
      (a) => a.action === 'bot_error' && a.detail?.includes('gave up'),
    );
    expect(giveUpAudits).toHaveLength(1); // exactly once
  });

  it('connected between failures resets the attempt budget', async () => {
    const h = composingHarness({ maxAttempts: 2, baseDelayMs: 100, maxDelayMs: 1000 });
    await h.orch.registerMeeting(meeting);

    // First failure → retry
    h.fakeProcesses[0].emitStatus('failed', { error: 'x' });
    expect(h.scheduled[0].delay).toBe(100); // base * 2^0

    h.scheduled[0].fn(); // spawns process 1
    // Bot connects successfully — resets the attempt counter
    h.fakeProcesses[1].emitStatus('connected');

    // Second failure on the connected bot → retry budget reset, should back off from base again
    h.fakeProcesses[1].emitStatus('disconnected', { error: 'drop' });
    expect(h.scheduled[1].delay).toBe(100); // base * 2^0 again (reset), not 200

    // There should be NO give-up audit because we haven't exhausted attempts
    expect(h.audits.some((a) => a.detail?.includes('gave up'))).toBe(false);
  });
});
