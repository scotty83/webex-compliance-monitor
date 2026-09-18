// Shared backend/frontend domain contract — keep in sync with frontend/src/types.ts.
// The Webex integration extends the contract additively: ChaperonedMeeting.source,
// RosterAttendee (replaces RosterMember as the roster wire shape),
// WebexIntegrationStatus on GET /meetings.
export type BotState = 'idle' | 'dialing' | 'connected' | 'failed' | 'disconnected' | 'ended';

export interface ChaperonedMeeting {
  meetingId: string;        // our UUID
  webexMeetingId?: string;  // Webex meeting id, if known
  sipUri: string;           // <number>@<site>.webex.com
  title: string;
  scheduledStart?: number;  // epoch ms
  scheduledEnd?: number;    // epoch ms
  dtmf?: string;            // SIP join DTMF (meeting password + #); credential — do not log
  source?: MeetingSource;   // registration origin; treat absent as 'manual'
  createdAt: number;
}

export interface BotStatus {
  meetingId: string;
  state: BotState;
  joinedAt?: number;
  lastError?: string;       // present when state === 'failed' | 'disconnected'
  updatedAt: number;
}

// Internal bot -> media hub. Never serialized to the officer client as JSON;
// the payload reaches the console as raw binary WS frames (see WS protocol).
export interface AudioFrame {
  meetingId: string;
  seq: number;              // monotonically increasing per meeting
  timestampMs: number;      // capture time, epoch ms
  codec: 'opus';
  payload: Uint8Array;      // one 20ms Opus frame
}

export type AuditAction = 'listen_start' | 'listen_stop' | 'bot_join' | 'bot_leave' | 'bot_error';

export interface AuditEntry {
  id: string;               // UUID
  action: AuditAction;
  meetingId: string;
  officerEmail?: string;    // present for listen_* actions
  detail?: string;          // e.g. error text for bot_error
  at: number;               // epoch ms
}

export type Role = 'officer' | 'admin';

export interface Officer {
  email: string;
  role: Role;
}

// ── Webex account integration ───────────────────────────────────────

export type MeetingSource = 'manual' | 'calendar';

/** GET /meetings health field. failed = token refresh down (no Webex data at
 *  all); degraded = tokens fine but calendar sync stale or ≥1 roster poll
 *  blind; ok otherwise. */
export type WebexIntegrationStatus = 'ok' | 'degraded' | 'failed';

/** Roster participant role — authenticated-domain rule. Distinct from the
 *  console session Role above. */
export type ParticipantRole = 'analyst' | 'fo' | 'bot' | 'other';

/** Wire shape of GET /meetings/:id `roster`. Matches the console `Attendee`
 *  (frontend/src/types.ts) minus its optional `org` — do not drift. */
export interface RosterAttendee {
  id: string;               // Webex participant id
  name: string;
  role: ParticipantRole;
  isHost: boolean;
  joinedAt: number;         // epoch ms — first seen by the roster poller
  leftAt: number | null;    // epoch ms — set when the participant drops off
  /** True when the participant joined via PSTN. Absent for non-PSTN keeps the
   *  wire additive — older payload consumers see no change. */
  pstn?: true;
  /** Unmasked phone number — present when Webex delivers it; best-effort. */
  phone?: string;
}

/** Where GET /meetings/:id `roster` came from (additive — view-failed-meeting).
 *  'live'   = rosterMonitor cache (bot-observed join/leave history);
 *  'peek'   = bot-independent meetingParticipants snapshot (no history);
 *  'stored' = persisted presence from roster_presence table (ended meetings);
 *  'none'   = no roster available (rosterError says why when ?peek=1 was asked).
 *  Precedence: live > peek (when asked) > stored > none. */
export type RosterSource = 'live' | 'peek' | 'stored' | 'none';
