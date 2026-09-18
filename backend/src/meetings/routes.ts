import { Router, type RequestHandler } from 'express';
import type {
  Role,
  ChaperonedMeeting,
  RosterAttendee,
  RosterSource,
  WebexIntegrationStatus,
} from '../domain/types.js';
import type { DB } from '../db/index.js';
import { insertMeeting, getMeeting, listMeetings, deleteMeeting } from '../db/meetings.js';
import { getPresence } from '../db/presence.js';
import { getBotStatus } from '../db/botStatus.js';
import type { UpcomingMeetingDto } from '../webex/calendarSync.js';
import type { CreateMeetingOpts, CreatedMeeting } from '../webex/meetingsClient.js';

export interface MeetingLifecycle {
  onRegister(meeting: ChaperonedMeeting): void;
  /** webexMeetingId is passed when the deleted row had one (the row is already
   *  gone when this fires, so it cannot be looked up later) — the composition
   *  uses it to tombstone calendar auto-registration, otherwise the next due
   *  tick would re-register + re-dial the meeting the admin just deleted. */
  onDeregister(meetingId: string, webexMeetingId?: string): void;
}

/** Seams the composition wires from the Webex units — reads, plus the
 *  ONE write seam (in-portal scheduling). Absent (unit tests /
 *  integration not configured) → reads give empty data + 'failed';
 *  scheduleMeeting absent → POST /meetings/schedule answers 503. */
export interface WebexReadSeams {
  /** Live roster cache (rosterMonitor). */
  getRoster: (meetingId: string) => RosterAttendee[];
  /** Upcoming cache (calendarSync). */
  getUpcoming: () => UpcomingMeetingDto[];
  /** Health field on GET /meetings. */
  integrationStatus: () => WebexIntegrationStatus;
  /** Write seam: composition wires meetingsClient.createMeeting
   *  followed by the fire-and-forget post-create syncNow (Decision B). */
  scheduleMeeting: (opts: CreateMeetingOpts) => Promise<CreatedMeeting>;
  /** Bot-independent roster snapshot (rosterPeek) — serves GET
   *  /meetings/:id?peek=1 when the live cache is empty. Absent ⇒ peek
   *  unavailable (integration disabled) and the route says so honestly. */
  peekRoster: (webexMeetingId: string) => Promise<RosterAttendee[]>;
}

/** Same "looks like an email" bar as the frontend form — the real validation
 *  authority is Webex itself; this catches typos before an API round-trip. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Response-boundary redaction: dtmf is a credential (meeting password + #).
 *  The DB row keeps it — BotManager needs it to dial — but it must NEVER
 *  appear in any API response body. */
function toWireMeeting(meeting: ChaperonedMeeting): Omit<ChaperonedMeeting, 'dtmf'> {
  const { dtmf: _redacted, ...wire } = meeting;
  return wire;
}

export function meetingsRouter(opts: {
  db: DB;
  requireRole: (role: Role) => RequestHandler;
  lifecycle?: MeetingLifecycle;
  webex?: Partial<WebexReadSeams>;
}): Router {
  const router = Router();
  const getRoster = opts.webex?.getRoster ?? (() => []);
  const getUpcoming = opts.webex?.getUpcoming ?? (() => []);
  // Default 'failed' is honest: nothing wired ⇒ no Webex data at all.
  const integrationStatus = opts.webex?.integrationStatus ?? ((): WebexIntegrationStatus => 'failed');
  const peekRoster = opts.webex?.peekRoster; // undefined ⇒ honest 'not configured'

  router.post('/meetings', opts.requireRole('admin'), (req, res) => {
    const { sipUri, title, webexMeetingId, scheduledStart, scheduledEnd, dtmf } = req.body ?? {};
    if (!sipUri || !title) return res.status(400).json({ error: 'sipUri and title are required' });
    const meeting = insertMeeting(opts.db, {
      sipUri, title, webexMeetingId, scheduledStart, scheduledEnd, dtmf,
      source: 'manual', // manual override — wins over calendar auto-registration
    });
    opts.lifecycle?.onRegister(meeting);
    return res.status(201).json(toWireMeeting(meeting));
  });

  // Schedule a REAL Webex meeting from the console (admin-only).
  // Kept above the ':meetingId' routes for the same registration-order
  // discipline as GET /meetings/upcoming (no clash today — different method —
  // but ordering is an explicit contract in this file).
  router.post('/meetings/schedule', opts.requireRole('admin'), async (req, res) => {
    const scheduleMeeting = opts.webex?.scheduleMeeting;
    if (!scheduleMeeting) {
      // Loud-disable contract: no seam ⇒ the Webex integration is not
      // configured — say so, don't pretend it's a validation problem.
      return res.status(503).json({
        error: 'Webex integration is not configured — meeting scheduling is unavailable',
      });
    }

    const { title, start, durationMinutes, invitees } = (req.body ?? {}) as Record<string, unknown>;
    if (typeof title !== 'string' || title.trim() === '') {
      return res.status(400).json({ error: 'title is required' });
    }
    if (typeof start !== 'number' || !Number.isFinite(start)) {
      return res.status(400).json({ error: 'start must be a timestamp in epoch milliseconds' });
    }
    if (start <= Date.now()) {
      return res.status(400).json({ error: 'start must be in the future' });
    }
    if (
      typeof durationMinutes !== 'number' ||
      !Number.isInteger(durationMinutes) ||
      durationMinutes < 1 ||
      durationMinutes > 480
    ) {
      return res.status(400).json({ error: 'durationMinutes must be an integer between 1 and 480' });
    }
    const inviteeList = invitees === undefined ? [] : invitees;
    if (
      !Array.isArray(inviteeList) ||
      inviteeList.some((e) => typeof e !== 'string' || !EMAIL_RE.test(e))
    ) {
      return res.status(400).json({ error: 'invitees must be a list of email addresses' });
    }

    try {
      const created = await scheduleMeeting({
        title: title.trim(),
        start,
        end: start + durationMinutes * 60_000,
        invitees: inviteeList as string[],
      });
      // CreatedMeeting carries no credentials (no dtmf/password) — safe as-is.
      return res.status(201).json(created);
    } catch (err) {
      // Duck-typed on err.status so this file never imports a concrete webex
      // module: WebexScopeError carries status 403 + a scope-named message.
      const status =
        err instanceof Error && typeof (err as { status?: unknown }).status === 'number'
          ? (err as unknown as { status: number }).status
          : undefined;
      const message = err instanceof Error ? err.message : 'meeting creation failed';
      console.error('[meetings] LOUD: POST /meetings/schedule failed:', err);
      if (status === 403) return res.status(403).json({ error: message });
      return res.status(502).json({ error: message });
    }
  });

  router.get('/meetings', opts.requireRole('officer'), (_req, res) => {
    const meetings = listMeetings(opts.db).map((m) => ({ ...toWireMeeting(m), bot: getBotStatus(opts.db, m.meetingId) }));
    // webex_integration is additive — consumers reading only
    // `meetings` are unaffected.
    return res.json({ meetings, webex_integration: integrationStatus() });
  });

  // IMPORTANT: registered BEFORE '/meetings/:meetingId' — Express matches in
  // registration order, so this must precede the param route or 'upcoming'
  // would be captured as a meetingId.
  router.get('/meetings/upcoming', opts.requireRole('officer'), (_req, res) => {
    return res.json({ meetings: getUpcoming() });
  });

  router.get('/meetings/:meetingId', opts.requireRole('officer'), async (req, res) => {
    const meeting = getMeeting(opts.db, req.params.meetingId);
    if (!meeting) {
      res.status(404).json({ error: 'meeting not found' });
      return;
    }
    const bot = getBotStatus(opts.db, meeting.meetingId);

    let roster = getRoster(meeting.meetingId); // live cache — [] until wired
    let rosterSource: RosterSource = roster.length > 0 ? 'live' : 'none';
    let rosterError: string | undefined;

    // Bot-independent peek (view-failed-meeting). Opt-in via ?peek=1 so the
    // 5 s overview poll (which fetches EVERY meeting's detail) never fans out
    // to Webex. The monitor cache always wins when non-empty — it carries
    // real join/leave history; a peek is a presence snapshot only.
    if (req.query.peek === '1' && roster.length === 0) {
      if (!meeting.webexMeetingId) {
        rosterError = 'roster unavailable: meeting has no webexMeetingId';
      } else if (!peekRoster) {
        rosterError = 'roster unavailable: Webex integration is not configured';
      } else {
        try {
          roster = await peekRoster(meeting.webexMeetingId);
          rosterSource = 'peek';
        } catch (err) {
          // Fail LOUD server-side; stay honest client-side without taking
          // down meeting detail — bot state (+ lastError) must still render.
          console.error('[meetings] LOUD: roster peek failed for', meeting.meetingId, err);
          rosterError = `roster peek failed: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
    }

    // Stored-history fallback. Runs whenever live AND peek both yielded no
    // roster. Real persisted rows are the FINAL fallback and win even when the
    // client passed ?peek=1 — an ended meeting peeks empty but its stored
    // join/leave history is authoritative (this is the C1 fix: peek must not
    // starve stored). When there are NO stored rows, only relabel to 'stored'
    // if peek was not requested (we consulted stored, it was empty); a
    // failed/empty peek keeps its honest 'none' + rosterError signal.
    // Precedence: live > peek(non-empty) > stored(rows) > none.
    if (roster.length === 0) {
      const stored = getPresence(opts.db, meeting.meetingId);
      if (stored.length > 0) {
        roster = stored;
        rosterSource = 'stored';
      } else if (req.query.peek !== '1') {
        rosterSource = 'stored';
      }
    }

    // rosterError: undefined is dropped by JSON serialization — absent on the wire.
    res.json({ meeting: toWireMeeting(meeting), bot, roster, rosterSource, rosterError });
  });

  router.delete('/meetings/:meetingId', opts.requireRole('admin'), (req, res) => {
    const meeting = getMeeting(opts.db, req.params.meetingId);
    if (!meeting) return res.status(404).json({ error: 'meeting not found' });
    deleteMeeting(opts.db, req.params.meetingId);
    opts.lifecycle?.onDeregister(req.params.meetingId, meeting.webexMeetingId);
    return res.status(204).end();
  });

  return router;
}
