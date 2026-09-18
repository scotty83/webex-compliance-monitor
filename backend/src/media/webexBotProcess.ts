import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import type { BotState } from '../domain/types.js';
import type { BotEventMap, BotProcess, BotProcessSpec } from './types.js';
import type { BotTokenProvider } from '../webex/botToken.js';

/** Minimal structural view of Puppeteer so tests need no real Chromium. */
export interface PageLike {
  goto(url: string): Promise<unknown>;
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  evaluate(fn: (...args: any[]) => unknown, ...args: unknown[]): Promise<unknown>;
  on(event: string, cb: (...a: unknown[]) => void): void;
  close(): Promise<void>;
}
export interface BrowserLike {
  newPage(): Promise<PageLike>;
  close(): Promise<void>;
  on(event: string, cb: () => void): void;
}

export interface WebexBotRuntimeDeps {
  tokenProvider: BotTokenProvider;
  botPageBaseUrl: string;
  launchBrowser: () => Promise<BrowserLike>;
  wsHost?: string;
  /** Remote-audio mode passed to the bot page (default 'transcoded'). */
  mediaMode?: 'transcoded' | 'multistream';
  /** Bound on the page's graceful leave during stop() (default LEAVE_TIMEOUT_MS). Tests shorten it. */
  leaveTimeoutMs?: number;
}

/** How long stop() waits for the page to leave the meeting and unregister its Webex device
 *  before killing Chromium anyway. Generous next to a healthy leave+unregister round trip
 *  (sub-second), tight enough that a wedged renderer cannot stall the bot lifecycle: teardown
 *  ALWAYS completes. Note the orchestrator's first retry lands ~1s after a terminal status, so
 *  this bound caps the damage of a hang — it does not by itself order teardown before a retry. */
const LEAVE_TIMEOUT_MS = 4_000;

/** Strip a SIP transport param — the SDK's meetings.create() wants a bare SIP address. */
function toDestination(sipUri: string): string {
  return sipUri.split(';')[0].trim();
}

/** The meeting record's `dtmf` field carries the SIP-DTMF form "password + #".
 *  The Webex SDK's verifyPassword() wants the exact password, so strip the one
 *  trailing '#' the dtmf convention appends. */
function toPassword(dtmf: string): string {
  return dtmf.replace(/#$/, '');
}

/** Redact long digit runs (tokens/PINs) and cap length before this hits logs or status payloads. */
function sanitize(s: string): string {
  return s.replace(/\d{4,}/g, '****').slice(0, 200);
}

export function createWebexBotProcess(spec: BotProcessSpec, deps: WebexBotRuntimeDeps): BotProcess {
  const ee = new EventEmitter();
  const wsHost = deps.wsHost ?? '127.0.0.1';
  const nonce = randomUUID();
  let wss: WebSocketServer | null = null;
  let browser: BrowserLike | null = null;
  // Kept beyond launchAndInject so stop() can ask the page to leave before we kill Chromium.
  let page: PageLike | null = null;
  let stopped = false;
  let launching: Promise<void> | null = null;

  const emitStatus = (state: BotState, info?: { error?: string }) => ee.emit('status', state, info);

  async function launchAndInject(wsUrl: string): Promise<void> {
    // Mint the guest token FIRST — a failure here must fail before any browser cost.
    // The meetingId goes with it: the provider scopes the Webex guest identity to this
    // meeting, which is what lets two bots run at once without colliding on one device.
    const { token } = await deps.tokenProvider.getToken({
      displayName: spec.displayName,
      meetingId: spec.meetingId,
    });
    if (stopped) return;
    browser = await deps.launchBrowser(); // assign even if stop() raced; stop() closes it
    if (stopped) return; // do not open pages once stopping
    browser.on('disconnected', () => { if (!stopped) ee.emit('exit', null); });
    page = await browser.newPage();
    // Surface everything the bot page emits so a lobby/join failure is visible in the
    // container logs (the SDK, WebRTC, and our page code all report here). Secrets (the
    // access token + meeting password) are scrubbed before anything reaches a log line.
    const scrub = (s: string): string => {
      let out = s;
      for (const secret of [token, spec.dtmf]) if (secret) out = out.split(secret).join('***');
      return sanitize(out);
    };
    page.on('console', (...a: unknown[]) => {
      const m = a[0] as { type?: () => string; text?: () => string } | undefined;
      console.error(`[webex-bot] page.console ${m?.type?.() ?? ''}: ${scrub(m?.text?.() ?? '')}`);
    });
    page.on('pageerror', (...a: unknown[]) => {
      const e = a[0] as { message?: string } | undefined;
      console.error(`[webex-bot] page.pageerror: ${scrub(e?.message ?? String(a[0]))}`);
    });
    page.on('requestfailed', (...a: unknown[]) => {
      const r = a[0] as { url?: () => string; failure?: () => { errorText?: string } | null } | undefined;
      console.error(`[webex-bot] page.requestfailed: ${r?.url?.() ?? ''} ${r?.failure?.()?.errorText ?? ''}`);
    });
    if (stopped) return;
    // Config goes through evaluate (page context), NEVER the URL — creds must not
    // appear in navigation history, access logs, or crash dumps.
    await page.goto(`${deps.botPageBaseUrl}/index.html`);
    if (stopped) return;
    const cfg = {
      token,
      destination: toDestination(spec.sipUri),
      displayName: spec.displayName,
      mediaMode: deps.mediaMode ?? 'transcoded',
      ...(spec.dtmf !== undefined ? { password: toPassword(spec.dtmf) } : {}),
    };
    await page.evaluate(
      (c: unknown, w: unknown) => (window as unknown as { __BOT_START: (c: unknown, w: unknown) => void }).__BOT_START(c, w),
      cfg,
      wsUrl,
    );
  }

  /** Say goodbye properly before Chromium dies: the page's leave() exits the meeting AND
   *  unregisters the Webex device. Closing the browser alone does neither — the guest lingers
   *  on the roster until the media timeout (a ghost participant, visible to the people being
   *  chaperoned), and the still-registered device collides with the next bot for this meeting,
   *  which derives the same deterministic guest subject. Best-effort and time-bounded: a page
   *  that cannot be reached is logged LOUD, never allowed to stall teardown. */
  async function leaveViaPage(): Promise<void> {
    if (!page) return; // launch never got as far as opening a page — nothing joined, nothing to release
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timedOut = await Promise.race([
        // __BOT_LEAVE is assigned only once the bot core has started; if the page never got
        // that far the optional call is a no-op, which is the correct behaviour here.
        page.evaluate(() => (window as unknown as { __BOT_LEAVE?: () => Promise<void> }).__BOT_LEAVE?.())
          .then(() => false),
        new Promise<boolean>((res) => { timer = setTimeout(() => res(true), deps.leaveTimeoutMs ?? LEAVE_TIMEOUT_MS); }),
      ]);
      if (timedOut) {
        console.error('[webex-bot] LOUD: graceful leave timed out — killing the browser with the ' +
          'Webex device possibly still registered; a fast rejoin for this meeting may hit a 409');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[webex-bot] LOUD: graceful leave failed (${sanitize(msg)}) — the guest may linger ` +
        'on the roster and its Webex device may stay registered');
    } finally {
      clearTimeout(timer); // never leave a pending timer holding the event loop open
    }
  }

  return {
    on<E extends keyof BotEventMap>(event: E, listener: (...args: BotEventMap[E]) => void) {
      ee.on(event as string, listener as (...args: unknown[]) => void);
      return this;
    },

    start() {
      emitStatus('dialing');
      // Per-process loopback WS: the page connects here to stream audio + control.
      wss = new WebSocketServer({ host: wsHost, port: 0, path: `/${nonce}` });
      wss.on('connection', (ws: WebSocket) => {
        ws.on('message', (data: Buffer, isBinary: boolean) => {
          if (stopped) return;
          if (isBinary) { ee.emit('frame', new Uint8Array(data), Date.now()); return; }
          let msg: { type?: string; reason?: string };
          try { msg = JSON.parse(data.toString()); } catch { return; }
          switch (msg.type) {
            case 'joined':
              console.error('[webex-bot] page reported: joined (join resolved — in-meeting, or in-lobby with media)');
              emitStatus('connected');
              break;
            case 'failed':
              console.error(`[webex-bot] page reported: FAILED — ${sanitize(msg.reason ?? 'join failed')}`);
              emitStatus('failed', { error: sanitize(msg.reason ?? 'join failed') });
              break;
            case 'ended':
              console.error('[webex-bot] page reported: meeting ended / self left (an un-admitted lobby timeout looks like this)');
              emitStatus('disconnected', { error: 'meeting ended' });
              break;
            case 'log':
              console.error(`[webex-bot] page: ${sanitize((msg as { line?: string }).line ?? '')}`);
              break;
            default:
              break; // members overlay handled by a later wiring task; ignore here
          }
        });
      });
      wss.on('listening', () => {
        if (stopped) return;
        const { port } = wss!.address() as AddressInfo;
        const wsUrl = `ws://${wsHost}:${port}/${nonce}`;
        launching = launchAndInject(wsUrl).catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[webex-bot] launch failed (before/at join): ${sanitize(msg)}`);
          emitStatus('failed', { error: `bot launch failed: ${sanitize(msg)}` });
          if (wss) { wss.close(); wss = null; } // close loopback WS on internal failure (idempotent with stop)
        });
      });
    },

    async stop() {
      if (stopped) return; // botManager tears down from both the terminal-status branch and 'exit'
      stopped = true;
      try { await launching; } catch { /* launch settled/failed; handled */ }
      await leaveViaPage(); // graceful goodbye first — bounded, never throws
      try { await browser?.close(); } catch { /* already gone */ }
      await new Promise<void>((res) => (wss ? wss.close(() => res()) : res()));
    },
  };
}
