import { randomUUID } from 'node:crypto';
import type { DB } from './index.js';
import type { ChaperonedMeeting, MeetingSource } from '../domain/types.js';

export interface NewMeeting {
  sipUri: string;
  title: string;
  webexMeetingId?: string;
  scheduledStart?: number;
  scheduledEnd?: number;
  dtmf?: string;
  /** Registration origin; defaults to 'manual'. */
  source?: MeetingSource;
}

interface MeetingRow {
  meeting_id: string;
  webex_meeting_id: string | null;
  sip_uri: string;
  title: string;
  scheduled_start: number | null;
  scheduled_end: number | null;
  dtmf: string | null;
  source: string;
  created_at: number;
}

function toMeeting(r: MeetingRow): ChaperonedMeeting {
  return {
    meetingId: r.meeting_id,
    webexMeetingId: r.webex_meeting_id ?? undefined,
    sipUri: r.sip_uri,
    title: r.title,
    scheduledStart: r.scheduled_start ?? undefined,
    scheduledEnd: r.scheduled_end ?? undefined,
    dtmf: r.dtmf ?? undefined,
    source: r.source as MeetingSource,
    createdAt: r.created_at,
  };
}

export function insertMeeting(db: DB, input: NewMeeting): ChaperonedMeeting {
  const m: ChaperonedMeeting = {
    meetingId: randomUUID(),
    webexMeetingId: input.webexMeetingId,
    sipUri: input.sipUri,
    title: input.title,
    scheduledStart: input.scheduledStart,
    scheduledEnd: input.scheduledEnd,
    dtmf: input.dtmf,
    source: input.source ?? 'manual',
    createdAt: Date.now(),
  };
  db.prepare(
    `INSERT INTO meetings (meeting_id, webex_meeting_id, sip_uri, title, scheduled_start, scheduled_end, dtmf, source, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    m.meetingId,
    m.webexMeetingId ?? null,
    m.sipUri,
    m.title,
    m.scheduledStart ?? null,
    m.scheduledEnd ?? null,
    m.dtmf ?? null,
    m.source ?? 'manual',
    m.createdAt,
  );
  return m;
}

export function getMeeting(db: DB, meetingId: string): ChaperonedMeeting | undefined {
  const r = db.prepare('SELECT * FROM meetings WHERE meeting_id = ?').get(meetingId) as MeetingRow | undefined;
  return r ? toMeeting(r) : undefined;
}

export function listMeetings(db: DB): ChaperonedMeeting[] {
  const rows = db.prepare('SELECT * FROM meetings ORDER BY created_at ASC').all() as unknown as MeetingRow[];
  return rows.map(toMeeting);
}

/** Find a meeting by its Webex meeting id — the calendar-sync conflict rule
 *  ("a manual registration with the same webexMeetingId wins; sync skips it"). */
export function getMeetingByWebexId(db: DB, webexMeetingId: string): ChaperonedMeeting | undefined {
  const r = db
    .prepare('SELECT * FROM meetings WHERE webex_meeting_id = ?')
    .get(webexMeetingId) as MeetingRow | undefined;
  return r ? toMeeting(r) : undefined;
}

/** Deregister a meeting; also drops its bot_status and roster_presence rows so
 *  the FK references stay consistent. Deregister = history gone, mirroring the
 *  in-memory evictRoster contract (the row is gone; GET /meetings/:id 404s). */
export function deleteMeeting(db: DB, meetingId: string): void {
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM roster_presence WHERE meeting_id = ?').run(meetingId);
    db.prepare('DELETE FROM bot_status WHERE meeting_id = ?').run(meetingId);
    db.prepare('DELETE FROM meetings WHERE meeting_id = ?').run(meetingId);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
