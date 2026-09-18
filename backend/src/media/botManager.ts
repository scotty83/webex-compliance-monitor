import type { AudioFrame, BotState, BotStatus, ChaperonedMeeting } from '../domain/types.js';
import type { BotManager, MediaHub, BotProcess, BotProcessFactory } from './types.js';

export interface BotManagerDeps {
  hub: MediaHub;
  botFactory: BotProcessFactory;
  displayName?: string;
  sipTransport?: string;
  now?: () => number;
}

interface BotRecord {
  meeting: ChaperonedMeeting;
  proc: BotProcess;
  seq: number;
  joinedAt?: number;
  active: boolean;
}

export function createBotManager(deps: BotManagerDeps): BotManager {
  const displayName = deps.displayName ?? 'Compliance Monitor Bot';
  const transport = deps.sipTransport ?? 'tls';
  const now = deps.now ?? Date.now;
  const bots = new Map<string, BotRecord>();
  const statusListeners: Array<(s: BotStatus) => void> = [];

  function emit(meetingId: string, state: BotState, opts: { error?: string; joinedAt?: number } = {}): void {
    const s: BotStatus = { meetingId, state, joinedAt: opts.joinedAt, lastError: opts.error, updatedAt: now() };
    for (const cb of statusListeners) cb(s);
  }

  return {
    async startBot(meeting: ChaperonedMeeting): Promise<void> {
      if (bots.has(meeting.meetingId)) return; // idempotent: already running
      const sipUri = `${meeting.sipUri};transport=${transport}`;
      const spec = {
        meetingId: meeting.meetingId,
        sipUri,
        displayName,
        ...(meeting.dtmf !== undefined ? { dtmf: meeting.dtmf } : {}),
      };
      const proc = deps.botFactory(spec);
      const rec: BotRecord = { meeting, proc, seq: 0, active: true };
      bots.set(meeting.meetingId, rec);

      proc.on('status', (state, info) => {
        if (!rec.active) return;
        if (state === 'connected') {
          if (rec.joinedAt === undefined) rec.joinedAt = now();
          emit(meeting.meetingId, 'connected', { joinedAt: rec.joinedAt });
        } else if (state === 'failed' || state === 'disconnected') {
          // Emit terminal status FIRST so Orchestrator can schedule retry / give up.
          emit(meeting.meetingId, state, { error: info?.error, joinedAt: rec.joinedAt });
          // Free the record so a subsequent startBot() spawns a fresh BotProcess.
          rec.active = false;
          bots.delete(meeting.meetingId);
          rec.proc.stop().catch(() => {}); // best-effort cleanup; errors must not suppress the emit above
        } else {
          emit(meeting.meetingId, state, { joinedAt: rec.joinedAt });
        }
      });

      proc.on('frame', (payload, capturedAt) => {
        if (!rec.active) return;
        const frame: AudioFrame = {
          meetingId: meeting.meetingId,
          seq: rec.seq++,
          timestampMs: capturedAt,
          codec: 'opus',
          payload,
        };
        deps.hub.publish(frame);
      });

      proc.on('exit', () => {
        if (!rec.active) return;
        rec.active = false;
        bots.delete(meeting.meetingId);
        emit(meeting.meetingId, 'disconnected', { error: 'sip process exited', joinedAt: rec.joinedAt });
        // Best-effort teardown on an unsolicited exit (e.g. browser crash): stop() is the only
        // path that closes the BotProcess's loopback WebSocket server. Without this, each
        // crash/retry cycle would strand one listening socket (→ eventual EMFILE). Mirrors the
        // terminal 'status' branch above.
        rec.proc.stop().catch(() => {});
      });

      emit(meeting.meetingId, 'dialing');
      proc.start();
    },

    async stopBot(meetingId: string): Promise<void> {
      const rec = bots.get(meetingId);
      if (!rec) return;
      rec.active = false;
      bots.delete(meetingId);
      await rec.proc.stop();
      emit(meetingId, 'ended', { joinedAt: rec.joinedAt });
    },

    onStatus(cb: (s: BotStatus) => void): void {
      statusListeners.push(cb);
    },
  };
}
