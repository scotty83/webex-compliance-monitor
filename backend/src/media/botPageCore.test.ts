import { describe, it, expect, vi } from 'vitest';
import { runBotPage, type BotPageDeps } from './botPageCore.js';

// Minimal fake Webex SDK meeting + client.
function makeFakeWebex(opts: { passwordValid?: boolean } = {}) {
  const listeners: Record<string, Array<(...a: unknown[]) => void>> = {};
  const meeting = {
    on: (evt: string, cb: (...a: unknown[]) => void) => { (listeners[evt] ??= []).push(cb); },
    verifyPassword: vi.fn(async () => ({ isPasswordValid: opts.passwordValid ?? true })),
    joinWithMedia: vi.fn(async () => undefined),
    leave: vi.fn(async () => undefined),
    __emit: (evt: string, ...a: unknown[]) => (listeners[evt] ?? []).forEach((cb) => cb(...a)),
  };
  const webex = {
    once: (_evt: string, cb: () => void) => cb(),
    meetings: {
      register: vi.fn(async () => undefined),
      unregister: vi.fn(async () => undefined),
      create: vi.fn(async () => meeting),
    },
  };
  return { webex, meeting };
}

function makeDeps(over: Partial<BotPageDeps> = {}): { deps: BotPageDeps; sent: any[]; audio: Uint8Array[] } {
  const sent: any[] = [];
  const audio: Uint8Array[] = [];
  const deps: BotPageDeps = {
    Webex: undefined,
    makeAudioEncoder: (onChunk) => ({ encode: () => onChunk(new Uint8Array([1, 2, 3])), close: () => {} }),
    makeTrackReader: async function* () { yield {}; },
    makeMixer: () => ({ addStream: () => {}, track: {} }),
    send: (m) => sent.push(m),
    sendAudio: (b) => audio.push(b),
    log: () => {},
    ...over,
  };
  return { deps, sent, audio };
}

// A track reader whose values are pushed in by the test, so we can deterministically
// observe behavior around a specific push (e.g. before/after `leave()`).
function makeControllableReader() {
  const queue: unknown[] = [];
  const waiters: Array<(v: unknown) => void> = [];
  const push = (v: unknown): void => {
    const waiter = waiters.shift();
    if (waiter) waiter(v);
    else queue.push(v);
  };
  const makeTrackReader = (): AsyncIterable<unknown> => ({
    [Symbol.asyncIterator]() {
      return {
        next: async () => {
          if (queue.length) return { value: queue.shift(), done: false };
          const value = await new Promise<unknown>((resolve) => waiters.push(resolve));
          return { value, done: false };
        },
      };
    },
  });
  return { push, makeTrackReader };
}

describe('runBotPage', () => {
  it('registers, creates, verifies password, and joins receive-only transcoded (audio on, video off, no local streams)', async () => {
    const { webex, meeting } = makeFakeWebex();
    const { deps, sent } = makeDeps({ Webex: { init: () => webex } });
    await runBotPage({ token: 't', destination: '123@site.webex.com', password: 'p', displayName: 'Bot' }, deps);

    expect(webex.meetings.register).toHaveBeenCalled();
    expect(webex.meetings.create).toHaveBeenCalledWith('123@site.webex.com');
    expect(meeting.verifyPassword).toHaveBeenCalledWith('p', '');
    const joinArg = (meeting.joinWithMedia as any).mock.calls[0][0];
    // Default mediaMode 'transcoded' → one server-mixed stream: no multistream, no video.
    expect(joinArg.joinOptions).toMatchObject({ enableMultistream: false });
    expect(joinArg.mediaOptions).toMatchObject({ audioEnabled: true, videoEnabled: false });
    expect(joinArg.mediaOptions.localStreams).toBeUndefined(); // publish nothing = receive-only
    expect(sent).toContainEqual({ type: 'joined' });
  });

  it('joins multistream with video-receive on when mediaMode is multistream (remote-audio needs it)', async () => {
    const { webex, meeting } = makeFakeWebex();
    const { deps } = makeDeps({ Webex: { init: () => webex } });
    await runBotPage({ token: 't', destination: 'd', displayName: 'Bot', mediaMode: 'multistream' }, deps);
    const joinArg = (meeting.joinWithMedia as any).mock.calls[0][0];
    expect(joinArg.joinOptions).toMatchObject({ enableMultistream: true });
    expect(joinArg.mediaOptions).toMatchObject({ audioEnabled: true, videoEnabled: true });
    expect(joinArg.mediaOptions.localStreams).toBeUndefined();
  });

  it('reports failed (not joined) when the password is rejected — and never leaks the password', async () => {
    const { webex } = makeFakeWebex({ passwordValid: false });
    const { deps, sent } = makeDeps({ Webex: { init: () => webex } });
    await runBotPage({ token: 't', destination: 'd', password: 'secret', displayName: 'Bot' }, deps);
    const failed = sent.find((m) => m.type === 'failed');
    expect(failed).toBeTruthy();
    expect(JSON.stringify(sent)).not.toContain('secret');
    expect(sent).not.toContainEqual({ type: 'joined' });
  });

  it('forwards encoded audio chunks from the remote audio track', async () => {
    const { webex, meeting } = makeFakeWebex();
    const { deps, audio } = makeDeps({ Webex: { init: () => webex } });
    await runBotPage({ token: 't', destination: 'd', displayName: 'Bot' }, deps);
    // Simulate the SDK delivering remote audio via the multistream group event.
    meeting.__emit('media:remoteAudio:created', { getRemoteMedia: () => [{ stream: {} }] });
    // let the async track reader run
    await new Promise((r) => setTimeout(r, 0));
    expect(audio.length).toBeGreaterThan(0);
    expect(Array.from(audio[0])).toEqual([1, 2, 3]);
  });

  it('reports ended when the meeting emits a self-left/ended state', async () => {
    const { webex, meeting } = makeFakeWebex();
    const { deps, sent } = makeDeps({ Webex: { init: () => webex } });
    await runBotPage({ token: 't', destination: 'd', displayName: 'Bot' }, deps);
    meeting.__emit('meeting:self:left');
    expect(sent).toContainEqual({ type: 'ended' });
  });

  it('scrubs the password and token out of a generic failure reason (no secret leakage)', async () => {
    const password = 'Sup3rSecretPW';
    const token = 'tok-ABCDEFGHIJKLMN';
    const webex = {
      once: (_evt: string, cb: () => void) => cb(),
      meetings: {
        register: vi.fn(async () => undefined),
        create: vi.fn(async () => {
          throw new Error(`boom pw=${password} token=${token} failed`);
        }),
      },
    };
    const { deps, sent } = makeDeps({ Webex: { init: () => webex } });
    await runBotPage({ token, destination: 'd', password, displayName: 'Bot' }, deps);

    const failed = sent.find((m) => m.type === 'failed');
    expect(failed).toBeTruthy();
    expect(String(failed.reason)).not.toContain(password);
    expect(String(failed.reason)).not.toContain(token);
    expect(JSON.stringify(sent)).not.toContain(password);
    expect(JSON.stringify(sent)).not.toContain(token);
  });

  it('redacts a long digit run in a generic failure reason unrelated to the known secrets', async () => {
    const webex = {
      once: (_evt: string, cb: () => void) => cb(),
      meetings: {
        register: vi.fn(async () => undefined),
        create: vi.fn(async () => {
          throw new Error('internal ref 4155551212 failed');
        }),
      },
    };
    const { deps, sent } = makeDeps({ Webex: { init: () => webex } });
    await runBotPage(
      { token: 'tok-ABCDEFGHIJKLMN', destination: 'd', password: 'Sup3rSecretPW', displayName: 'Bot' },
      deps,
    );

    const failed = sent.find((m) => m.type === 'failed');
    expect(failed).toBeTruthy();
    expect(String(failed.reason)).toContain('****');
    expect(String(failed.reason)).not.toContain('4155551212');
  });

  it('stops forwarding audio once leave() is called (cancels the in-flight track reader)', async () => {
    const { webex, meeting } = makeFakeWebex();
    const { push, makeTrackReader } = makeControllableReader();
    const { deps, audio } = makeDeps({ Webex: { init: () => webex }, makeTrackReader });
    const { leave } = await runBotPage({ token: 't', destination: 'd', displayName: 'Bot' }, deps);

    meeting.__emit('media:remoteAudio:created', { getRemoteMedia: () => [{ stream: {} }] });
    // Let the reader loop start and register its wait for the first value.
    await new Promise((r) => setTimeout(r, 0));
    push({});
    await new Promise((r) => setTimeout(r, 0));
    expect(audio.length).toBe(1);

    await leave();
    // Push another chunk after leave(); it must not be encoded/forwarded.
    push({});
    await new Promise((r) => setTimeout(r, 0));
    expect(audio.length).toBe(1);
  });

  // WebCodecs: AudioEncoder.encode() does NOT take ownership of the AudioData, so a
  // frame that is never close()d leaks its off-heap buffer. At ~50 frames/s an
  // unclosed loop OOM-kills the bot tab mid-meeting — monitoring dies silently.
  it('closes every AudioData frame after encoding, including the frame that arrives after leave()', async () => {
    const { webex, meeting } = makeFakeWebex();
    const { push, makeTrackReader } = makeControllableReader();
    const { deps, audio } = makeDeps({ Webex: { init: () => webex }, makeTrackReader });
    const { leave } = await runBotPage({ token: 't', destination: 'd', displayName: 'Bot' }, deps);

    meeting.__emit('media:remoteAudio:created', { getRemoteMedia: () => [{ stream: {} }] });
    await new Promise((r) => setTimeout(r, 0));

    const frames = [0, 1, 2].map(() => ({ close: vi.fn() }));
    for (const f of frames.slice(0, 2)) {
      push(f);
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(audio.length).toBe(2);
    // Encoded frames are released immediately, not retained.
    expect(frames[0].close).toHaveBeenCalledTimes(1);
    expect(frames[1].close).toHaveBeenCalledTimes(1);

    // The frame delivered after leave() is dropped rather than encoded — but it must
    // still be closed, or the shutdown path leaks the last buffer.
    await leave();
    push(frames[2]);
    await new Promise((r) => setTimeout(r, 0));
    expect(audio.length).toBe(2);
    expect(frames[2].close).toHaveBeenCalledTimes(1);
  });

  // Teardown must release BOTH things the bot holds: the roster seat (meeting.leave)
  // and the Webex device registration (meetings.unregister). Each bot derives a
  // DETERMINISTIC guest subject from its meetingId, so a bot that flaps re-registers
  // the same subject ~1s later; if the old device is still registered, Webex answers
  // 409 / "Confluence url for the device is null" and the retry fails for a reason
  // that looks like a concurrency bug.
  it('leave() unregisters the Webex device as well as leaving the meeting (releases the guest identity)', async () => {
    const { webex, meeting } = makeFakeWebex();
    const { deps } = makeDeps({ Webex: { init: () => webex } });
    const { leave } = await runBotPage({ token: 't', destination: 'd', displayName: 'Bot' }, deps);

    await leave();
    expect(meeting.leave).toHaveBeenCalledTimes(1);
    expect(webex.meetings.unregister).toHaveBeenCalledTimes(1);
  });

  it('leave() still unregisters when meeting.leave() throws (one failure must not skip the other)', async () => {
    const { webex, meeting } = makeFakeWebex();
    meeting.leave.mockRejectedValueOnce(new Error('already gone'));
    const { deps } = makeDeps({ Webex: { init: () => webex } });
    const { leave } = await runBotPage({ token: 't', destination: 'd', displayName: 'Bot' }, deps);

    await expect(leave()).resolves.toBeUndefined();
    expect(webex.meetings.unregister).toHaveBeenCalledTimes(1);
  });

  it('leave() never throws when unregister() fails — it runs on the teardown path', async () => {
    const { webex, meeting } = makeFakeWebex();
    webex.meetings.unregister.mockRejectedValueOnce(new Error('device already released'));
    const { deps } = makeDeps({ Webex: { init: () => webex } });
    const { leave } = await runBotPage({ token: 't', destination: 'd', displayName: 'Bot' }, deps);

    await expect(leave()).resolves.toBeUndefined();
    expect(meeting.leave).toHaveBeenCalledTimes(1);
  });

  // The flap that actually bites: join fails, so there is no meeting to leave — but
  // register() already succeeded, so the device IS live and must still be released.
  it('leave() unregisters even when the join failed and there is no meeting to leave', async () => {
    const { webex } = makeFakeWebex();
    webex.meetings.create = vi.fn(async () => { throw new Error('join blew up'); });
    const { deps, sent } = makeDeps({ Webex: { init: () => webex } });
    const { leave } = await runBotPage({ token: 't', destination: 'd', displayName: 'Bot' }, deps);
    expect(sent.find((m) => m.type === 'failed')).toBeTruthy();

    await expect(leave()).resolves.toBeUndefined();
    expect(webex.meetings.unregister).toHaveBeenCalledTimes(1);
  });
});
