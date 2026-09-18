// Dev-only mock of the /meetings API (VITE_MOCK=1). Never reached in prod:
// the guards in api/client.ts are dead-code-eliminated when VITE_MOCK is unset.
// Wire shapes mirror the backend contract exactly (ChaperonedMeeting + BotStatus);
// org/attendees still come from mock/roster.ts via the normal useMeetings path.

import type {
  BotStatus,
  ChaperonedMeeting,
  Attendee,
  UpcomingMeeting,
  ScheduleMeetingInput,
  CreatedMeeting,
  RosterSource,
} from '../types';

type MeetingRow = ChaperonedMeeting & { bot: BotStatus | null };

const NETWORK_DELAY_MS = 250;

// Anchored once at module load so elapsed times stay coherent across polls.
const NOW = Date.now();
const MIN = 60_000;

function row(opts: {
  id: string;
  title: string;
  sipUri: string;
  createdAgoMin: number;
  bot:
    | { state: BotStatus['state']; joinedAgoMin?: number; lastError?: string; endedAgoMin?: number }
    | null;
}): MeetingRow {
  const createdAt = NOW - opts.createdAgoMin * MIN;
  return {
    meetingId: opts.id,
    sipUri: opts.sipUri,
    title: opts.title,
    createdAt,
    bot: opts.bot && {
      meetingId: opts.id,
      state: opts.bot.state,
      ...(opts.bot.joinedAgoMin !== undefined
        ? { joinedAt: NOW - opts.bot.joinedAgoMin * MIN }
        : {}),
      ...(opts.bot.lastError !== undefined
        ? { lastError: opts.bot.lastError }
        : {}),
      updatedAt:
        opts.bot.endedAgoMin !== undefined ? NOW - opts.bot.endedAgoMin * MIN : NOW - 5_000,
    },
  };
}

// Seven meetings exercising every card state the overview can render:
// connected ×2, dialing, failed (fail-LOUD), disconnected (fail-LOUD), idle,
// + ended (history view).
const MEETINGS: MeetingRow[] = [
  row({
    id: 'mock-001',
    title: 'Q3 Earnings Preview — Consumer Staples',
    sipUri: '88832100451@acmecorp.webex.com',
    createdAgoMin: 40,
    bot: { state: 'connected', joinedAgoMin: 38 },
  }),
  row({
    id: 'mock-002',
    title: 'Rates Desk Briefing — Macro Outlook',
    sipUri: '88832100517@acmecorp.webex.com',
    createdAgoMin: 14,
    bot: { state: 'connected', joinedAgoMin: 12 },
  }),
  row({
    id: 'mock-003',
    title: 'Semis Supply Chain — Analyst Check-in',
    sipUri: '88832100583@acmecorp.webex.com',
    createdAgoMin: 2,
    bot: { state: 'dialing' },
  }),
  row({
    id: 'mock-004',
    title: 'Healthcare M&A Pipeline Review',
    sipUri: '88832100629@acmecorp.webex.com',
    createdAgoMin: 25,
    bot: {
      state: 'failed',
      lastError: 'SIP dial failed: 480 Temporarily Unavailable',
    },
  }),
  row({
    id: 'mock-005',
    title: 'Energy Transition — Sector Deep Dive',
    sipUri: '88832100694@acmecorp.webex.com',
    createdAgoMin: 65,
    bot: {
      state: 'disconnected',
      joinedAgoMin: 63,
      lastError: 'Media stream lost (RTP timeout)',
    },
  }),
  row({
    id: 'mock-006',
    title: 'FX Volatility Briefing — EMEA Open',
    sipUri: '88832100738@acmecorp.webex.com',
    createdAgoMin: 1,
    bot: null, // no bot record yet → botState 'idle'
  }),
  row({
    id: 'mock-007',
    title: 'Industrials Pre-Market Sync — Recap',
    sipUri: '88832100781@acmecorp.webex.com',
    createdAgoMin: 190,
    bot: { state: 'ended', joinedAgoMin: 188, endedAgoMin: 130 },
  }),
];

// Upcoming (not yet started) meetings on the single Webex account — the
// VITE_MOCK stand-in for the real GET /meetings/upcoming.
// Anchored to the same module-load NOW as above.
const UPCOMING: UpcomingMeeting[] = [
  {
    meetingId: 'mock-up-001',
    title: 'Consumer Credit Trends — Analyst Q&A',
    sipUri: '88832100812@acmecorp.webex.com',
    scheduledStart: NOW + 10 * MIN,
    scheduledEnd: NOW + 70 * MIN,
  },
  {
    meetingId: 'mock-up-002',
    title: 'Biotech Pipeline Readout — KOL Call',
    sipUri: '88832100867@acmecorp.webex.com',
    scheduledStart: NOW + 45 * MIN,
    scheduledEnd: NOW + 105 * MIN,
  },
  {
    meetingId: 'mock-up-003',
    title: 'EU Autos — Pre-Earnings Positioning',
    sipUri: '88832100923@acmecorp.webex.com',
    scheduledStart: NOW + 150 * MIN,
    scheduledEnd: NOW + 210 * MIN,
  },
];

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function mockGetMeetings(): Promise<MeetingRow[]> {
  await delay(NETWORK_DELAY_MS);
  return MEETINGS.map((m) => ({ ...m, bot: m.bot && { ...m.bot } }));
}

export async function mockGetUpcomingMeetings(): Promise<UpcomingMeeting[]> {
  await delay(NETWORK_DELAY_MS);
  return UPCOMING.map((m) => ({ ...m }));
}

export async function mockGetMeeting(id: string): Promise<{
  meeting: ChaperonedMeeting;
  bot: BotStatus | null;
  roster: Attendee[];
  rosterSource?: RosterSource;
  rosterError?: string;
}> {
  await delay(NETWORK_DELAY_MS);
  const found = MEETINGS.find((m) => m.meetingId === id);
  if (!found) {
    const { ApiError } = await import('../api/client');
    throw new ApiError(404, 'meeting not found');
  }
  const { bot, ...meeting } = found;
  // Ended meetings get a stored roster (persisted presence history).
  // Failed/disconnected meetings get a peeked roster (no live bot cache).
  // Connected/dialing meetings have live roster data.
  const rosterSource: RosterSource =
    bot?.state === 'ended'
      ? 'stored'
      : bot?.state === 'failed' || bot?.state === 'disconnected'
        ? 'peek'
        : 'live';
  return { meeting, bot: bot && { ...bot }, roster: [], rosterSource };
}

/** Mock of DELETE /meetings/:id — removes the row so the next poll drops it. */
export async function mockDeleteMeeting(id: string): Promise<void> {
  await delay(NETWORK_DELAY_MS);
  const idx = MEETINGS.findIndex((m) => m.meetingId === id);
  if (idx === -1) {
    const { ApiError } = await import('../api/client');
    throw new ApiError(404, 'meeting not found');
  }
  MEETINGS.splice(idx, 1);
}

/** Mock of POST /meetings/schedule — echoes the input as a created meeting. */
export async function mockScheduleMeeting(input: ScheduleMeetingInput): Promise<CreatedMeeting> {
  await new Promise((r) => setTimeout(r, NETWORK_DELAY_MS));
  return {
    webexMeetingId: `wx-mock-${input.start}`,
    title: input.title,
    start: input.start,
    sipAddress: 'mock-scheduled@site.webex.example',
    joinUrl: 'https://mock.webex.example/meet/scheduled',
  };
}
