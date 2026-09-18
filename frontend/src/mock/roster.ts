// VITE_MOCK-only roster. The real roster ships from GET /meetings/:id
// (rosterMonitor cache) and is used by useMeetings in real mode;
// this module is only reached under `npm run dev:mock`. org + names here
// are invented demo data.

import type { ChaperonedMeeting, Attendee } from '../types';

// ─── Deterministic PRNG (mulberry32) ─────────────────────────────────────────
// Seeded from meetingId hash so the same meeting always produces the same names,
// org, and attendee list regardless of how many times it is called (stable across ~5s polls).

function hashStr(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (Math.imul(h, 0x01000193) >>> 0);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let s = seed;
  return function () {
    s += 0x6d2b79f5;
    let t = Math.imul(s ^ (s >>> 15), s | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(arr: readonly T[], rand: () => number): T {
  return arr[Math.floor(rand() * arr.length)];
}

// ─── Name / org pools ────────────────────────────────────────────────────────

const ORGS = [
  'Meridian Capital Research',
  'Apex Securities Group',
  'Meridian Analytics LLC',
  'Silverstone Investment Partners',
  'Quantum Asset Management',
  'Helios Fixed-Income Partners',
  'Northbridge Equity Research',
] as const;

const ANALYST_NAMES = [
  'Alex Chen', 'Jordan Rivera', 'Sam Okafor', 'Morgan Blake', 'Taylor Kim',
  'Casey Obi', 'Drew Nkosi', 'Riley Park', 'Quinn Matthews', 'Avery Lim',
] as const;

const FO_NAMES = [
  'Marcus Delacroix', 'Priya Sharma', 'James Whitfield', 'Aisha Fernandez',
  'David Okonkwo', 'Olivia Sterling', 'Nathan Beaumont', 'Elena Voss',
] as const;

const BOT_NAME = 'Compliance Monitor Bot';

// ─── Mock roster factory ──────────────────────────────────────────────────────

export function mockRosterFor(
  meeting: ChaperonedMeeting,
  /** When set (ended meeting): everyone has left by this time. */
  endedAt?: number,
): { org: string; attendees: Attendee[] } {
  const seed = hashStr(meeting.meetingId);
  const rand = mulberry32(seed);

  const org = pick(ORGS, rand);
  const base = meeting.createdAt;

  // Front-office host
  const fo: Attendee = {
    id: `fo-${seed}`,
    name: pick(FO_NAMES, rand),
    role: 'fo',
    org,
    isHost: true,
    joinedAt: base + Math.floor(rand() * 60_000),
    leftAt: null,
  };

  // Compliance Monitor Bot
  const bot: Attendee = {
    id: `bot-${seed}`,
    name: BOT_NAME,
    role: 'bot',
    isHost: false,
    joinedAt: base + 120_000 + Math.floor(rand() * 30_000),
    leftAt: null,
  };

  // 1–2 analysts; the second (when present) has leftAt set to exercise the
  // "left the call" UI state.
  const numAnalysts = rand() < 0.5 ? 1 : 2;
  const analysts: Attendee[] = [];
  for (let i = 0; i < numAnalysts; i++) {
    const joined = base + Math.floor(rand() * 90_000);
    const leftAt =
      i === 1 ? joined + 300_000 + Math.floor(rand() * 600_000) : null;
    analysts.push({
      id: `analyst-${seed}-${i}`,
      name: pick(ANALYST_NAMES, rand),
      role: 'analyst',
      org,
      isHost: false,
      joinedAt: joined,
      leftAt,
    });
  }

  // Fixed PSTN demo attendee — shows the phone glyph + formatted number in dev:mock.
  const pstn: Attendee = {
    id: `pstn-${seed}`,
    name: '8452****46',
    role: 'other',
    isHost: false,
    joinedAt: base + Math.floor(rand() * 60_000),
    leftAt: null,
    pstn: true,
    phone: '8452338546',
  };

  const attendees = [fo, bot, ...analysts, pstn];
  if (endedAt === undefined) return { org, attendees };
  // Ended meeting: everyone has left; keep earlier synthetic leave times.
  return { org, attendees: attendees.map((a) => ({ ...a, leftAt: a.leftAt ?? endedAt })) };
}
