/**
 * Composition root — wires the foundation, media, and Webex-integration units
 * (Webex account integration) into one process.
 *
 * Dependency graph:
 *   loadConfig / openDb
 *     └─ db helpers (appendAudit, upsertBotStatus)
 *     └─ createApp (Express, lifecycle adapter, webex read seams)
 *        └─ createMediaHub
 *        └─ createBotManager (hub, botFactory)
 *           └─ createOrchestrator (botManager, db helpers)
 *              └─ mountLiveSocket (server, hub, verifyToken)
 *     └─ createServiceAppTokens → createMeetingsClient        (only
 *        └─ createCalendarSync (onRegister → orchestrator)     when the service
 *        └─ createRosterMonitor (onSolitude → orchestrator)    app is configured)
 */
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { loadConfig } from './config.js';
import { openDb } from './db/index.js';
import { appendAudit, makeAuditEntry } from './db/audit.js';
import { upsertBotStatus as dbUpsertBotStatus, reconcileStaleBotStatus } from './db/botStatus.js';
import { getMeeting } from './db/meetings.js';
import { upsertPresence } from './db/presence.js';
import { verifyAppSession } from './auth/appToken.js';
import { createApp } from './server.js';
import { createMediaHub } from './media/hub.js';
import { createBotManager } from './media/botManager.js';
import { createOrchestrator } from './media/orchestrator.js';
import { mountLiveSocket } from './media/liveSocket.js';
import { createServiceAppTokens, type ServiceAppTokens } from './webex/serviceAppTokens.js';
import { createMeetingsClient, type CreateMeetingOpts, type CreatedMeeting } from './webex/meetingsClient.js';
import { createCalendarSync, type CalendarSync } from './webex/calendarSync.js';
import { createRosterMonitor, type RosterMonitor } from './webex/rosterMonitor.js';
import { createRosterPeek } from './webex/rosterPeek.js';
import { createWebexBotProcess, type WebexBotRuntimeDeps } from './media/webexBotProcess.js';
import { createGuestBotTokenProvider } from './webex/botToken.js';
import type {
  AuditEntry,
  BotStatus,
  ChaperonedMeeting,
  RosterAttendee,
  WebexIntegrationStatus,
} from './domain/types.js';
import type { BotProcessFactory } from './media/types.js';

export interface AppDeps {
  /** Prod (main.ts): the browser runtime. Composition builds the BotProcess
   *  factory + an internal guest-token provider from it. */
  botRuntime?: Omit<WebexBotRuntimeDeps, 'tokenProvider'>;
  /** Tests: inject a fake BotProcess factory directly (skips Puppeteer entirely). */
  botFactory?: BotProcessFactory;
  /** Defaults to config.databasePath (the real on-disk path). Pass ':memory:' for tests. */
  dbPath?: string;
}

export function buildApp(deps: AppDeps): {
  server: Server;
  orchestrator: ReturnType<typeof createOrchestrator>;
  /** Webex-integration seams — undefined when the integration is disabled (no credentials). */
  calendarSync?: CalendarSync;
  rosterMonitor?: RosterMonitor;
  start(port: number): Promise<void>;
  stop(): Promise<void>;
} {
  // 1. Config + DB
  const cfg = loadConfig();
  const db = openDb(deps.dbPath ?? cfg.databasePath);

  // 1.5 Startup reconciliation (fail-loud). In-memory bot + roster monitoring
  //     does not survive a process restart, but bot_status persists. Any row
  //     still connected/dialing at boot is stale — a fresh process has no live
  //     bot behind it — and would read as false "connected" coverage. Mark them
  //     disconnected so the overview shows an honest gap. This only corrects the
  //     display; re-joining a still-in-window meeting is the (unbuilt)
  //     chaperone-gap recovery, NOT something calendar sync does (checkDue skips
  //     meetings that already have a row).
  const staleMeetingIds = reconcileStaleBotStatus(db);
  if (staleMeetingIds.length > 0) {
    console.error(
      `[composition] LOUD: reconciled ${staleMeetingIds.length} stale bot_status row(s) to 'disconnected' on ` +
        'startup — a previous run left them connected/dialing with no live bot (restart or crash).',
    );
    // Mirror each reconciled disconnect into the audit trail — matching the
    // orchestrator's bot_error entry on a normal disconnect — so a restart-caused
    // gap is not the one 'disconnected' the admin /audit view never records.
    for (const meetingId of staleMeetingIds) {
      appendAudit(
        db,
        makeAuditEntry('bot_error', meetingId, {
          detail: 'bot connection lost across a process restart (reconciled on startup)',
        }),
      );
    }
  }

  // 2. Shutdown guard — server.close() callback can fire before TCP socket 'close' events
  //    fully propagate through the ws library, so the liveSocket `onEnd` handler may call
  //    writeAudit after db.close().  Setting this flag synchronously before db.close() lets
  //    late close events skip the write gracefully instead of throwing ERR_INVALID_STATE.
  let dbClosed = false;

  // 3. DB helper adapters
  const writeAudit = (e: AuditEntry) => {
    if (dbClosed) {
      console.warn('[composition] late audit skipped during shutdown:', e.action);
      return;
    }
    appendAudit(db, e);
  };

  // 4. Media stack — hub is independent. The bot factory + manager are built
  //    AFTER the Webex tokens exist, because the prod guest-token provider needs
  //    them; tests inject deps.botFactory and skip the token path entirely.
  const hub = createMediaHub();

  // Webex-integration seams — declared up front so the factory build, the lifecycle
  // adapters, and the health roll-up can all reference them. Assigned only when
  // the integration is configured (and, for calendarSync, when auto-sync is on).
  let tokens: ServiceAppTokens | undefined;
  let calendarSync: CalendarSync | undefined;
  let rosterMonitor: RosterMonitor | undefined;
  /** Read seam — bot-independent roster peek for GET
   *  /meetings/:id?peek=1. Stays undefined when the integration is disabled,
   *  which makes the route's peek path answer rosterSource:'none'. */
  let peekRoster: ((webexMeetingId: string) => Promise<RosterAttendee[]>) | undefined;
  /** Write seam — createMeeting followed by the immediate syncNow
   *  (Decision B). Stays undefined when calendar sync is disabled (no creds OR
   *  CALENDAR_SYNC_ENABLED=false), which makes POST /meetings/schedule answer a
   *  loud 503. */
  let scheduleMeeting: ((opts: CreateMeetingOpts) => Promise<CreatedMeeting>) | undefined;

  // Webex account integration is wired only when the service app is configured;
  // otherwise LOUDLY disabled and reported as webex_integration 'failed'. Tokens
  // are minted FIRST because the SDK bot's guest-token provider needs them; the
  // calendar/roster/peek seams are wired in the second phase (step 6.5), after
  // the bot manager + orchestrator exist.
  const webexConfigured =
    cfg.serviceApp.clientId !== '' &&
    cfg.serviceApp.clientSecret !== '' &&
    cfg.webex.schedulerEmail !== '';

  if (webexConfigured) {
    tokens = createServiceAppTokens({
      db,
      clientId: cfg.serviceApp.clientId,
      clientSecret: cfg.serviceApp.clientSecret,
      bootstrapRefreshToken: cfg.serviceApp.refreshToken,
      webexApiBase: cfg.webexApiBase,
    });
  }

  // Bot process factory: tests inject deps.botFactory; prod builds it from the
  // browser runtime + an internal guest-token provider (which needs `tokens`).
  // Composition never imports puppeteer — main.ts supplies launchBrowser.
  let botFactory: BotProcessFactory;
  if (deps.botFactory) {
    botFactory = deps.botFactory;
  } else {
    if (!deps.botRuntime) throw new Error('buildApp: provide botFactory (tests) or botRuntime (prod)');
    if (!tokens) throw new Error('buildApp: Webex integration must be configured for the SDK bot runtime');
    const tokenProvider = createGuestBotTokenProvider({
      getServiceAppToken: () => tokens!.getAccessToken(),
      webexApiBase: cfg.webexApiBase,
      // Operator escape hatch: the guest subject is derived, so a wedged guest user is
      // re-derived identically forever. Changing the prefix rotates the whole fleet.
      subjectPrefix: cfg.webex.guestSubjectPrefix,
    });
    const runtime = deps.botRuntime;
    botFactory = (spec) => createWebexBotProcess(spec, { ...runtime, tokenProvider, mediaMode: cfg.botMediaMode });
  }

  const botManager = createBotManager({
    hub,
    botFactory,
    displayName: cfg.sip.displayName,
    sipTransport: cfg.sip.transport,
  });

  // 5. Orchestrator — adapts unary (s) => void to the db fn upsertBotStatus(db, s).
  //    Guard: skip persisting bot_status when the parent meetings row no longer exists.
  //    This prevents a FK violation when a bot emits its terminal 'ended' status after
  //    DELETE /meetings already removed the meetings row (and its bot_status row).
  //    getMeeting + upsertBotStatus are both synchronous (node:sqlite), so there is no
  //    TOCTOU window here. The writeAudit adapter is separate and still fires — so the
  //    bot_leave audit entry is written even when the persist is skipped.
  const persistBotStatus = (s: BotStatus) => {
    if (getMeeting(db, s.meetingId)) dbUpsertBotStatus(db, s);
  };
  const orchestrator = createOrchestrator({
    botManager,
    upsertBotStatus: persistBotStatus,
    writeAudit,
    // Generous, env-tunable window: an SDK guest lobby'd by the org's admission policy
    // needs time for a host to admit it before the bot gives up.
    retry: { maxAttempts: cfg.botRetry.maxAttempts, maxDelayMs: cfg.botRetry.maxDelayS * 1000 },
  });

  // 6. Lifecycle adapters — fire-and-forget so REST handler never blocks on bot-start failures.
  //    Rejections are caught and logged; never left unhandled. (registerMeeting /
  //    deregisterMeeting are async functions, so a sync throw is impossible by
  //    construction — errors always surface as the rejection caught here.)
  //    The Webex-integration seams (calendarSync/rosterMonitor) are declared above and
  //    only assigned in step 6.5, so these closures reference them safely.
  const lifecycle = {
    onRegister: (m: ChaperonedMeeting) => {
      void orchestrator
        .registerMeeting(m)
        .catch((err) => console.error('[composition] bot start failed', m.meetingId, err));
    },
    onDeregister: (id: string, webexMeetingId?: string) => {
      // Deregister = the meetings row is gone (DELETE /meetings): stop polling
      // and EVICT the cached roster — GET /meetings/:id now 404s, so the cache
      // entry is unreachable garbage and must not accumulate. Bot terminal
      // states (incl. solitude) keep the last-known roster because the meeting
      // row still exists. stopMonitoring runs first so a stale in-flight poll
      // cannot repopulate the roster after the eviction.
      // Tombstone the calendar entry: the row that guarded checkDue is gone,
      // so without this the next due tick auto-undoes the admin's DELETE
      // (re-register + re-dial). Manual meetings without a webexMeetingId are
      // unaffected. Deleted CALENDAR meetings always carry one.
      if (webexMeetingId !== undefined) calendarSync?.suppress(webexMeetingId);
      rosterMonitor?.stopMonitoring(id);
      rosterMonitor?.evictRoster(id);
      void orchestrator
        .deregisterMeeting(id)
        .catch((err) => console.error('[composition] bot stop failed', id, err));
    },
  };

  // 6.5 Webex account integration: client → calendarSync (gated) +
  //     rosterMonitor + roster peek + roster lifecycle hook. `tokens` was minted
  //     in step 4 (the SDK bot's guest identity consumes it); wired only when the
  //     service app is configured, otherwise LOUDLY disabled below.
  if (webexConfigured) {
    const client = createMeetingsClient({
      getAccessToken: () => tokens!.getAccessToken(),
      webexApiBase: cfg.webexApiBase,
      hostEmail: cfg.webex.schedulerEmail,
    });
    // Manual-register-only gate: with CALENDAR_SYNC_ENABLED=false the calendar
    // auto-sync + scheduling seams are NOT created, so a parallel deployment
    // cannot double-dial. tokens/roster/peek + the SDK guest identity stay live;
    // getUpcoming() → [] and POST /meetings/schedule → loud 503.
    if (cfg.webex.calendarSyncEnabled) {
      calendarSync = createCalendarSync({
        client,
        db,
        onRegister: (m) => lifecycle.onRegister(m), // same path as POST /meetings
        upsertBotStatus: persistBotStatus,
        writeAudit,
        syncIntervalMs: cfg.webex.calendarSyncIntervalS * 1000,
        windowMs: cfg.webex.calendarWindowH * 3_600_000,
      });
      const sync = calendarSync; // narrowed: definitely assigned here
      scheduleMeeting = async (opts) => {
        const created = await client.createMeeting(opts);
        // Decision B: immediate post-create sync so the meeting appears in
        // Upcoming within seconds — fire-and-forget with a caught rejection.
        // The create already succeeded; a sync hiccup must never fail the
        // request (the periodic sync ≤5 min is the backstop). syncNow's own
        // contract is never-throw + loud logging; the .catch is belt-and-braces.
        void sync.syncNow().catch((err) =>
          console.error('[composition] post-create syncNow failed (periodic sync will catch up):', err));
        return created;
      };
    } else {
      console.warn(
        '[composition] CALENDAR_SYNC_ENABLED=false — calendar auto-sync + scheduling DISABLED ' +
        '(manual-register-only). Roster/solitude monitoring and the SDK guest identity stay active; ' +
        'GET /meetings/upcoming → [] and POST /meetings/schedule → 503.',
      );
    }
    rosterMonitor = createRosterMonitor({
      client,
      // Non-throwing by construction: deregisterMeeting is an async function
      // (never throws synchronously) and the rejection is caught here — the
      // rosterMonitor interval tick (`void pollNow(...)`) is never poisoned.
      onSolitude: (id) => {
        void orchestrator
          .deregisterMeeting(id, 'solitude') // → SIP BYE + bot_leave audit with reason
          .catch((err) => console.error('[composition] solitude hang-up failed', id, err));
      },
      internalEmailDomains: cfg.webex.internalEmailDomains,
      botDisplayName: cfg.sip.displayName,
      // Ended-meeting history: mirror every successful poll into SQLite so the
      // roster survives cache eviction and process restarts. Same existence
      // guard as persistBotStatus — a stale write after DELETE /meetings must
      // not violate the roster_presence FK. (Synchronous node:sqlite: no TOCTOU.)
      persistRoster: (id, roster) => {
        if (getMeeting(db, id)) upsertPresence(db, id, roster);
      },
      pollIntervalMs: cfg.webex.rosterPollIntervalS * 1000,
      solitudeTimeoutMs: cfg.webex.solitudeTimeoutS * 1000,
    });
    // Bot-independent roster peek (view-failed-meeting): serves GET
    // /meetings/:id?peek=1 when no monitor cache exists. TTL reuses the
    // roster poll interval so peek load on Webex never exceeds monitor load.
    const rosterPeek = createRosterPeek({
      client,
      internalEmailDomains: cfg.webex.internalEmailDomains,
      botDisplayName: cfg.sip.displayName,
      ttlMs: cfg.webex.rosterPollIntervalS * 1000,
    });
    peekRoster = (webexMeetingId) => rosterPeek.peek(webexMeetingId);
    // Roster lifecycle: poll while connected; stop on terminal states.
    // botManager.onStatus supports multiple listeners — the orchestrator's
    // listener (registered in createOrchestrator) is unaffected. The listener
    // is dispatched synchronously from botManager.emit, so it must NEVER
    // throw — a throw would propagate into the BotProcess event handler.
    botManager.onStatus((s) => {
      try {
        if (!rosterMonitor) return;
        if (s.state === 'connected') {
          const m = getMeeting(db, s.meetingId);
          if (m?.webexMeetingId) {
            rosterMonitor.startMonitoring(m.meetingId, m.webexMeetingId);
          } else {
            console.warn(
              '[composition] meeting has no webexMeetingId — roster/solitude disabled for',
              s.meetingId,
            );
          }
        } else if (s.state === 'ended' || s.state === 'failed' || s.state === 'disconnected') {
          // Stop polling; the last-known roster is KEPT until deregister
          // (see lifecycle.onDeregister for the eviction contract).
          rosterMonitor.stopMonitoring(s.meetingId);
        }
      } catch (err) {
        console.error('[composition] LOUD: roster lifecycle hook failed for', s.meetingId, err);
      }
    });
  } else {
    console.error(
      '[composition] LOUD: Webex integration DISABLED — set WEBEX_SA_CLIENT_ID, ' +
      'WEBEX_SA_CLIENT_SECRET and WEBEX_SCHEDULER_EMAIL. ' +
      "GET /meetings will report webex_integration: 'failed'; " +
      'POST /meetings/schedule will answer 503.',
    );
  }

  // Health roll-up for GET /meetings (spec semantics):
  // failed = token refresh down (no Webex data at all);
  // degraded = tokens fine but calendar stale or ≥1 roster poll blind.
  // Note the pre-first-refresh case: tokens.status() starts 'ok' before any
  // refresh, but calendarSync.status() is 'stale' until the first successful
  // sync (which itself requires a successful refresh) — so 'ok' here proves a
  // real refresh happened; a pre-refresh boot reports 'degraded', never 'ok'.
  // isBlind() is deliberately GLOBAL: ANY blind monitored meeting → 'degraded'.
  // Wrapped so GET /meetings can never be taken down by the roll-up (T7 seam
  // contract: integrationStatus must be non-throwing).
  const integrationStatus = (): WebexIntegrationStatus => {
    try {
      if (!tokens || tokens.status() === 'failed') return 'failed';
      // calendarSync is undefined when CALENDAR_SYNC_ENABLED=false (manual-
      // register-only): don't report the missing calendar axis as degraded.
      // rosterMonitor is always present when tokens are, but guard defensively.
      if (calendarSync?.status() === 'stale') return 'degraded';
      if (rosterMonitor?.isBlind()) return 'degraded';
      return 'ok';
    } catch (err) {
      console.error('[composition] LOUD: integrationStatus roll-up threw — reporting failed', err);
      return 'failed';
    }
  };

  // 7. Express app — pass the SAME cfg so both share one secret/allowlist
  const app = createApp({
    config: cfg,
    db,
    lifecycle,
    webex: {
      getRoster: (id) => rosterMonitor?.getRoster(id) ?? [],
      getUpcoming: () => calendarSync?.getUpcoming() ?? [],
      integrationStatus,
      scheduleMeeting, // undefined when disabled → router's loud 503
      ...(peekRoster ? { peekRoster } : {}), // absent when integration is disabled
    },
  });

  // 8. HTTP server + WebSocket upgrade
  const server = createServer(app);
  mountLiveSocket(server, {
    hub,
    // AppSession is { email, role } — structurally identical to LiveSocketDeps.verifyToken return
    verifyToken: (t) => verifyAppSession(t, cfg.appSecret),
    writeAudit,
  });

  // I2: in-flight stop promise — repeated calls coalesce so db/server are never closed twice.
  let stopPromise: Promise<void> | undefined;

  return {
    server,

    orchestrator,

    calendarSync,

    rosterMonitor,

    start: (port: number) =>
      new Promise<void>((res) =>
        server.listen(port, () => {
          calendarSync?.start(); // immediate first sync = loud startup preflight
          res();
        }),
      ),

    stop: () => {
      stopPromise ??= (async () => {
        console.log('[composition] shutdown: stopping bots...');
        // Stop the pollers first so no sync/roster tick fires into a
        // closing orchestrator/db.
        rosterMonitor?.stopAll();
        calendarSync?.stop();
        // stopAll() awaits every bot teardown; all db writes (audit + botStatus) complete here.
        await orchestrator.stopAll();
        console.log('[composition] shutdown: bots stopped, closing server...');
        // closeAllConnections() (Node 18.2+) causes server.close() to resolve promptly; without
        // it, keep-alive HTTP and WS connections would hold the server open indefinitely.
        server.closeAllConnections();
        await new Promise<void>((res) => server.close(() => res()));
        // Set the guard before db.close() — any late WS socket-close events that propagate
        // after the server.close() callback (a Node.js timing subtlety) will see dbClosed=true
        // and skip the write rather than throwing ERR_INVALID_STATE.
        dbClosed = true;
        db.close();
        console.log('[composition] shutdown complete.');
      })();
      return stopPromise;
    },
  };
}
