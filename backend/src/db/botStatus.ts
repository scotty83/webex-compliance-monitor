import type { DB } from './index.js';
import type { BotState, BotStatus } from '../domain/types.js';

interface BotStatusRow {
  meeting_id: string;
  state: string;
  joined_at: number | null;
  last_error: string | null;
  updated_at: number;
}

export function upsertBotStatus(db: DB, s: BotStatus): void {
  db.prepare(
    `INSERT INTO bot_status (meeting_id, state, joined_at, last_error, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(meeting_id) DO UPDATE SET
       state = excluded.state,
       joined_at = excluded.joined_at,
       last_error = excluded.last_error,
       updated_at = excluded.updated_at`,
  ).run(s.meetingId, s.state, s.joinedAt ?? null, s.lastError ?? null, s.updatedAt);
}

/**
 * Startup reconciliation. In-memory bot + roster monitoring does not survive a
 * process restart, but `bot_status` persists. Any row still `connected` or
 * `dialing` at boot is stale — a fresh process has no live bot behind it — and
 * would read as false "connected" coverage in the console (a fail-loud
 * violation: it hides a monitoring gap). Mark each such row `disconnected` with
 * a loud reason so the overview shows an honest gap.
 *
 * This ONLY corrects the display; it does not re-join the meeting. Auto-rejoining
 * a meeting still inside its window is the (as-yet-unbuilt) chaperone-gap
 * recovery — calendar sync will NOT do it, because `checkDue` skips any meeting
 * that already has a `meetings` row (reconciliation touches only `bot_status`).
 *
 * Terminal states (`ended` / `failed` / `disconnected`) and `idle` are left
 * untouched. Returns the meetingIds reconciled, so the caller can audit each.
 */
export function reconcileStaleBotStatus(db: DB, now: number = Date.now()): string[] {
  const rows = db
    .prepare(
      `UPDATE bot_status
          SET state = 'disconnected',
              last_error = 'reconciled on startup: the process restarted, so this bot was not actually connected',
              updated_at = ?
        WHERE state IN ('connected', 'dialing')
        RETURNING meeting_id`,
    )
    .all(now) as { meeting_id: string }[];
  return rows.map((r) => r.meeting_id);
}

/** Current bot status, or an `idle` default when no row has been written yet. */
export function getBotStatus(db: DB, meetingId: string): BotStatus {
  const r = db.prepare('SELECT * FROM bot_status WHERE meeting_id = ?').get(meetingId) as BotStatusRow | undefined;
  if (!r) return { meetingId, state: 'idle', updatedAt: Date.now() };
  return {
    meetingId: r.meeting_id,
    state: r.state as BotState,
    joinedAt: r.joined_at ?? undefined,
    lastError: r.last_error ?? undefined,
    updatedAt: r.updated_at,
  };
}
