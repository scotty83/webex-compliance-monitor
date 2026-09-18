/**
 * Live roster + solitude.
 *
 * Lifecycle (wired in composition): polling starts when a meeting's bot
 * reaches 'connected'; stops on 'disconnected'/'failed'/deregister.
 *
 * Every poll: fetch participants → diff against the previous snapshot
 * (new → joinedAt: now; missing → leftAt: now; same-id rejoin → leftAt back
 * to null) → classify roles per the authenticated-domain rule (bot
 * self-matched by BOT_DISPLAY_NAME).
 *
 * Solitude: alone time accumulates ONLY between consecutive successful polls.
 * Poll failures keep the last-good roster, go loud after 3 consecutive
 * misses, and clear the accumulation anchor — the timer is FROZEN while
 * blind. Never hang up on missing data.
 */
import type { ParticipantRole, RosterAttendee } from '../domain/types.js';
import type { MeetingsClient, WebexParticipant } from './meetingsClient.js';
import { classifyParticipant } from './classify.js';
import { defaultTimers, type IntervalTimers } from './timers.js';

export interface RosterMonitorDeps {
  client: Pick<MeetingsClient, 'listParticipants'>;
  /** Solitude hang-up — composition routes to orchestrator.deregisterMeeting(id, 'solitude'). */
  onSolitude: (meetingId: string) => void;
  /** Lowercased email domains → 'fo'; other authenticated → 'analyst'; guests → 'other'. */
  internalEmailDomains: string[];
  /** BOT_DISPLAY_NAME — the bot's own roster entry self-match. */
  botDisplayName: string;
  /** Optional persistence sink (ended-meeting history). Called after every
   *  successful poll with the full post-diff snapshot (same shape + ordering
   *  as getRoster()). Errors are caught + logged LOUD; a persist failure never
   *  blocks the in-memory roster, the poll loop, or the solitude logic. */
  persistRoster?: (meetingId: string, roster: RosterAttendee[]) => void;
  pollIntervalMs: number;
  solitudeTimeoutMs: number;
  now?: () => number;
  timers?: IntervalTimers;
}

export interface RosterMonitor {
  startMonitoring(meetingId: string, webexMeetingId: string): void;
  stopMonitoring(meetingId: string): void;
  stopAll(): void;
  /** Last-good roster (kept after stop), ordered by first join. */
  getRoster(meetingId: string): RosterAttendee[];
  /** Drop the cached roster for a meeting. Composition calls this on meeting
   *  DEREGISTER (DELETE /meetings — the row is gone, the cache entry is
   *  unreachable garbage); bot terminal states keep the last-known roster.
   *  Call after stopMonitoring — a live poll would recreate the entry. */
  evictRoster(meetingId: string): void;
  /** ≥1 monitored meeting with ≥3 consecutive poll failures → feeds 'degraded'. */
  isBlind(): boolean;
  /** One poll cycle now (what the interval tick runs). No-op when not monitored. */
  pollNow(meetingId: string): Promise<void>;
}

const BLIND_THRESHOLD = 3;

/** A definitive "meeting over" poll error: the Webex participants API returns
 *  404 when the meeting no longer exists. Distinct from a transient network
 *  miss — it must CONCLUDE the meeting, never freeze the timer blind (§6). */
function isMeetingGone(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { status?: unknown }).status === 404
  );
}

interface MonitorRec {
  webexMeetingId: string;
  handle: unknown;
  consecutiveFailures: number;
  /** Accumulated OBSERVED alone time (ms). */
  aloneMs: number;
  /** Timestamp of the previous successful alone poll; undefined = anchor
   *  broken (humans present, or a failed poll → frozen while blind). */
  lastAlonePollAt: number | undefined;
}

export function createRosterMonitor(deps: RosterMonitorDeps): RosterMonitor {
  const now = deps.now ?? Date.now;
  const timers = deps.timers ?? defaultTimers;

  const monitors = new Map<string, MonitorRec>();
  // Kept separately from monitors so the last-good roster survives stopMonitoring.
  const rosters = new Map<string, Map<string, RosterAttendee>>();

  function snapshot(roster: Map<string, RosterAttendee>): RosterAttendee[] {
    return [...roster.values()]
      .sort((a, b) => a.joinedAt - b.joinedAt)
      .map((a) => ({ ...a })); // copies — callers cannot mutate the cache
  }

  function classify(p: WebexParticipant): ParticipantRole {
    return classifyParticipant(p, {
      internalEmailDomains: deps.internalEmailDomains,
      botDisplayName: deps.botDisplayName,
    });
  }

  function stopMonitoring(meetingId: string): void {
    const rec = monitors.get(meetingId);
    if (!rec) return;
    timers.clearInterval(rec.handle);
    monitors.delete(meetingId);
    // The meeting is no longer live: stamp leftAt on anyone still shown present
    // so the frozen last-known roster reads "0 on call". Without this the bot's
    // own entry (leftAt=null, never seen leaving because polling stops) lingers
    // as a phantom "1 on call" after the meeting ends. A reconnect calls
    // startMonitoring, which resets to a fresh roster episode, so this is safe.
    const roster = rosters.get(meetingId);
    if (roster) {
      const t = now();
      for (const entry of roster.values()) {
        if (entry.leftAt === null) entry.leftAt = t;
      }
    }
    // Persist the final leftAt-stamped roster so admin-ended / stopAll /
    // bot-disconnect meetings land in DB (not only solitude-ended ones).
    // leftAt-stamping MUST precede this persist so the stored shape reflects
    // "0 on call". For a solitude end, pollNow already persisted just before
    // calling stopMonitoring — this second write is idempotent and more complete.
    if (deps.persistRoster && roster) {
      try {
        deps.persistRoster(meetingId, snapshot(roster));
      } catch (err) {
        console.error(
          `[rosterMonitor] LOUD: presence persist failed (stop) for ${meetingId} — stored history may be stale:`,
          err,
        );
      }
    }
  }

  async function pollNow(meetingId: string): Promise<void> {
    const rec = monitors.get(meetingId);
    if (!rec) return;

    let participants: WebexParticipant[];
    try {
      participants = await deps.client.listParticipants(rec.webexMeetingId);
    } catch (err) {
      // Stale in-flight poll: the record was replaced/removed mid-flight
      // (solitude fired, stop, or restart) — exactly-once demands a no-op.
      if (monitors.get(meetingId) !== rec) return;
      // §6: a DEFINITIVE "meeting over" error (Webex 404) CONCLUDES the meeting
      // rather than freezing the timer blind. Stop polling + hang the bot up.
      if (isMeetingGone(err)) {
        console.error(
          `[rosterMonitor] meeting ${meetingId} is gone (404) — concluding instead of freezing blind:`,
          err,
        );
        stopMonitoring(meetingId);
        deps.onSolitude(meetingId);
        return;
      }
      rec.consecutiveFailures += 1;
      rec.lastAlonePollAt = undefined; // FREEZE the solitude timer while blind
      if (rec.consecutiveFailures === BLIND_THRESHOLD) {
        console.error(
          `[rosterMonitor] LOUD: blind for ${meetingId} — ${BLIND_THRESHOLD} consecutive poll failures:`,
          err,
        );
      }
      return; // keep-last-good roster
    }
    // Stale in-flight poll (see the catch-side guard) — no roster mutation,
    // no second solitude fire.
    if (monitors.get(meetingId) !== rec) return;
    rec.consecutiveFailures = 0;

    const t = now();
    const roster = rosters.get(meetingId) ?? new Map<string, RosterAttendee>();
    rosters.set(meetingId, roster);

    const joined = participants.filter((p) => p.state === 'joined');
    const joinedIds = new Set(joined.map((p) => p.id));

    for (const p of joined) {
      const existing = roster.get(p.id);
      if (existing) {
        existing.leftAt = null; // same-id rejoin — original joinedAt preserved
        existing.isHost = p.host;
        // Late-arriving phone: update if this poll now delivers one; never
        // downgrade an existing phone to undefined (it may appear on a later poll).
        if (p.phone !== undefined) existing.phone = p.phone;
      } else {
        roster.set(p.id, {
          id: p.id,
          name: p.displayName,
          role: classify(p),
          isHost: p.host,
          joinedAt: t,
          leftAt: null,
          ...(p.pstn ? { pstn: true as const } : {}),
          ...(p.phone !== undefined ? { phone: p.phone } : {}),
        });
      }
    }
    for (const entry of roster.values()) {
      if (entry.leftAt === null && !joinedIds.has(entry.id)) entry.leftAt = t;
    }

    // Persist the post-diff snapshot so history survives eviction/restart.
    // BEFORE the solitude block: the final leaves that trigger a hang-up are
    // stored. A persist failure is LOUD but never interrupts polling/solitude.
    if (deps.persistRoster) {
      try {
        deps.persistRoster(meetingId, snapshot(roster));
      } catch (err) {
        console.error(
          `[rosterMonitor] LOUD: presence persist failed for ${meetingId} — stored history may be stale:`,
          err,
        );
      }
    }

    // ── Solitude ─────────────────────────────────────────────────────────
    const liveHumans = joined.filter((p) => classify(p) !== 'bot').length;
    if (liveHumans > 0) {
      rec.aloneMs = 0;
      rec.lastAlonePollAt = undefined;
      return;
    }
    if (rec.lastAlonePollAt !== undefined) rec.aloneMs += t - rec.lastAlonePollAt;
    rec.lastAlonePollAt = t;
    if (rec.aloneMs >= deps.solitudeTimeoutMs) {
      console.error(
        `[rosterMonitor] solitude: bot alone for ≥${deps.solitudeTimeoutMs} ms in ${meetingId} — hanging up`,
      );
      stopMonitoring(meetingId);
      deps.onSolitude(meetingId);
    }
  }

  return {
    startMonitoring(meetingId, webexMeetingId): void {
      if (monitors.has(meetingId)) return; // idempotent
      rosters.set(meetingId, new Map()); // fresh episode
      const rec: MonitorRec = {
        webexMeetingId,
        handle: undefined,
        consecutiveFailures: 0,
        aloneMs: 0,
        lastAlonePollAt: undefined,
      };
      rec.handle = timers.setInterval(() => { void pollNow(meetingId); }, deps.pollIntervalMs);
      monitors.set(meetingId, rec);
    },
    stopMonitoring,
    stopAll(): void {
      for (const id of [...monitors.keys()]) stopMonitoring(id);
    },
    getRoster(meetingId): RosterAttendee[] {
      const roster = rosters.get(meetingId);
      if (!roster) return [];
      return snapshot(roster);
    },
    evictRoster(meetingId): void {
      rosters.delete(meetingId); // no-op when absent — idempotent
    },
    isBlind(): boolean {
      return [...monitors.values()].some((r) => r.consecutiveFailures >= BLIND_THRESHOLD);
    },
    pollNow,
  };
}
