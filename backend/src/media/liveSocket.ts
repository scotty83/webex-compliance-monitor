import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import type { AuditEntry, Role } from '../domain/types.js';
import type { MediaHub } from './types.js';

export interface LiveSocketDeps {
  hub: MediaHub;
  verifyToken: (token: string) => { email: string; role: Role } | null;
  writeAudit: (e: AuditEntry) => void;
  now?: () => number;
  newId?: () => string;
}

export function mountLiveSocket(server: Server, deps: LiveSocketDeps): void {
  const now = deps.now ?? Date.now;
  const newId = deps.newId ?? randomUUID;
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    let url: URL;
    try {
      url = new URL(req.url ?? '', 'http://localhost');
    } catch {
      socket.destroy();
      return;
    }

    const match = /^\/live\/([^/?]+)$/.exec(url.pathname);
    if (!match) {
      // Not our route — destroy so other upgrade handlers (if any) don't see a consumed socket.
      socket.destroy();
      return;
    }

    let meetingId: string;
    try {
      meetingId = decodeURIComponent(match[1]);
    } catch {
      socket.destroy();
      return;
    }

    // Do NOT log the token — it is a credential.
    const auth = deps.verifyToken(url.searchParams.get('token') ?? '');

    wss.handleUpgrade(req, socket, head, (ws) => {
      if (!auth || (auth.role !== 'officer' && auth.role !== 'admin')) {
        ws.close(4401, 'unauthorized');
        return;
      }
      if (!deps.hub.hasPublisher(meetingId)) {
        ws.close(4404, 'no connected bot');
        return;
      }
      handleConnection(ws, meetingId, auth.email, deps, now, newId);
    });
  });
}

function handleConnection(
  ws: WebSocket,
  meetingId: string,
  officerEmail: string,
  deps: LiveSocketDeps,
  now: () => number,
  newId: () => string,
): void {
  ws.send(JSON.stringify({ type: 'hello', codec: 'opus', sampleRate: 48000 }));
  deps.writeAudit({ id: newId(), action: 'listen_start', meetingId, officerEmail, at: now() });

  // TODO(back-pressure): ws.send() enqueues into Node's unbounded socket write buffer.
  // At ~50 frames/s a slow client that stops draining the TCP window grows the buffer
  // without limit (memory pressure). v1/PoC ships without a bound; a production build
  // should check ws.bufferedAmount and drop frames or close with a policy code.
  const unsubscribe = deps.hub.subscribe(meetingId, (frame) => {
    if (ws.readyState === ws.OPEN) ws.send(frame.payload, { binary: true });
  });

  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    let msg: { type?: string };
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (msg.type === 'ping' && ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: 'pong' }));
    }
  });

  let stopped = false;
  const onEnd = () => {
    if (stopped) return;
    stopped = true;
    unsubscribe();
    deps.writeAudit({ id: newId(), action: 'listen_stop', meetingId, officerEmail, at: now() });
  };
  ws.on('close', onEnd);
  ws.on('error', onEnd);
}
