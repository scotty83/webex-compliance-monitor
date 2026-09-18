import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { mountLiveSocket, type LiveSocketDeps } from './liveSocket.js';
import { createMediaHub } from './hub.js';
import type { AudioFrame } from '../domain/types.js';

let server: Server;
let url: string;
let hub = createMediaHub();
let audits: string[] = [];

// Audit tracking with async waiters. In ws v8 the server-side WebSocket fires 'close'
// AFTER the client does (it fires on receiving the client's FIN — one TCP round-trip
// later), so tests must await the audit itself, not the client 'close' event.
// `waitForAudits(predicate)` resolves as soon as the recorded audits satisfy `predicate`
// (checking already-present entries too), which also lets a test wait on a count of N.
type AuditWaiter = { predicate: () => boolean; resolve: () => void };
let auditWaiters: AuditWaiter[] = [];

function recordAudit(action: string, officerEmail?: string) {
  audits.push(`${action}:${officerEmail ?? ''}`);
  auditWaiters = auditWaiters.filter((w) => {
    if (w.predicate()) {
      w.resolve();
      return false;
    }
    return true;
  });
}

function waitForAudits(predicate: () => boolean): Promise<void> {
  if (predicate()) return Promise.resolve();
  return new Promise<void>((r) => auditWaiters.push({ predicate, resolve: r }));
}

// Distinct ids per call mirror production (audit_log.id is a PRIMARY KEY); a fixed id
// would collide once a connection writes both listen_start and listen_stop.
function makeIdGen(): () => string {
  let n = 0;
  return () => `id-${n++}`;
}

function deps(over: Partial<LiveSocketDeps> = {}): LiveSocketDeps {
  return {
    hub,
    verifyToken: (t) => (t === 'good' ? { email: 'officer@x.com', role: 'officer' } : null),
    writeAudit: (e) => recordAudit(e.action, e.officerEmail),
    now: () => 7000,
    newId: makeIdGen(),
    ...over,
  };
}

function pub(meetingId: string) {
  const f: AudioFrame = { meetingId, seq: 0, timestampMs: 1, codec: 'opus', payload: new Uint8Array([1]) };
  hub.publish(f);
}

beforeEach(async () => {
  hub = createMediaHub();
  audits = [];
  auditWaiters = [];
  server = createServer();
  mountLiveSocket(server, deps());
  await new Promise<void>((r) => server.listen(0, r));
  url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(() => new Promise<void>((r) => server.close(() => r())));

function closeCode(path: string): Promise<number> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${url}${path}`);
    ws.on('close', (code) => resolve(code));
    ws.on('error', () => {});
  });
}

describe('mountLiveSocket — auth + reject', () => {
  it('closes 4401 when the token is missing or invalid', async () => {
    pub('m1');
    expect(await closeCode('/live/m1?token=bad')).toBe(4401);
  });

  it('closes 4401 when the token is missing entirely', async () => {
    pub('m1');
    expect(await closeCode('/live/m1')).toBe(4401);
  });

  it('closes 4401 when the role is not officer or admin', async () => {
    pub('m1');
    // Spin up a second server with a verifyToken that returns a non-allowed role
    const srv2 = createServer();
    const badRoleDeps: LiveSocketDeps = {
      ...deps(),
      // force-cast 'viewer' to satisfy TS — simulates a stale/unknown role at runtime
      verifyToken: (_t) => ({ email: 'viewer@x.com', role: 'viewer' as 'officer' }),
    };
    mountLiveSocket(srv2, badRoleDeps);
    await new Promise<void>((r) => srv2.listen(0, r));
    const url2 = `ws://127.0.0.1:${(srv2.address() as AddressInfo).port}`;
    // publish on the same hub so hasPublisher is true
    const code = await new Promise<number>((resolve) => {
      const ws = new WebSocket(`${url2}/live/m1?token=anything`);
      ws.on('close', (c) => resolve(c));
      ws.on('error', () => {});
    });
    await new Promise<void>((r) => srv2.close(() => r()));
    expect(code).toBe(4401);
  });

  it('closes 4404 when the meeting has no connected bot', async () => {
    expect(await closeCode('/live/m1?token=good')).toBe(4404);
  });

  it('rejects (destroys) the socket without crashing when meetingId has malformed percent-encoding', async () => {
    pub('m1');
    // %zz is invalid percent-encoding — decodeURIComponent throws URIError.
    // The server must destroy the socket before reaching auth/hub logic.
    const rejected = await new Promise<boolean>((resolve) => {
      const ws = new WebSocket(`${url}/live/%zz?token=good`);
      // Either the socket errors or is closed without ever opening — both count as rejected.
      ws.on('error', () => resolve(true));
      ws.on('close', () => resolve(true));
      ws.on('open', () => { ws.close(); resolve(false); });
    });
    expect(rejected).toBe(true);

    // Server must still be alive — a subsequent valid request works fine.
    pub('m1');
    const stillAlive = await new Promise<boolean>((resolve) => {
      const ws = new WebSocket(`${url}/live/m1?token=good`);
      ws.on('open', () => { resolve(true); ws.close(); });
      ws.on('close', (code) => {
        if (code !== 1000 && code !== 1005 && code !== 1006) resolve(false);
      });
      ws.on('error', () => resolve(false));
    });
    expect(stillAlive).toBe(true);
  });

  it('accepts connection when token is valid officer and publisher exists', async () => {
    pub('m1');
    const opened = await new Promise<boolean>((resolve) => {
      const ws = new WebSocket(`${url}/live/m1?token=good`);
      ws.on('open', () => { resolve(true); ws.close(); });
      ws.on('close', (code) => {
        if (code !== 1000 && code !== 1005 && code !== 1006) resolve(false);
      });
      ws.on('error', () => resolve(false));
    });
    expect(opened).toBe(true);
  });

  it('accepts connection when token is valid admin and publisher exists', async () => {
    pub('m1');
    const srv2 = createServer();
    const adminDeps: LiveSocketDeps = {
      ...deps(),
      verifyToken: (t) => (t === 'good' ? { email: 'admin@x.com', role: 'admin' } : null),
      // Isolated writeAudit: async close cleanup must not bleed into other tests' audits/signals.
      writeAudit: () => {},
    };
    mountLiveSocket(srv2, adminDeps);
    await new Promise<void>((r) => srv2.listen(0, r));
    const url2 = `ws://127.0.0.1:${(srv2.address() as AddressInfo).port}`;
    const opened = await new Promise<boolean>((resolve) => {
      const ws = new WebSocket(`${url2}/live/m1?token=good`);
      ws.on('open', () => { resolve(true); ws.close(); });
      ws.on('close', (code) => {
        if (code !== 1000 && code !== 1005 && code !== 1006) resolve(false);
      });
      ws.on('error', () => resolve(false));
    });
    await new Promise<void>((r) => srv2.close(() => r()));
    expect(opened).toBe(true);
  });
});

// Message buffering starts at WebSocket construction — before the 'open' event —
// so hello/other frames sent immediately after the upgrade are never dropped.
// (On loopback the server's hello can arrive in the same TCP segment as the 101
// response; ws fires 'open' + 'message' synchronously, but Promise resolution is
// a microtask, meaning a naïve `ws.once('message')` registered AFTER `await open`
// would miss the already-fired event.)
type WsMessage = { data: Buffer; isBinary: boolean };
const _msgState = new WeakMap<WebSocket, { q: WsMessage[]; w: Array<(m: WsMessage) => void> }>();

// `data as Buffer`: ws's message type is RawData (Buffer | ArrayBuffer | Buffer[]).
// With the default ws options used here it always delivers a Buffer, so the cast is
// safe; it would need revisiting only if a test set binaryType: 'arraybuffer'.
function connectOpen(path: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${url}${path}`);
    const state: { q: WsMessage[]; w: Array<(m: WsMessage) => void> } = { q: [], w: [] };
    _msgState.set(ws, state);
    ws.on('message', (data, isBinary) => {
      const m: WsMessage = { data: data as Buffer, isBinary };
      state.w.length > 0 ? state.w.shift()!(m) : state.q.push(m);
    });
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

function nextMessage(ws: WebSocket): Promise<WsMessage> {
  const state = _msgState.get(ws);
  if (state) {
    if (state.q.length > 0) return Promise.resolve(state.q.shift()!);
    return new Promise((r) => state.w.push(r));
  }
  // fallback for ws instances not created via connectOpen
  return new Promise((resolve) =>
    ws.once('message', (data, isBinary) => resolve({ data: data as Buffer, isBinary })),
  );
}

describe('mountLiveSocket — fan-out + audit', () => {
  it('sends hello, fans out binary frames, answers ping, and audits start/stop', async () => {
    pub('m1'); // make hasPublisher true so the upgrade is accepted
    const ws = await connectOpen('/live/m1?token=good');

    const hello = await nextMessage(ws);
    expect(hello.isBinary).toBe(false);
    expect(JSON.parse(hello.data.toString())).toEqual({ type: 'hello', codec: 'opus', sampleRate: 48000 });
    expect(audits).toContain('listen_start:officer@x.com');

    const binaryP = nextMessage(ws);
    hub.publish({ meetingId: 'm1', seq: 1, timestampMs: 9, codec: 'opus', payload: new Uint8Array([7, 8, 9]) });
    const bin = await binaryP;
    expect(bin.isBinary).toBe(true);
    expect(new Uint8Array(bin.data)).toEqual(new Uint8Array([7, 8, 9]));

    const pongP = nextMessage(ws);
    ws.send(JSON.stringify({ type: 'ping' }));
    expect(JSON.parse((await pongP).data.toString())).toEqual({ type: 'pong' });

    // Initiate close and await the server-side listen_stop audit.
    // (ws v8: client 'close' fires before server 'close' — await the audit, not client close.)
    ws.close();
    await waitForAudits(() => audits.includes('listen_stop:officer@x.com'));
    expect(audits).toContain('listen_stop:officer@x.com');
  });

  it('writes listen_stop exactly once when the connection both errors and closes', async () => {
    pub('m1');
    const ws = await connectOpen('/live/m1?token=good');
    await nextMessage(ws); // consume hello
    await waitForAudits(() => audits.includes('listen_start:officer@x.com'));

    ws.on('error', () => {}); // swallow the client-side error from the protocol violation below

    // Send a WS frame with the RSV1 bit set but no permessage-deflate negotiated. The
    // server's receiver rejects it (WS_ERR_UNEXPECTED_RSV_1), emitting 'error' THEN 'close'
    // on the server-side socket — the exact double-fire path the `stopped` guard collapses.
    // byte0 = FIN(0x80)|RSV1(0x40)|opcode text(0x1) = 0xc1; byte1 = MASK(0x80)|len 0 = 0x80.
    const raw = (ws as unknown as { _socket: { write: (b: Buffer) => void } })._socket;
    raw.write(Buffer.from([0xc1, 0x80, 0x00, 0x00, 0x00, 0x00]));

    await waitForAudits(() => audits.includes('listen_stop:officer@x.com'));
    // Give any erroneous second audit a chance to land before asserting exactly-once.
    await new Promise<void>((r) => setTimeout(r, 50));
    expect(audits.filter((a) => a === 'listen_stop:officer@x.com')).toHaveLength(1);
  });

  it('fans out to multiple concurrent subscribers, each with its own subscription + stop audit', async () => {
    pub('m1');
    const a = await connectOpen('/live/m1?token=good');
    const b = await connectOpen('/live/m1?token=good');
    await nextMessage(a); // hello a
    await nextMessage(b); // hello b

    // One publish must reach BOTH independent subscriptions.
    const aBin = nextMessage(a);
    const bBin = nextMessage(b);
    hub.publish({ meetingId: 'm1', seq: 2, timestampMs: 3, codec: 'opus', payload: new Uint8Array([4, 2]) });
    const [ra, rb] = await Promise.all([aBin, bBin]);
    expect(ra.isBinary).toBe(true);
    expect(rb.isBinary).toBe(true);
    expect(new Uint8Array(ra.data)).toEqual(new Uint8Array([4, 2]));
    expect(new Uint8Array(rb.data)).toEqual(new Uint8Array([4, 2]));

    // Each connection writes its own listen_stop on close.
    a.close();
    b.close();
    await waitForAudits(() => audits.filter((x) => x === 'listen_stop:officer@x.com').length === 2);
    expect(audits.filter((x) => x === 'listen_stop:officer@x.com')).toHaveLength(2);
  });
});
