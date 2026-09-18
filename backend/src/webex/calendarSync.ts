/**
 * Calendar sync: polls the Webex meetings list into an in-memory
 * upcoming cache, and auto-registers + auto-dials meetings when the local
 * clock crosses scheduledStart.
 *
 * Two cadences (spec "due-check cadence"): the API sync runs every
 * syncIntervalMs (default 300 s), but "is anything due?" is evaluated against
 * the LOCAL cache every 30 s — auto-dial jitter is ≤30 s, no extra API calls.
 *
 * Fail-LOUD: sync failure keeps the last-good cache and PAUSES
 * auto-registration once the data is stale (one fully missed sync cycle —
 * stricter than the spec's "older than one window" floor). A calendar meeting
 * with no SIP dial-in info is registered as `failed` with a loud lastError so
 * the officer SEES the coverage gap — it is never silently skipped.
 */
import { randomUUID } from 'node:crypto';
import type { DB } from '../db/index.js';
import type { AuditEntry, BotStatus, ChaperonedMeeting } from '../domain/types.js';
import { insertMeeting, getMeetingByWebexId } from '../db/meetings.js';
import type { MeetingsClient, WebexMeeting } from './meetingsClient.js';
import { defaultTimers, type IntervalTimers } from './timers.js';

/** Console `UpcomingMeeting` wire shape. meetingId is the WEBEX meeting id —
 *  no local registration exists yet for an upcoming meeting. */
export interface UpcomingMeetingDto {
  meetingId: string;
  title: string;
  scheduledStart: number;
  scheduledEnd?: number;
  sipUri?: string;
}

export interface CalendarSyncDeps {
  client: Pick<MeetingsClient, 'listUpcomingMeetings'>;
  db: DB;
  /** Fire-and-forget into the orchestrator (composition lifecycle.onRegister). */
  onRegister: (m: ChaperonedMeeting) => void;
  upsertBotStatus: (s: BotStatus) => void;
  writeAudit: (e: AuditEntry) => void;
  syncIntervalMs: number;
  windowMs: number;
  /** Local due-check cadence (no API call). Default 30_000 — jitter ≤30 s. */
  dueCheckIntervalMs?: number;
  now?: () => number;
  newId?: () => string;
  timers?: IntervalTimers;
}

export interface CalendarSync {
  start(): void;
  stop(): void;
  /** One API sync now (what the sync interval runs). Never throws — errors log loudly. */
  syncNow(): Promise<void>;
  /** One due-check against the local cache (what the due interval runs). */
  checkDue(): void;
  /** Tombstone a DELETEd calendar meeting for the remainder of its sync
   *  window: checkDue will not re-register (and so not re-dial) this
   *  webexMeetingId even though it is still cached and due. Without this,
   *  DELETE /meetings on a due meeting is auto-undone by the next 30 s tick
   *  (the row is gone, so the getMeetingByWebexId guard no longer fires).
   *  Entries are pruned when the id drops out of the sync cache, so a NEW
   *  occurrence appearing later registers normally. */
  suppress(webexMeetingId: string): void;
  getUpcoming(): UpcomingMeetingDto[];
  /** 'stale' pauses auto-registration and feeds webex_integration 'degraded'. */
  status(): 'ok' | 'stale';
}

export const NO_SIP_ERROR = 'no SIP address on Webex meeting';

/** Look-back so an in-progress meeting stays in the poll window between ticks. */
const SYNC_LOOKBACK_MS = 3_600_000;
/** How far past its SCHEDULED end a meeting may still be auto-registered. Real
 *  calls overrun; only past this do we treat `end` as proof it is over. */
const END_GRACE_MS = 30 * 60_000;

export function createCalendarSync(deps: CalendarSyncDeps): CalendarSync {
  const now = deps.now ?? Date.now;
  const newId = deps.newId ?? randomUUID;
  const timers = deps.timers ?? defaultTimers;
  const dueCheckIntervalMs = deps.dueCheckIntervalMs ?? 30_000;

  let cache: WebexMeeting[] = [];
  let lastSyncAt: number | undefined;
  let syncHandle: unknown;
  let dueHandle: unknown;
  /** DELETEd webexMeetingIds — see CalendarSync.suppress. */
  const suppressed = new Set<string>();
  /** webexMeetingIds already reported as skipped-past-end, so the loud line is
   *  emitted once per meeting rather than on every 30s due tick. */
  const endSkipLogged = new Set<string>();

  function status(): 'ok' | 'stale' {
    return lastSyncAt !== undefined && now() - lastSyncAt <= 2 * deps.syncIntervalMs
      ? 'ok'
      : 'stale';
  }

  async function syncNow(): Promise<void> {
    try {
      const items = await deps.client.listUpcomingMeetings({
        from: now() - SYNC_LOOKBACK_MS,
        to: now() + deps.windowMs,
      });
      cache = [...items].sort((a, b) => a.start - b.start);
      lastSyncAt = now();
      // Prune tombstones whose meeting left the sync window — a NEW occurrence
      // of the same id later must register normally. (Prune only on a
      // SUCCESSFUL sync: on failure the last-good cache keeps them relevant.)
      const cachedIds = new Set(cache.map((wm) => wm.id));
      for (const id of suppressed) {
        if (!cachedIds.has(id)) suppressed.delete(id);
      }
    } catch (err) {
      // Keep-last-good cache; auto-registration pauses via status() === 'stale'.
      console.error('[calendarSync] LOUD: calendar sync failed — upcoming list may be stale:', err);
    }
  }

  function registerCalendarMeeting(wm: WebexMeeting): void {
    if (wm.sipAddress === undefined || wm.sipAddress === '') {
      // Coverage gap the officer must SEE: register as failed, never skip.
      const m = insertMeeting(deps.db, {
        sipUri: '',
        title: wm.title,
        webexMeetingId: wm.id,
        scheduledStart: wm.start,
        scheduledEnd: wm.end,
        source: 'calendar',
      });
      deps.upsertBotStatus({ meetingId: m.meetingId, state: 'failed', lastError: NO_SIP_ERROR, updatedAt: now() });
      deps.writeAudit({ id: newId(), action: 'bot_error', meetingId: m.meetingId, detail: NO_SIP_ERROR, at: now() });
      console.error(`[calendarSync] LOUD: ${NO_SIP_ERROR} (webexMeetingId=${wm.id}) — registered as failed`);
      return;
    }
    const m = insertMeeting(deps.db, {
      sipUri: wm.sipAddress,
      title: wm.title,
      webexMeetingId: wm.id,
      scheduledStart: wm.start,
      scheduledEnd: wm.end,
      dtmf: wm.password !== undefined ? `${wm.password}#` : undefined,
      source: 'calendar',
    });
    deps.onRegister(m); // existing orchestrator dial/retry/fail-LOUD machinery
  }

  function checkDue(): void {
    if (status() === 'stale') {
      console.error('[calendarSync] LOUD: auto-registration paused — calendar data is stale');
      return;
    }
    for (const wm of cache) {
      if (wm.start > now()) continue;
      // The sync window looks back SYNC_LOOKBACK_MS, so a meeting that already
      // ENDED can still be cached (e.g. the first sync after a restart). Dialing
      // it would produce a spurious failed/instant-solitude bot and a phantom
      // coverage gap for a call nobody is on.
      //
      // But `end` is the SCHEDULED end, and real calls overrun. Skipping the
      // instant it passes would silently drop a still-running meeting (e.g. the
      // API was down over its start and sync only recovers afterwards) — trading
      // a phantom for an invisible gap, which is the worse failure here. So allow
      // END_GRACE_MS of overrun, and say so ONCE per meeting when we do skip:
      // a dropped meeting must never be silent.
      if (wm.end !== undefined && wm.end + END_GRACE_MS <= now()) {
        if (!endSkipLogged.has(wm.id)) {
          endSkipLogged.add(wm.id);
          console.error(
            `[calendarSync] LOUD: not auto-registering ${wm.id} — its scheduled end passed more than ` +
            `${Math.round(END_GRACE_MS / 60_000)} min ago; register it manually if it is still running`,
          );
        }
        continue;
      }
      // Tombstone rule: an admin's DELETE is final for this window — the row
      // is gone, so only this Set stops the tick from undoing the removal.
      if (suppressed.has(wm.id)) continue;
      // Conflict rule: any existing row with this webexMeetingId wins
      // (manual registration or an earlier auto-registration).
      if (getMeetingByWebexId(deps.db, wm.id)) continue;
      registerCalendarMeeting(wm);
    }
  }

  return {
    start(): void {
      // Immediate first sync — also the loud startup preflight: a 403 scope
      // error or token failure surfaces in the log at boot, not 5 min later.
      void syncNow();
      syncHandle = timers.setInterval(() => { void syncNow(); }, deps.syncIntervalMs);
      dueHandle = timers.setInterval(() => { checkDue(); }, dueCheckIntervalMs);
    },
    stop(): void {
      if (syncHandle !== undefined) timers.clearInterval(syncHandle);
      if (dueHandle !== undefined) timers.clearInterval(dueHandle);
      syncHandle = undefined;
      dueHandle = undefined;
    },
    syncNow,
    checkDue,
    suppress(webexMeetingId: string): void {
      suppressed.add(webexMeetingId);
    },
    getUpcoming(): UpcomingMeetingDto[] {
      return cache
        .filter((wm) => wm.start > now())
        .map((wm) => ({
          meetingId: wm.id,
          title: wm.title,
          scheduledStart: wm.start,
          scheduledEnd: wm.end,
          sipUri: wm.sipAddress,
        }));
    },
    status,
  };
}
