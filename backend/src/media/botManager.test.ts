import { describe, it, expect, vi } from 'vitest';
import { createBotManager } from './botManager.js';
import { createMediaHub } from './hub.js';
import { createFakeBotProcess } from './__fixtures__/fakeBotProcess.js';
import type { BotStatus, ChaperonedMeeting } from '../domain/types.js';

const meeting: ChaperonedMeeting = {
  meetingId: 'm1', sipUri: '12345@site.webex.com', title: 'T', createdAt: 0,
};

describe('createBotManager — dial + status', () => {
  it('dials with the bot display name and ;transport=tls, emitting dialing then connected', async () => {
    const fake = createFakeBotProcess();
    const botFactory = vi.fn().mockReturnValue(fake);
    const statuses: BotStatus[] = [];
    const mgr = createBotManager({ hub: createMediaHub(), botFactory, now: () => 5000 });
    mgr.onStatus((s) => statuses.push(s));

    await mgr.startBot(meeting);

    expect(botFactory).toHaveBeenCalledWith({
      meetingId: 'm1', // scopes the bot's Webex guest identity so 2 bots can run at once
      sipUri: '12345@site.webex.com;transport=tls',
      displayName: 'Compliance Monitor Bot',
    });
    expect(fake.started).toBe(true);
    expect(statuses[0]).toMatchObject({ meetingId: 'm1', state: 'dialing', updatedAt: 5000 });

    fake.emitStatus('connected');
    const connected = statuses.find((s) => s.state === 'connected')!;
    expect(connected).toMatchObject({ meetingId: 'm1', state: 'connected', joinedAt: 5000 });
  });

  it('propagates failed/disconnected with lastError', async () => {
    const fake = createFakeBotProcess();
    const statuses: BotStatus[] = [];
    const mgr = createBotManager({ hub: createMediaHub(), botFactory: () => fake });
    mgr.onStatus((s) => statuses.push(s));
    await mgr.startBot(meeting);

    fake.emitStatus('disconnected', { error: 'rtp timeout' });
    expect(statuses.at(-1)).toMatchObject({ state: 'disconnected', lastError: 'rtp timeout' });
  });

  it('maps an unexpected process exit to a disconnected status', async () => {
    const fake = createFakeBotProcess();
    const statuses: BotStatus[] = [];
    const mgr = createBotManager({ hub: createMediaHub(), botFactory: () => fake });
    mgr.onStatus((s) => statuses.push(s));
    await mgr.startBot(meeting);

    fake.emitExit(1);
    expect(statuses.at(-1)).toMatchObject({ state: 'disconnected', lastError: 'sip process exited' });
    // On an unsolicited exit the manager must still tear the process down: stop() is the only
    // path that closes the BotProcess's loopback WS server, so skipping it leaks a listening
    // socket every crash/retry cycle.
    expect(fake.stopped).toBe(true);
  });

  it('stopBot hangs up the process and emits ended', async () => {
    const fake = createFakeBotProcess();
    const statuses: BotStatus[] = [];
    const mgr = createBotManager({ hub: createMediaHub(), botFactory: () => fake });
    mgr.onStatus((s) => statuses.push(s));
    await mgr.startBot(meeting);

    await mgr.stopBot('m1');
    expect(fake.stopped).toBe(true);
    expect(statuses.at(-1)).toMatchObject({ meetingId: 'm1', state: 'ended' });
  });

  it('joinedAt is first-write-wins: a second connected event does not clobber the original value', async () => {
    let clock = 1000;
    const fake = createFakeBotProcess();
    const statuses: BotStatus[] = [];
    const mgr = createBotManager({ hub: createMediaHub(), botFactory: () => fake, now: () => clock });
    mgr.onStatus((s) => statuses.push(s));
    await mgr.startBot(meeting);

    // First connected at t=1000
    fake.emitStatus('connected');
    const first = statuses.find((s) => s.state === 'connected')!;
    expect(first.joinedAt).toBe(1000);

    // Advance clock and emit connected again (reconnect/re-registration)
    clock = 9999;
    fake.emitStatus('connected');
    const second = statuses.filter((s) => s.state === 'connected').at(-1)!;
    expect(second.joinedAt).toBe(1000); // must still be the original value
  });

  it('multiple onStatus subscribers all receive the same BotStatus', async () => {
    const fake = createFakeBotProcess();
    const received1: BotStatus[] = [];
    const received2: BotStatus[] = [];
    const mgr = createBotManager({ hub: createMediaHub(), botFactory: () => fake });
    mgr.onStatus((s) => received1.push(s));
    mgr.onStatus((s) => received2.push(s));
    await mgr.startBot(meeting);

    fake.emitStatus('connected');

    const conn1 = received1.find((s) => s.state === 'connected');
    const conn2 = received2.find((s) => s.state === 'connected');
    expect(conn1).toBeDefined();
    expect(conn2).toBeDefined();
    expect(conn1).toEqual(conn2);
  });
});

describe('createBotManager — frame publishing', () => {
  it('publishes each SIP frame as a sequenced Opus AudioFrame and makes hub.hasPublisher true', async () => {
    const fake = createFakeBotProcess();
    const hub = createMediaHub();
    const got: import('../domain/types.js').AudioFrame[] = [];
    hub.subscribe('m1', (f) => got.push(f));
    const mgr = createBotManager({ hub, botFactory: () => fake });
    await mgr.startBot({ meetingId: 'm1', sipUri: '1@s.webex.com', title: 'T', createdAt: 0 });

    fake.emitFrame(new Uint8Array([10]), 1111);
    fake.emitFrame(new Uint8Array([20]), 2222);

    expect(got).toHaveLength(2);
    expect(got[0]).toMatchObject({ meetingId: 'm1', seq: 0, timestampMs: 1111, codec: 'opus' });
    expect(got[0].payload).toEqual(new Uint8Array([10]));
    expect(got[1]).toMatchObject({ seq: 1, timestampMs: 2222 });
    expect(hub.hasPublisher('m1')).toBe(true);
  });

  it('seq strictly increases across multiple frames for the same meeting', async () => {
    const fake = createFakeBotProcess();
    const hub = createMediaHub();
    const got: import('../domain/types.js').AudioFrame[] = [];
    hub.subscribe('m1', (f) => got.push(f));
    const mgr = createBotManager({ hub, botFactory: () => fake });
    await mgr.startBot({ meetingId: 'm1', sipUri: '1@s.webex.com', title: 'T', createdAt: 0 });

    fake.emitFrame(new Uint8Array([1]), 100);
    fake.emitFrame(new Uint8Array([2]), 200);
    fake.emitFrame(new Uint8Array([3]), 300);

    expect(got).toHaveLength(3);
    expect(got[0].seq).toBe(0);
    expect(got[1].seq).toBe(1);
    expect(got[2].seq).toBe(2);
    // Each seq must be strictly greater than the previous
    for (let i = 1; i < got.length; i++) {
      expect(got[i].seq).toBeGreaterThan(got[i - 1].seq);
    }
  });

  it('drops frames emitted after stopBot', async () => {
    const fake = createFakeBotProcess();
    const hub = createMediaHub();
    const got: unknown[] = [];
    hub.subscribe('m1', (f) => got.push(f));
    const mgr = createBotManager({ hub, botFactory: () => fake });
    await mgr.startBot({ meetingId: 'm1', sipUri: '1@s.webex.com', title: 'T', createdAt: 0 });

    await mgr.stopBot('m1');
    fake.emitFrame(new Uint8Array([99]), 3333); // stale process emission

    expect(got).toHaveLength(0);
  });
});
