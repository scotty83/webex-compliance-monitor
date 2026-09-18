import { randomUUID } from 'node:crypto';
import type { AuditAction, AuditEntry, BotStatus, ChaperonedMeeting } from '../domain/types.js';
import type { BotManager } from './types.js';

export interface OrchestratorDeps {
  botManager: BotManager;
  upsertBotStatus: (s: BotStatus) => void;
  writeAudit: (e: AuditEntry) => void;
  now?: () => number;
  newId?: () => string;
  /** Retry/backoff config. Defaults: maxAttempts=5, baseDelayMs=1000, maxDelayMs=30000. */
  retry?: { maxAttempts?: number; baseDelayMs?: number; maxDelayMs?: number };
  /**
   * Injectable scheduler — receives a callback and delay (ms); fires callback after delay.
   * Default: `setTimeout(fn, ms).unref()` so pending retries never keep the process alive.
   * Tests inject a synchronous fake to drive retries without real timers.
   */
  scheduleRetry?: (fn: () => void, delayMs: number) => void;
}

export interface Orchestrator {
  registerMeeting(meeting: ChaperonedMeeting): Promise<void>;
  /** An optional reason (e.g. 'solitude') lands in the bot_leave
   *  audit `detail` when the bot's terminal 'ended' status arrives. */
  deregisterMeeting(meetingId: string, reason?: string): Promise<void>;
  stopAll(): Promise<void>;
}

export function createOrchestrator(deps: OrchestratorDeps): Orchestrator {
  const now = deps.now ?? Date.now;
  const newId = deps.newId ?? randomUUID;

  const maxAttempts = deps.retry?.maxAttempts ?? 5;
  const baseDelayMs = deps.retry?.baseDelayMs ?? 1_000;
  const maxDelayMs = deps.retry?.maxDelayMs ?? 30_000;

  const scheduleRetry =
    deps.scheduleRetry ??
    ((fn: () => void, ms: number) => {
      setTimeout(fn, ms).unref();
    });

  // Keyed by meetingId.
  const meetings = new Map<string, ChaperonedMeeting>();

  // Deduplication guard: tracks the last audited state per meeting.
  const lastState = new Map<string, string>();

  // Per-meeting retry attempt counter; reset on `connected`.
  const attempts = new Map<string, number>();

  // Gate: tracks meetings that have reached the give-up state so the give-up
  // audit fires exactly once per failure episode (cleared on `connected` or deregister).
  const gaveUp = new Set<string>();

  // Reason recorded by deregisterMeeting(id, reason), consumed by the
  // next 'ended' status → bot_leave audit detail (e.g. 'solitude').
  const leaveReasons = new Map<string, string>();

  function audit(action: AuditAction, meetingId: string, detail?: string): AuditEntry {
    return { id: newId(), action, meetingId, detail, at: now() };
  }

  function handleStatus(s: BotStatus): void {
    // Persist every transition so GET /meetings reflects live state (fail-LOUD).
    deps.upsertBotStatus(s);

    // Deduplication: only write an audit entry when the state actually changes.
    const isDuplicate = lastState.get(s.meetingId) === s.state;
    if (!isDuplicate) {
      lastState.set(s.meetingId, s.state);
      switch (s.state) {
        case 'connected':
          deps.writeAudit(audit('bot_join', s.meetingId));
          break;
        case 'ended': {
          const reason = leaveReasons.get(s.meetingId);
          leaveReasons.delete(s.meetingId); // consume once — no stale reasons
          deps.writeAudit(audit('bot_leave', s.meetingId, reason));
          break;
        }
        case 'disconnected':
          deps.writeAudit(audit('bot_error', s.meetingId, s.lastError ?? 'bot disconnected'));
          break;
        case 'failed':
          deps.writeAudit(audit('bot_error', s.meetingId, s.lastError));
          break;
        default:
          // 'idle', 'dialing': persisted only, no audit entry
          break;
      }
    }

    // ── Retry / backoff logic (runs regardless of deduplication guard) ──────
    if (s.state === 'failed' || s.state === 'disconnected') {
      const meeting = meetings.get(s.meetingId);
      if (meeting) {
        const n = attempts.get(s.meetingId) ?? 0;
        if (n < maxAttempts) {
          const delay = Math.min(baseDelayMs * 2 ** n, maxDelayMs);
          attempts.set(s.meetingId, n + 1);
          scheduleRetry(() => {
            // Guard: if the meeting was deregistered while the timer was pending, skip.
            if (!meetings.has(s.meetingId)) return;
            void deps.botManager.startBot(meeting);
          }, delay);
        } else if (!gaveUp.has(s.meetingId)) {
          // Give up LOUDLY (exactly once per episode): persist terminal failed status + audit.
          gaveUp.add(s.meetingId);
          const giveUpError = `gave up after ${maxAttempts} retries`;
          deps.upsertBotStatus({
            meetingId: s.meetingId,
            state: 'failed',
            lastError: giveUpError,
            updatedAt: now(),
          });
          deps.writeAudit(audit('bot_error', s.meetingId, giveUpError));
        }
      }
    }

    // Reset attempt counter (and give-up gate) when the bot successfully connects.
    if (s.state === 'connected') {
      attempts.delete(s.meetingId);
      gaveUp.delete(s.meetingId);
    }
  }

  deps.botManager.onStatus(handleStatus);

  async function teardown(meetingId: string): Promise<void> {
    meetings.delete(meetingId);   // pending retry callbacks check this and will no-op
    attempts.delete(meetingId);
    gaveUp.delete(meetingId);     // clear so a re-registered meeting starts a fresh episode
    lastState.delete(meetingId);  // clear so a re-registered meeting audits fresh
    // NOTE: leaveReasons is intentionally NOT cleared here — the terminal
    // 'ended' status that consumes it may arrive after stopBot resolves.
    // Staleness safety lives in registerMeeting (fresh episode clears it).
    await deps.botManager.stopBot(meetingId);
  }

  return {
    async registerMeeting(meeting: ChaperonedMeeting): Promise<void> {
      if (!meetings.has(meeting.meetingId)) {
        // Fresh episode: drop any unconsumed leave reason from a previous
        // episode and reset the audit-dedup guard (a post-teardown 'ended'
        // leaves lastState at 'ended', which would swallow the next bot_leave).
        leaveReasons.delete(meeting.meetingId);
        lastState.delete(meeting.meetingId);
      }
      meetings.set(meeting.meetingId, meeting);
      deps.upsertBotStatus({ meetingId: meeting.meetingId, state: 'idle', updatedAt: now() });
      await deps.botManager.startBot(meeting);
    },

    async deregisterMeeting(meetingId: string, reason?: string): Promise<void> {
      // Record BEFORE teardown: botManager emits 'ended' synchronously inside
      // the awaited stopBot, and handleStatus reads the reason at that moment.
      if (reason !== undefined) leaveReasons.set(meetingId, reason);
      await teardown(meetingId);
    },

    async stopAll(): Promise<void> {
      const ids = [...meetings.keys()]; // snapshot before mutation
      await Promise.allSettled(ids.map((id) => teardown(id)));
    },
  };
}
