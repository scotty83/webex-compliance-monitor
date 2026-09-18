import 'dotenv/config';

export interface Config {
  port: number;
  appBaseUrl: string;
  appSecret: string;
  serviceApp: { clientId: string; clientSecret: string; refreshToken: string };
  oauth: { clientId: string; clientSecret: string; redirectUri: string; scopes: string };
  /** Base URL for Webex REST API calls (OAuth + people/me). Env: WEBEX_API_BASE. */
  webexApiBase: string;
  officerEmails: string[];
  adminEmails: string[];
  databasePath: string;
  sip: {
    localUri: string;
    transport: string;
    /** Display name shown in the Webex roster and SIP From header. Env: BOT_DISPLAY_NAME. */
    displayName: string;
  };
  /** SDK bot loopback page: the browser runtime serves these assets from 127.0.0.1. */
  botPage: {
    /** Directory the loopback bot-page assets are served from. Env: BOT_PAGE_ASSET_DIR. */
    assetDir: string;
    /** Headless Chromium executable (empty = Puppeteer's bundled build). Env: CHROMIUM_PATH. */
    chromiumPath: string;
  };
  /** Bot dial retry/give-up tuning. An SDK guest that lands in the meeting lobby needs a
   *  long enough window for a host to admit it, so these are generous + env-tunable. */
  botRetry: {
    maxAttempts: number; // BOT_MAX_ATTEMPTS
    maxDelayS: number;   // BOT_RETRY_MAX_DELAY_S — cap on the backoff between attempts
  };
  /** How the SDK bot receives remote audio. Env: BOT_MEDIA_MODE.
   *  'transcoded'  = one server-mixed audio stream (simple, no video decode) — preferred;
   *  'multistream' = per-speaker streams mixed locally, requires videoEnabled (proven fallback). */
  botMediaMode: 'transcoded' | 'multistream';
  /** Webex account integration (calendar sync, roster, solitude). */
  webex: {
    /** The single scheduling account — sent as hostEmail on admin-scoped calls. Env: WEBEX_SCHEDULER_EMAIL. */
    schedulerEmail: string;
    /** Comma-separated domains classified 'fo'; other authenticated → 'analyst'. Env: INTERNAL_EMAIL_DOMAINS. */
    internalEmailDomains: string[];
    calendarSyncIntervalS: number;
    calendarWindowH: number;
    rosterPollIntervalS: number;
    solitudeTimeoutS: number;
    /** Manual-register-only gate: when false, calendar auto-sync + scheduling are
     *  disabled so a parallel deployment cannot double-dial. Env: CALENDAR_SYNC_ENABLED
     *  (default true; the literal 'false' disables). */
    calendarSyncEnabled: boolean;
    /** Label every bot's Webex guest `subject` is built from; the per-meeting digest is
     *  appended to it. Env: WEBEX_GUEST_SUBJECT_PREFIX (default 'compliance-bot'). This is the
     *  fleet-wide rotation lever: because the subject is derived, a guest user Webex has
     *  wedged would otherwise be re-derived identically on every retry — changing the
     *  prefix moves every bot to a fresh guest identity. */
    guestSubjectPrefix: string;
  };
  /** When set (single-origin prod deploy), the backend also serves the built frontend from this dir. */
  frontendDist?: string;
}

export function parseEmails(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
}

export function loadConfig(): Config {
  const get = (k: string, fallback?: string): string => {
    const v = process.env[k] ?? fallback;
    if (v === undefined) throw new Error(`Missing required env var: ${k}`);
    return v;
  };
  // Numeric env parsing is fail-LOUD: Number('typo') = NaN would clamp
  // setInterval(fn, NaN) to 1 ms (API hammering) and make `aloneMs >= NaN`
  // never true (solitude silently disabled). Absent/blank → default silently;
  // set-but-bad → ONE loud line naming the var, then the default.
  const getNum = (k: string, fallback: number): number => {
    const raw = process.env[k];
    if (raw === undefined || raw.trim() === '') return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) {
      console.error(
        `[config] LOUD: env var ${k}="${raw}" is not a non-negative number — using default ${fallback}`,
      );
      return fallback;
    }
    return n;
  };
  // Strictly-positive variant for intervals, windows and retry tuning, where 0 is
  // as destructive as NaN: setInterval(fn, 0) hammers the Webex API every tick, a
  // 0 backoff cap turns join retries into a storm, 0 attempts never dials at all,
  // and a 0-hour window syncs no meetings — each a SILENT loss of coverage.
  // Deliberately NOT used for PORT (0 = OS-assigned ephemeral port) or
  // SOLITUDE_TIMEOUT_S (0 = hang up as soon as the bot is alone), where 0 is real.
  const getPositiveNum = (k: string, fallback: number, integer = false): number => {
    const raw = process.env[k];
    if (raw === undefined || raw.trim() === '') return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0 || (integer && !Number.isInteger(n))) {
      console.error(
        `[config] LOUD: env var ${k}="${raw}" is not a positive ${integer ? 'integer' : 'number'} — ` +
        `using default ${fallback}`,
      );
      return fallback;
    }
    return n;
  };
  return {
    port: getNum('PORT', 4000),
    appBaseUrl: get('APP_BASE_URL', 'http://localhost:5173'),
    appSecret: get('APP_SECRET'),
    serviceApp: {
      clientId: get('WEBEX_SA_CLIENT_ID', ''),
      clientSecret: get('WEBEX_SA_CLIENT_SECRET', ''),
      refreshToken: get('WEBEX_SA_REFRESH_TOKEN', ''),
    },
    oauth: {
      clientId: get('WEBEX_OAUTH_CLIENT_ID', ''),
      clientSecret: get('WEBEX_OAUTH_CLIENT_SECRET', ''),
      redirectUri: get('WEBEX_OAUTH_REDIRECT_URI', 'http://localhost:4000/auth/callback'),
      scopes: get('WEBEX_OAUTH_SCOPES', 'spark:people_read'),
    },
    webexApiBase: get('WEBEX_API_BASE', 'https://webexapis.com/v1').replace(/\/$/, ''),
    officerEmails: parseEmails(process.env.OFFICER_EMAILS),
    adminEmails: parseEmails(process.env.ADMIN_EMAILS),
    databasePath: get('DATABASE_PATH', './data/compliance-monitor.db'),
    sip: {
      localUri: get('SIP_LOCAL_URI', 'sip:compliance-bot@localhost'),
      transport: get('SIP_TRANSPORT', 'tls'),
      displayName: get('BOT_DISPLAY_NAME', 'Compliance Monitor Bot'),
    },
    botPage: {
      assetDir: get('BOT_PAGE_ASSET_DIR', '/app/bot-page'),
      chromiumPath: get('CHROMIUM_PATH', ''),
    },
    botRetry: {
      maxAttempts: getPositiveNum('BOT_MAX_ATTEMPTS', 12, true), // a count — 0.5 attempts is meaningless
      maxDelayS: getPositiveNum('BOT_RETRY_MAX_DELAY_S', 30),
    },
    botMediaMode: ((): 'transcoded' | 'multistream' => {
      const v = get('BOT_MEDIA_MODE', 'transcoded').toLowerCase();
      if (v === 'transcoded' || v === 'multistream') return v;
      console.error(`[config] LOUD: BOT_MEDIA_MODE="${v}" invalid — using 'transcoded'`);
      return 'transcoded';
    })(),
    webex: {
      schedulerEmail: get('WEBEX_SCHEDULER_EMAIL', ''),
      internalEmailDomains: parseEmails(process.env.INTERNAL_EMAIL_DOMAINS),
      calendarSyncIntervalS: getPositiveNum('CALENDAR_SYNC_INTERVAL_S', 300),
      calendarWindowH: getPositiveNum('CALENDAR_WINDOW_H', 24),
      rosterPollIntervalS: getPositiveNum('ROSTER_POLL_INTERVAL_S', 20),
      solitudeTimeoutS: getNum('SOLITUDE_TIMEOUT_S', 600),
      calendarSyncEnabled: get('CALENDAR_SYNC_ENABLED', 'true').toLowerCase() !== 'false',
      guestSubjectPrefix: get('WEBEX_GUEST_SUBJECT_PREFIX', 'compliance-bot'),
    },
    frontendDist: process.env.FRONTEND_DIST || undefined,
  };
}
