import { describe, it, expect, vi } from 'vitest';
import { WebSocket } from 'ws';
import { createWebexBotProcess, type WebexBotRuntimeDeps } from './webexBotProcess.js';
import type { BotProcessSpec } from './types.js';
import type { BotState } from '../domain/types.js';

// A fake page that captures the injected config + wsUrl and lets the test act as the page.
// evaluate() RUNS the page-side function against a stub `window`, the way Puppeteer runs
// it in the real page, so these tests exercise the actual __BOT_START / __BOT_LEAVE
// wiring instead of a mock of it. `__BOT_LEAVE` is absent unless a test supplies one —
// which is also the real state of a page whose bot core never finished starting.
function makeFakeBrowser(opts: { onLeave?: () => Promise<void> } = {}) {
  const order: string[] = []; // teardown ordering: leave must precede browser close
  const win: { __BOT_START?: (c: unknown, w: unknown) => void; __BOT_LEAVE?: () => Promise<void> } = {};
  const page = {
    injected: undefined as any,
    handlers: {} as Record<string, (...a: unknown[]) => void>,
    goto: vi.fn(async (_url: string) => undefined),
    evaluate: vi.fn(async (fn: (...a: any[]) => unknown, ...args: unknown[]) => {
      const prev = (globalThis as any).window;
      (globalThis as any).window = win;
      try { return await fn(...args); } finally { (globalThis as any).window = prev; }
    }),
    on: (evt: string, cb: (...a: unknown[]) => void) => { page.handlers[evt] = cb; },
    close: vi.fn(async () => undefined),
  };
  win.__BOT_START = (cfg: unknown, wsUrl: unknown) => { page.injected = { cfg, wsUrl }; };
  if (opts.onLeave) {
    win.__BOT_LEAVE = async () => { order.push('leave'); await opts.onLeave!(); };
  }
  const browser = {
    newPage: vi.fn(async () => page),
    close: vi.fn(async () => { order.push('close'); }),
    on: (_e: string, _cb: () => void) => {},
    __page: page,
    __order: order,
  };
  return browser;
}

function makeDeps(browser: ReturnType<typeof makeFakeBrowser>): WebexBotRuntimeDeps {
  return {
    tokenProvider: { getToken: async () => ({ token: 'guest-tok', expiresInS: 3600 }) },
    botPageBaseUrl: 'http://127.0.0.1:9', // unused by the fake page (it doesn't fetch)
    launchBrowser: async () => browser as any,
    wsHost: '127.0.0.1',
  };
}

const spec: BotProcessSpec = {
  meetingId: 'm1', sipUri: '123@site.webex.com;transport=tls', displayName: 'Compliance Monitor Bot', dtmf: 'pw#',
};

/** Connect a WS client to the runner's per-process server, emulating the page. */
async function connectAsPage(wsUrl: string): Promise<WebSocket> {
  const ws = new WebSocket(wsUrl);
  await new Promise<void>((res, rej) => { ws.on('open', () => res()); ws.on('error', rej); });
  return ws;
}

describe('createWebexBotProcess', () => {
  it('mints a guest token and injects config with the transport param stripped and password (never in URL)', async () => {
    const browser = makeFakeBrowser();
    const proc = createWebexBotProcess(spec, makeDeps(browser));
    const states: BotState[] = [];
    proc.on('status', (s) => states.push(s));
    proc.start();
    await vi.waitFor(() => expect(browser.__page.injected).toBeTruthy());

    expect(states[0]).toBe('dialing');
    const { cfg, wsUrl } = browser.__page.injected;
    expect(cfg.token).toBe('guest-tok');
    expect(cfg.destination).toBe('123@site.webex.com'); // ;transport=tls stripped
    expect(cfg.password).toBe('pw'); // dtmf's trailing '#' stripped for the SDK's exact password
    expect(String(wsUrl)).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\//);
    expect(String(browser.__page.goto.mock.calls[0]?.[0] ?? '')).not.toContain('pw#'); // creds never in URL
    await proc.stop();
  });

  it('asks the token provider for a guest identity scoped to THIS meeting (concurrent-bot isolation)', async () => {
    const browser = makeFakeBrowser();
    const requests: Array<{ displayName: string; meetingId: string }> = [];
    const proc = createWebexBotProcess(spec, {
      ...makeDeps(browser),
      tokenProvider: {
        getToken: async (req) => {
          requests.push(req);
          return { token: 'guest-tok', expiresInS: 3600 };
        },
      },
    });
    proc.start();
    await vi.waitFor(() => expect(browser.__page.injected).toBeTruthy());

    // meetingId scopes the Webex guest subject; displayName must NOT vary per bot, because
    // classify.ts finds the bot's own roster row by display name.
    expect(requests).toEqual([{ displayName: 'Compliance Monitor Bot', meetingId: 'm1' }]);
    await proc.stop();
  });

  it('strips exactly one trailing "#" from dtmf when injecting the SDK password', async () => {
    const cases: Array<[string, string]> = [
      ['secret#', 'secret'],
      ['plain', 'plain'],
      ['ends##', 'ends#'],
    ];
    for (const [dtmf, expected] of cases) {
      const browser = makeFakeBrowser();
      const proc = createWebexBotProcess({ ...spec, dtmf }, makeDeps(browser));
      proc.start();
      await vi.waitFor(() => expect(browser.__page.injected).toBeTruthy());
      expect(browser.__page.injected.cfg.password).toBe(expected);
      await proc.stop();
    }
  });

  it('omits password from the injected cfg for an open meeting (no dtmf)', async () => {
    const browser = makeFakeBrowser();
    // No `dtmf` key at all — a legitimate open-meeting spec (BotProcessSpec.dtmf?: string).
    const openSpec: BotProcessSpec = { meetingId: spec.meetingId, sipUri: spec.sipUri, displayName: spec.displayName };
    const proc = createWebexBotProcess(openSpec, makeDeps(browser));
    proc.start();
    await vi.waitFor(() => expect(browser.__page.injected).toBeTruthy());

    const { cfg } = browser.__page.injected;
    expect('password' in cfg).toBe(false);
    await proc.stop();
  });

  it('bridges page "joined" → connected, binary → frame, "ended" → disconnected', async () => {
    const browser = makeFakeBrowser();
    const proc = createWebexBotProcess(spec, makeDeps(browser));
    const states: BotState[] = [];
    const frames: Uint8Array[] = [];
    proc.on('status', (s) => states.push(s));
    proc.on('frame', (p) => frames.push(p));
    proc.start();
    await vi.waitFor(() => expect(browser.__page.injected).toBeTruthy());

    const ws = await connectAsPage(browser.__page.injected.wsUrl);
    ws.send(JSON.stringify({ type: 'joined' }));
    await vi.waitFor(() => expect(states).toContain('connected'));
    ws.send(new Uint8Array([9, 8, 7]));
    await vi.waitFor(() => expect(frames.length).toBe(1));
    expect(Array.from(frames[0])).toEqual([9, 8, 7]);
    ws.send(JSON.stringify({ type: 'ended' }));
    await vi.waitFor(() => expect(states.at(-1)).toBe('disconnected'));
    ws.close();
    await proc.stop();
  });

  it('bridges page "failed" → failed with a sanitized reason', async () => {
    const browser = makeFakeBrowser();
    const proc = createWebexBotProcess(spec, makeDeps(browser));
    const events: Array<{ s: BotState; info?: { error?: string } }> = [];
    proc.on('status', (s, info) => events.push({ s, info }));
    proc.start();
    await vi.waitFor(() => expect(browser.__page.injected).toBeTruthy());
    const ws = await connectAsPage(browser.__page.injected.wsUrl);
    ws.send(JSON.stringify({ type: 'failed', reason: 'password rejected' }));
    await vi.waitFor(() => expect(events.at(-1)?.s).toBe('failed'));
    expect(events.at(-1)?.info?.error).toBe('password rejected');
    ws.close();
    await proc.stop();
  });

  it('emits failed if guest-token mint throws — no browser launched', async () => {
    const browser = makeFakeBrowser();
    const deps = { ...makeDeps(browser), tokenProvider: { getToken: async () => { throw new Error('sa down'); } } };
    const proc = createWebexBotProcess(spec, deps);
    const events: Array<{ s: BotState; info?: { error?: string } }> = [];
    proc.on('status', (s, info) => events.push({ s, info }));
    proc.start();
    await vi.waitFor(() => expect(events.at(-1)?.s).toBe('failed'));
    expect(browser.newPage).not.toHaveBeenCalled();
    await proc.stop();
  });

  it('stop() closes the browser and is idempotent', async () => {
    const browser = makeFakeBrowser();
    const proc = createWebexBotProcess(spec, makeDeps(browser));
    proc.start();
    await vi.waitFor(() => expect(browser.__page.injected).toBeTruthy());
    await proc.stop();
    await proc.stop();
    expect(browser.close).toHaveBeenCalledTimes(1);
  });

  it('passes page.evaluate a function reference, not a string (Finding 1 regression)', async () => {
    const browser = makeFakeBrowser();
    const proc = createWebexBotProcess(spec, makeDeps(browser));
    proc.start();
    await vi.waitFor(() => expect(browser.__page.injected).toBeTruthy());

    expect(typeof browser.__page.evaluate.mock.calls[0][0]).toBe('function');
    await proc.stop();
  });

  it('sanitizes a "failed" reason containing digit runs before emitting status (Finding 2 regression)', async () => {
    const browser = makeFakeBrowser();
    const proc = createWebexBotProcess(spec, makeDeps(browser));
    const events: Array<{ s: BotState; info?: { error?: string } }> = [];
    proc.on('status', (s, info) => events.push({ s, info }));
    proc.start();
    await vi.waitFor(() => expect(browser.__page.injected).toBeTruthy());
    const ws = await connectAsPage(browser.__page.injected.wsUrl);
    ws.send(JSON.stringify({ type: 'failed', reason: 'invalid password 1234' }));
    await vi.waitFor(() => expect(events.at(-1)?.s).toBe('failed'));
    expect(events.at(-1)?.info?.error).toContain('****');
    expect(events.at(-1)?.info?.error).not.toContain('1234');
    ws.close();
    await proc.stop();
  });

  it('stop() racing an in-flight launchBrowser() waits for it and closes the browser without opening a page (Finding 4 regression)', async () => {
    const browser = makeFakeBrowser();
    let launchInvoked = false;
    let resolveLaunch!: (b: ReturnType<typeof makeFakeBrowser>) => void;
    const deferred = new Promise<ReturnType<typeof makeFakeBrowser>>((res) => { resolveLaunch = res; });
    const deps: WebexBotRuntimeDeps = {
      ...makeDeps(browser),
      launchBrowser: async () => {
        launchInvoked = true;
        return (await deferred) as any;
      },
    };
    const proc = createWebexBotProcess(spec, deps);
    proc.start();
    await vi.waitFor(() => expect(launchInvoked).toBe(true));

    const p = proc.stop(); // races the in-flight launch
    resolveLaunch(browser);
    await p;

    expect(browser.close).toHaveBeenCalledTimes(1);
    expect(browser.newPage).not.toHaveBeenCalled();
  });

  // Killing Chromium is not a goodbye. Without an explicit leave the guest lingers on the
  // Webex roster until the media timeout (tens of seconds), and the device stays registered
  // server-side — so the next bot for this meeting, which derives the SAME deterministic
  // guest subject, collides with it (HTTP 409 / "Confluence url for the device is null").
  it('stop() asks the page to leave (and unregister) BEFORE closing the browser', async () => {
    const browser = makeFakeBrowser({ onLeave: async () => {} });
    const proc = createWebexBotProcess(spec, makeDeps(browser));
    proc.start();
    await vi.waitFor(() => expect(browser.__page.injected).toBeTruthy());

    await proc.stop();
    expect(browser.__order).toEqual(['leave', 'close']);
  });

  it('stop() closes the browser anyway when the page leave hook hangs (teardown is bounded)', async () => {
    const browser = makeFakeBrowser({ onLeave: () => new Promise<void>(() => {}) }); // never settles
    const proc = createWebexBotProcess(spec, { ...makeDeps(browser), leaveTimeoutMs: 20 });
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')); });
    try {
      proc.start();
      await vi.waitFor(() => expect(browser.__page.injected).toBeTruthy());
      await proc.stop(); // must not block on the wedged page
    } finally {
      spy.mockRestore();
    }

    expect(browser.__order).toEqual(['leave', 'close']); // leave was attempted, then abandoned
    expect(lines.some((l) => l.includes('LOUD') && l.includes('timed out'))).toBe(true);
  });

  it('stop() closes the browser anyway when the page leave hook throws, and says so LOUDly', async () => {
    const browser = makeFakeBrowser({ onLeave: async () => { throw new Error('renderer gone'); } });
    const proc = createWebexBotProcess(spec, makeDeps(browser));
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')); });
    try {
      proc.start();
      await vi.waitFor(() => expect(browser.__page.injected).toBeTruthy());
      await proc.stop();
    } finally {
      spy.mockRestore();
    }

    expect(browser.close).toHaveBeenCalledTimes(1);
    // A device we could not release is a real monitoring hazard for the NEXT bot — never silent.
    expect(lines.some((l) => l.includes('LOUD') && l.includes('leave'))).toBe(true);
  });

  it('stop() is safe when the page loaded but __BOT_LEAVE was never assigned (bot core never started)', async () => {
    const browser = makeFakeBrowser(); // no leave hook on the stub window
    const proc = createWebexBotProcess(spec, makeDeps(browser));
    proc.start();
    await vi.waitFor(() => expect(browser.__page.injected).toBeTruthy());

    await expect(proc.stop()).resolves.toBeUndefined();
    expect(browser.close).toHaveBeenCalledTimes(1);
  });

  it('stop() is safe when no page was ever opened (launch failed before newPage)', async () => {
    const browser = makeFakeBrowser();
    const deps = { ...makeDeps(browser), tokenProvider: { getToken: async () => { throw new Error('sa down'); } } };
    const proc = createWebexBotProcess(spec, deps);
    const states: BotState[] = [];
    proc.on('status', (s) => states.push(s));
    proc.start();
    await vi.waitFor(() => expect(states.at(-1)).toBe('failed'));

    await expect(proc.stop()).resolves.toBeUndefined();
    expect(browser.__page.evaluate).not.toHaveBeenCalled();
  });

  // botManager calls stop() from BOTH the terminal-status branch and the 'exit' handler,
  // so a crashing bot tears down twice; the second pass must be a no-op, not a second leave.
  it('stop() called twice leaves exactly once (double teardown is safe)', async () => {
    const browser = makeFakeBrowser({ onLeave: async () => {} });
    const proc = createWebexBotProcess(spec, makeDeps(browser));
    proc.start();
    await vi.waitFor(() => expect(browser.__page.injected).toBeTruthy());

    await proc.stop();
    await proc.stop();
    expect(browser.__order).toEqual(['leave', 'close']);
  });
});
