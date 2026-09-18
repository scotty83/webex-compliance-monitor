/**
 * Bot-independent roster snapshot ("peek") — view-failed-meeting feature.
 *
 * Unlike rosterMonitor (lifecycle-bound: polls only while the bot is
 * 'connected', tracks solitude/blindness), a peek is a one-shot presence
 * snapshot straight off the Webex meetingParticipants admin read — it works
 * whether or not any bot is in the call. It carries NO join/leave history:
 * only currently-joined participants, joinedAt = first time THIS cache
 * observed them (stable across refreshes), leftAt always null.
 *
 * Rate safety: TTL cache per webexMeetingId (composition passes the roster
 * poll interval, so peek load ≤ monitor load) on top of meetingsClient's
 * ≤1-in-flight-per-meeting coalescing. Idle entries sweep after 15 min.
 * Failures REJECT — the route turns them into a loud log + honest rosterError.
 */
import type { RosterAttendee } from '../domain/types.js';
import type { MeetingsClient } from './meetingsClient.js';
import { classifyParticipant, type ClassifyRules } from './classify.js';

export interface RosterPeekDeps extends ClassifyRules {
  client: Pick<MeetingsClient, 'listParticipants'>;
  /** Min ms between Webex fetches per meeting (serve-from-cache window). */
  ttlMs: number;
  now?: () => number;
}

export interface RosterPeek {
  /** Who is in the meeting RIGHT NOW, independent of any bot. Throws on
   *  Webex failure (fail-LOUD at the caller). */
  peek(webexMeetingId: string): Promise<RosterAttendee[]>;
}

const SWEEP_IDLE_MS = 15 * 60_000; // drop entries idle this long — bounded memory

interface PeekRec {
  fetchedAt: number;
  lastAccess: number;
  roster: RosterAttendee[];
  /** participantId → first-observed epoch ms; keeps joinedAt (and thus sort
   *  order) stable while the console re-peeks every poll. */
  firstSeen: Map<string, number>;
}

export function createRosterPeek(deps: RosterPeekDeps): RosterPeek {
  const now = deps.now ?? Date.now;
  const cache = new Map<string, PeekRec>();

  function sweep(t: number): void {
    for (const [id, rec] of cache) {
      if (t - rec.lastAccess > SWEEP_IDLE_MS) cache.delete(id);
    }
  }

  return {
    async peek(webexMeetingId): Promise<RosterAttendee[]> {
      const t = now();
      sweep(t);
      const rec = cache.get(webexMeetingId);
      if (rec && t - rec.fetchedAt < deps.ttlMs) {
        rec.lastAccess = t;
        return rec.roster.map((a) => ({ ...a })); // copies — callers cannot mutate
      }
      const participants = await deps.client.listParticipants(webexMeetingId);
      const firstSeen = rec?.firstSeen ?? new Map<string, number>();
      const roster: RosterAttendee[] = participants
        .filter((p) => p.state === 'joined')
        .map((p) => {
          const joinedAt = firstSeen.get(p.id) ?? t;
          firstSeen.set(p.id, joinedAt);
          return {
            id: p.id,
            name: p.displayName,
            role: classifyParticipant(p, deps),
            isHost: p.host,
            joinedAt,
            leftAt: null,
            ...(p.pstn ? { pstn: true as const } : {}),
            ...(p.phone !== undefined ? { phone: p.phone } : {}),
          };
        })
        .sort((a, b) => a.joinedAt - b.joinedAt);
      cache.set(webexMeetingId, { fetchedAt: t, lastAccess: t, roster, firstSeen });
      return roster.map((a) => ({ ...a }));
    },
  };
}
