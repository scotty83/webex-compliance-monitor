import type { DB } from './index.js';
import type { ParticipantRole, RosterAttendee } from '../domain/types.js';

interface PresenceRow {
  meeting_id: string;
  participant_id: string;
  name: string;
  role: string;
  is_host: number;
  joined_at: number;
  left_at: number | null;
  updated_at: number;
  pstn: number;             // 0 | 1
  phone: string | null;
}

function toAttendee(r: PresenceRow): RosterAttendee {
  return {
    id: r.participant_id,
    name: r.name,
    role: r.role as ParticipantRole,
    isHost: r.is_host === 1,
    joinedAt: r.joined_at,
    leftAt: r.left_at,
    ...(r.pstn === 1 ? { pstn: true as const } : {}),
    ...(r.phone != null ? { phone: r.phone } : {}),
  };
}

/** Persist a full roster snapshot (one row per participant, upsert-in-place).
 *  Wrapped in a transaction so a poll's snapshot applies atomically —
 *  a failure (e.g. FK after DELETE /meetings) leaves no partial rows. */
export function upsertPresence(db: DB, meetingId: string, roster: RosterAttendee[]): void {
  const stmt = db.prepare(
    `INSERT INTO roster_presence
       (meeting_id, participant_id, name, role, is_host, joined_at, left_at, updated_at, pstn, phone)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(meeting_id, participant_id) DO UPDATE SET
       name = excluded.name,
       role = excluded.role,
       is_host = excluded.is_host,
       -- keep the EARLIEST first-join defensively: the caller (rosterMonitor)
       -- preserves joinedAt across rejoins, but the DB must never re-originate
       -- a first-join timestamp even if a caller passes a stale/reset value.
       joined_at = MIN(roster_presence.joined_at, excluded.joined_at),
       left_at = excluded.left_at,
       updated_at = excluded.updated_at,
       -- enrichment never downgrades: a later snapshot that lost the phone
       -- (or the pstn flag) must not erase what an earlier poll captured.
       pstn = MAX(roster_presence.pstn, excluded.pstn),
       phone = COALESCE(excluded.phone, roster_presence.phone)`,
  );
  const now = Date.now();
  db.exec('BEGIN');
  try {
    for (const a of roster) {
      stmt.run(
        meetingId, a.id, a.name, a.role, a.isHost ? 1 : 0, a.joinedAt, a.leftAt, now,
        a.pstn ? 1 : 0,
        a.phone ?? null,
      );
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** Stored roster for a meeting, ordered by first join — the same ordering
 *  contract as rosterMonitor.getRoster() (participant_id as deterministic tiebreak). */
export function getPresence(db: DB, meetingId: string): RosterAttendee[] {
  const rows = db
    .prepare(
      'SELECT * FROM roster_presence WHERE meeting_id = ? ORDER BY joined_at ASC, participant_id ASC',
    )
    .all(meetingId) as unknown as PresenceRow[];
  return rows.map(toAttendee);
}
