// ─── Backend contract types ───────────────────────────────────────────────────
// Source of truth: backend/src/domain/types.ts (wire shapes returned by the API)
// NOTE: dtmf is intentionally omitted here — it is a credential (meeting
// password) and MUST NOT appear in any frontend type or view.

export type BotState =
  | 'idle'
  | 'dialing'
  | 'connected'
  | 'failed'
  | 'disconnected'
  | 'ended';

/** Bot states after which the meeting episode is over — no live audio; the
 *  console links to the read-only history view instead of the live chaperone. */
export const TERMINAL_BOT_STATES: readonly BotState[] = ['ended', 'failed', 'disconnected'];

export interface ChaperonedMeeting {
  meetingId: string;
  webexMeetingId?: string;
  sipUri: string;
  title: string;
  scheduledStart?: number;
  scheduledEnd?: number;
  // dtmf intentionally omitted — credential
  createdAt: number;
}

export interface BotStatus {
  meetingId: string;
  state: BotState;
  joinedAt?: number;
  lastError?: string;
  updatedAt: number;
}

export type AuditAction =
  | 'listen_start'
  | 'listen_stop'
  | 'bot_join'
  | 'bot_leave'
  | 'bot_error';

export interface AuditEntry {
  id: string;
  action: AuditAction;
  meetingId: string;
  officerEmail?: string;
  detail?: string;
  at: number;
}

/** Console user's session role — distinct from ParticipantRole below. */
export type Role = 'officer' | 'admin';

/** Authenticated console user — email + role decoded from the app-session JWT. */
export interface Officer {
  email: string;
  role: Role;
}

/**
 * Upcoming (scheduled, not yet started) meeting on the single Webex account.
 * Served by GET /meetings/upcoming (calendar sync cache).
 * dtmf intentionally omitted — credential; it must NEVER appear here.
 */
export interface UpcomingMeeting {
  meetingId: string;
  title: string;
  scheduledStart: number;
  scheduledEnd?: number;
  sipUri?: string;
}

/**
 * Request body for POST /meetings/schedule (admin-only).
 * Source of truth: backend/src/meetings/routes.ts validation.
 */
export interface ScheduleMeetingInput {
  title: string;
  start: number;           // epoch ms — must be in the future
  durationMinutes: number; // integer 1–480
  invitees: string[];      // email addresses; Webex sends the calendar invites
}

/**
 * 201 response of POST /meetings/schedule.
 * Source of truth: backend/src/webex/meetingsClient.ts CreatedMeeting.
 * NO credentials — dtmf/password never appear here.
 */
export interface CreatedMeeting {
  webexMeetingId: string;
  title: string;
  start: number;      // epoch ms
  sipAddress: string; // the bot's dial target
  joinUrl: string;    // Webex webLink — shown to the admin, copyable
}

// ─── View types ───────────────────────────────────────────────────────────────
// These are what the UI renders. Attendee is ALSO the wire shape of the
// GET /meetings/:id roster (backend RosterAttendee = Attendee minus `org`).
// Fields marked MOCKED come from mock/roster.ts and appear only under VITE_MOCK.

/**
 * Role of an individual meeting participant.
 * Distinct from the session `Role` ('officer' | 'admin').
 * Design colour mapping: analyst=blue, fo=violet, bot=red, other=muted.
 */
export type ParticipantRole = 'analyst' | 'fo' | 'bot' | 'other';

/** Where the GET /meetings/:id roster came from (additive; mirrors
 *  backend/src/domain/types.ts RosterSource — do not drift):
 *  'live' = backend rosterMonitor cache (bot-observed join/leave history);
 *  'peek' = bot-independent Webex snapshot (no history — ChaperoneView hides
 *           the PresenceTimeline for these);
 *  'none' = no roster available (rosterError says why when peek was asked).
 *  Absent (mock mode / older payloads) ⇒ treat as 'live'. */
export type RosterSource = 'live' | 'peek' | 'none' | 'stored'

export interface Attendee {
  id: string;
  name: string;
  role: ParticipantRole;
  org?: string;
  isHost: boolean;
  joinedAt: number;
  leftAt: number | null;
  /** True when the participant joined via PSTN dial-in or callback. */
  pstn?: boolean;
  /** Unmasked phone number when Webex delivers it; best-effort. */
  phone?: string;
}

export interface Meeting {
  id: string;          // = ChaperonedMeeting.meetingId
  title: string;
  org: string;         // MOCKED — not in contract
  sipUri: string;
  startedAt: number;   // = bot.joinedAt ?? meeting.createdAt
  botState: BotState;  // = bot?.state ?? 'idle'
  attendees: Attendee[]; // live roster from GET /meetings/:id in real mode; mock only under VITE_MOCK
  lastError?: string;  // = bot?.lastError (surfaces failed/disconnected detail)
  endedAt?: number;    // = bot.updatedAt when botState is terminal — approximate end time
  rosterSource?: RosterSource // additive — provenance of `attendees`
  rosterError?: string        // additive — honest peek-failure surface (fail-loud)
}

// ─── Pure mapper ──────────────────────────────────────────────────────────────

/**
 * Map a raw API response row to the UI `Meeting` view type.
 * `mock` supplies org + attendees from mock/roster.ts (or a real roster once
 * available). No dtmf, no recording field.
 */
export function toMeeting(
  raw: ChaperonedMeeting & { bot: BotStatus | null },
  mock: {
    org: string
    attendees: Attendee[]
    rosterSource?: RosterSource
    rosterError?: string
  },
): Meeting {
  return {
    id: raw.meetingId,
    title: raw.title,
    org: mock.org,
    sipUri: raw.sipUri,
    startedAt: raw.bot?.joinedAt ?? raw.createdAt,
    botState: raw.bot?.state ?? 'idle',
    attendees: mock.attendees,
    lastError: raw.bot?.lastError,
    endedAt:
      raw.bot && TERMINAL_BOT_STATES.includes(raw.bot.state)
        ? raw.bot.updatedAt
        : undefined,
    rosterSource: mock.rosterSource,
    rosterError: mock.rosterError,
  };
}
