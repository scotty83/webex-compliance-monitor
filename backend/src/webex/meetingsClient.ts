/**
 * Typed Webex REST wrapper — NO policy here, just transport:
 * auth header, hostEmail (service apps act as a machine account and need
 * the admin meeting scopes), 429 Retry-After honoring, 403 → named scope
 * error, ≤1 in-flight participants call per meeting.
 *
 * Exact admin scope names are verified against the LIVE API at deploy —
 * the error messages below name them so a mismatch is diagnosable in one read.
 */

export interface WebexMeeting {
  id: string;
  title: string;
  start: number;        // epoch ms (parsed from Webex ISO)
  end?: number;         // epoch ms
  sipAddress?: string;  // absent → the no-SIP fail-LOUD path in calendarSync
  password?: string;    // meeting password → dtmf; credential — do not log
}

export interface WebexParticipant {
  id: string;
  displayName: string;
  /** Email the attendee AUTHENTICATED with; absent for guests. */
  email?: string;
  host: boolean;
  /** Only 'joined' counts as present in the meeting. */
  state: 'joined' | 'lobby' | 'end';
  /** True when the participant joined by PSTN dial-in or callback. */
  pstn: boolean;
  /** The unmasked phone number — present when Webex delivers it in the
   *  participant payload (devices[].phoneNumber or person.phoneNumber).
   *  Best-effort: may be absent even for PSTN callers if Webex withholds it. */
  phone?: string;
}

/** Input to createMeeting (in-portal scheduling). */
export interface CreateMeetingOpts {
  title: string;
  start: number;       // epoch ms (converted to ISO for Webex)
  end: number;         // epoch ms
  invitees: string[];  // emails; Webex sends the calendar invites (sendEmail: true)
}

/** Result of createMeeting. NO credentials — password/dtmf never appear here. */
export interface CreatedMeeting {
  webexMeetingId: string; // Webex `id`
  title: string;
  start: number;          // epoch ms (parsed from Webex ISO)
  sipAddress: string;     // REQUIRED — a meeting the bot can't dial fails LOUD
  joinUrl: string;        // Webex `webLink`, surfaced to the admin
}

export class WebexApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'WebexApiError';
  }
}

/** 403 — the service app lacks an admin meeting scope. Loud + named. */
export class WebexScopeError extends WebexApiError {
  constructor(message: string) {
    super(403, message);
    this.name = 'WebexScopeError';
  }
}

export interface MeetingsClientDeps {
  getAccessToken: () => Promise<string>;
  /** All URLs route through this (WEBEX_API_BASE constraint). */
  webexApiBase: string;
  /** WEBEX_SCHEDULER_EMAIL — sent as hostEmail on every call. */
  hostEmail: string;
  fetchImpl?: typeof fetch;
  /** Injectable wait for 429 Retry-After (tests resolve instantly). */
  sleep?: (ms: number) => Promise<void>;
  /** Cap (seconds) honored from Retry-After. Default 60. */
  maxRetryAfterS?: number;
}

export interface MeetingsClient {
  listUpcomingMeetings(window: { from: number; to: number }): Promise<WebexMeeting[]>;
  listParticipants(webexMeetingId: string): Promise<WebexParticipant[]>;
  createMeeting(opts: CreateMeetingOpts): Promise<CreatedMeeting>;
}

/** A parseable-but-malformed 2xx body must fail LOUD through the taxonomy
 *  (mirrors the serviceAppTokens hardening) — never a raw SyntaxError, a NaN
 *  start, or a type-lying item flowing into calendarSync/rosterMonitor.
 *  Every field is type-validated IF PRESENT (wrong type → loud); only a
 *  genuinely absent optional field gets a lenient default. */
function malformedError(status: number, path: string, detail: string): WebexApiError {
  return new WebexApiError(status, `Webex API error: malformed response body for ${path} (${detail})`);
}

/** Items requested per page of a Webex list endpoint (its default is 10). */
const PAGE_SIZE = 100;
/** Hard cap on pages followed per list call — at PAGE_SIZE that is 2000 meetings,
 *  far beyond any real chaperone window, so hitting it means a broken Link chain. */
const MAX_PAGES = 20;

/** Webex pages list endpoints via RFC-5988 `Link` headers:
 *  `<https://…/meetings?offset=10>; rel="next"`. Returns the next-page URL, or
 *  undefined on the last page. Other rels (prev/first/last) are ignored. */
function nextPageUrl(linkHeader: string | null): string | undefined {
  if (!linkHeader) return undefined;
  for (const part of linkHeader.split(',')) {
    const m = /<([^>]+)>\s*;\s*rel\s*=\s*"?next"?/i.exec(part);
    if (m) return m[1].trim();
  }
  return undefined;
}

/** Validate a Link rel="next" target before we follow it. Every page request
 *  carries the service app's ADMIN bearer token, so an off-origin next URL (from
 *  a compromised or misbehaving proxy in front of WEBEX_API_BASE) would exfiltrate
 *  that token. Anything not on the API's own origin is refused, loudly. */
function safeNextPage(nextUrl: string, apiOrigin: string): URL | undefined {
  let parsed: URL;
  try {
    parsed = new URL(nextUrl);
  } catch {
    console.error(`[meetingsClient] LOUD: unparseable Link rel="next" — stopping paging (data may be incomplete)`);
    return undefined;
  }
  if (parsed.origin !== apiOrigin) {
    console.error(
      '[meetingsClient] LOUD: Link rel="next" points off-origin — refusing to send the ' +
      'service-app token there; stopping paging (data may be incomplete)',
    );
    return undefined;
  }
  return parsed;
}

function itemsOf(status: number, path: string, body: unknown): unknown[] {
  if (typeof body !== 'object' || body === null) throw malformedError(status, path, 'not a JSON object');
  const items = (body as { items?: unknown }).items;
  if (items === undefined) return []; // Webex omits items when the page is empty
  if (!Array.isArray(items)) throw malformedError(status, path, 'items is not an array');
  return items;
}

function parseMeeting(status: number, path: string, item: unknown): WebexMeeting {
  const i = (typeof item === 'object' && item !== null ? item : {}) as Record<string, unknown>;
  if (typeof i.id !== 'string' || typeof i.title !== 'string' || typeof i.start !== 'string') {
    throw malformedError(status, path, 'meeting item missing/invalid id, title, or start');
  }
  const start = Date.parse(i.start);
  if (Number.isNaN(start)) throw malformedError(status, path, `meeting ${i.id}: unparseable start`);
  let end: number | undefined;
  if (i.end !== undefined) {
    end = typeof i.end === 'string' ? Date.parse(i.end) : NaN;
    if (Number.isNaN(end)) throw malformedError(status, path, `meeting ${i.id}: unparseable end`);
  }
  if (i.sipAddress !== undefined && typeof i.sipAddress !== 'string') {
    throw malformedError(status, path, `meeting ${i.id}: invalid sipAddress`);
  }
  if (i.password !== undefined && typeof i.password !== 'string') {
    throw malformedError(status, path, `meeting ${i.id}: invalid password field type`); // never log the value
  }
  return { id: i.id, title: i.title, start, end, sipAddress: i.sipAddress, password: i.password };
}

function parseParticipant(status: number, path: string, item: unknown): WebexParticipant {
  const i = (typeof item === 'object' && item !== null ? item : {}) as Record<string, unknown>;
  if (typeof i.id !== 'string') throw malformedError(status, path, 'participant item missing/invalid id');
  if (i.displayName !== undefined && typeof i.displayName !== 'string') {
    throw malformedError(status, path, `participant ${i.id}: invalid displayName`);
  }
  if (i.email !== undefined && typeof i.email !== 'string') {
    throw malformedError(status, path, `participant ${i.id}: invalid email`);
  }
  // host/state: types validated IF PRESENT (a type-lied value must fail loud —
  // 'end' means "not present" downstream, so silently coercing a lying `joined`
  // would quietly drop the participant from the roster); missing stays lenient.
  if (i.host !== undefined && typeof i.host !== 'boolean') {
    throw malformedError(status, path, `participant ${i.id}: invalid host`);
  }
  if (i.state !== undefined && typeof i.state !== 'string') {
    throw malformedError(status, path, `participant ${i.id}: invalid state`);
  }
  // ── PSTN enrichment (ADDITIVE — malformed entries skipped LENIENTLY, never throw)
  // Rationale: devices/person internals are enrichment. Failing a whole roster poll
  // (→ blind freeze) over a bad enrichment field would harm the core function.
  // The EXISTING loud validation for id/displayName/email/host/state above is untouched.
  let phone: string | undefined;

  // 1. Top-level phoneNumber
  if (typeof i.phoneNumber === 'string' && i.phoneNumber) phone = i.phoneNumber;

  // 2. person.phoneNumber (may appear even when devices is absent)
  if (!phone) {
    try {
      const person = (i as Record<string, unknown>).person;
      if (typeof person === 'object' && person !== null) {
        const pn = (person as Record<string, unknown>).phoneNumber;
        if (typeof pn === 'string' && pn) phone = pn;
      }
    } catch { /* lenient */ }
  }

  // 3. devices[].phoneNumber — first entry with a callIn/callBack callType wins for phone
  let pstnFromDevices = false;
  try {
    const devices = (i as Record<string, unknown>).devices;
    if (Array.isArray(devices)) {
      for (const d of devices) {
        if (d == null || typeof d !== 'object') continue;
        const rec = d as Record<string, unknown>;
        const ct = rec.callType;
        if (ct === 'callIn' || ct === 'callBack') {
          pstnFromDevices = true;
          if (!phone && typeof rec.phoneNumber === 'string' && rec.phoneNumber) {
            phone = rec.phoneNumber;
          }
        }
      }
    }
  } catch { /* lenient */ }

  // pstn: true if any device is callIn/callBack, OR phone found, OR masked-number displayName
  const maskedShape = /^\+?\d+\*+\d+$/;
  const pstn = pstnFromDevices || phone !== undefined || maskedShape.test(i.displayName ?? '');

  return {
    id: i.id,
    displayName: i.displayName ?? '',
    email: i.email,
    host: i.host ?? false,
    // Unknown STRING states (e.g. a value Webex adds later) still coerce to
    // 'end' — deliberate live-API safety: fail closed on presence, not loud
    // on vocabulary drift. Missing state also defaults to 'end'.
    state: i.state === 'joined' || i.state === 'lobby' ? i.state : 'end',
    pstn,
    phone,
  };
}

function parseCreatedMeeting(status: number, path: string, body: unknown): CreatedMeeting {
  const i = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  if (typeof i.id !== 'string' || typeof i.title !== 'string' || typeof i.start !== 'string') {
    throw malformedError(status, path, 'created meeting missing/invalid id, title, or start');
  }
  const start = Date.parse(i.start);
  if (Number.isNaN(start)) throw malformedError(status, path, `created meeting ${i.id}: unparseable start`);
  if (typeof i.webLink !== 'string' || i.webLink === '') {
    throw malformedError(status, path, `created meeting ${i.id}: missing webLink`);
  }
  // FAIL LOUD (spec): a meeting without a SIP address exists but is
  // unmonitorable — the bot cannot dial it. Surface it; never a half-result.
  if (typeof i.sipAddress !== 'string' || i.sipAddress === '') {
    throw new WebexApiError(
      status,
      `Webex created meeting ${i.id} with no sipAddress — the bot cannot dial it; ` +
      `verify the site's video-device (SIP) dial-in setting`,
    );
  }
  return { webexMeetingId: i.id, title: i.title, start, sipAddress: i.sipAddress, joinUrl: i.webLink };
}

export function createMeetingsClient(deps: MeetingsClientDeps): MeetingsClient {
  const doFetch = deps.fetchImpl ?? fetch;
  /** Origin every paged request must stay on (see safeNextPage). Falls back to
   *  '' for a non-absolute base, which then refuses all paging rather than
   *  following an unvalidated URL. */
  const apiOrigin = (() => {
    try {
      return new URL(deps.webexApiBase).origin;
    } catch {
      return '';
    }
  })();
  const sleep =
    deps.sleep ??
    ((ms: number) => new Promise<void>((r) => { setTimeout(r, ms).unref(); }));
  const maxRetryAfterS = deps.maxRetryAfterS ?? 60;
  const inflightParticipants = new Map<string, Promise<WebexParticipant[]>>();

  async function webexJson(
    url: URL,
    scopeHint: string,
    init?: { method: 'POST'; body: unknown },
  ): Promise<{ status: number; body: unknown; nextUrl?: string }> {
    for (let attempt = 0; ; attempt++) {
      const token = await deps.getAccessToken();
      const res = await doFetch(url, {
        method: init?.method ?? 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          ...(init ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(init ? { body: JSON.stringify(init.body) } : {}),
      });
      if (res.status === 429 && attempt === 0) {
        // Safe for the POST too: 429 means Webex REJECTED the request before
        // processing — nothing was created, so one retry cannot double-create.
        const retryAfterS = Number(res.headers.get('retry-after') ?? '1') || 1;
        const waitMs = Math.min(retryAfterS, maxRetryAfterS) * 1000;
        console.error(`[meetingsClient] 429 from Webex — honoring Retry-After, waiting ${waitMs} ms (capped)`);
        await sleep(waitMs);
        continue; // one retry, then give up loudly below
      }
      if (res.status === 403) {
        throw new WebexScopeError(
          `Webex returned 403 for ${url.pathname} — the service app is missing scope ` +
          `${scopeHint} (verify org-admin authorization and exact scope names at deploy)`,
        );
      }
      if (!res.ok) throw new WebexApiError(res.status, `Webex API error ${res.status} for ${url.pathname}`);
      // A 2xx whose body is not JSON (proxy interstitial, HTML error page)
      // must fail LOUD through the taxonomy — never a raw SyntaxError.
      try {
        return {
          status: res.status,
          body: await res.json(),
          nextUrl: nextPageUrl(res.headers.get('link')),
        };
      } catch {
        throw new WebexApiError(res.status, `Webex API error: invalid response body (not JSON) for ${url.pathname}`);
      }
    }
  }

  /** Walk a Webex list endpoint to the end, following `Link: rel="next"`.
   *  Bounded by MAX_PAGES and origin-checked; every stop that could truncate the
   *  result is LOUD, because silent truncation is indistinguishable from "that
   *  is all there is" and both callers turn missing rows into a coverage lie. */
  async function listPaged<T>(
    first: URL,
    scopeHint: string,
    parse: (status: number, path: string, item: unknown) => T,
  ): Promise<T[]> {
    const out: T[] = [];
    let pageUrl: URL | undefined = first;
    let page = 0;
    while (pageUrl !== undefined) {
      const { status, body, nextUrl } = await webexJson(pageUrl, scopeHint);
      const path = pageUrl.pathname;
      const items = itemsOf(status, path, body);
      for (const item of items) out.push(parse(status, path, item));
      page += 1;
      if (nextUrl === undefined) {
        // A full page with no next link is how a mis-parsed Link header looks —
        // i.e. exactly the silent truncation this function exists to prevent.
        if (items.length >= PAGE_SIZE) {
          console.error(
            `[meetingsClient] LOUD: ${path} returned a full page (${items.length}) with no ` +
            'Link rel="next" — results may be truncated',
          );
        }
        break;
      }
      // Bounded: a server (or proxy) echoing a next link forever must not spin
      // this loop. Stop loudly and keep what we have — partial data beats a hang.
      if (page >= MAX_PAGES) {
        console.error(
          `[meetingsClient] LOUD: stopped paging ${path} after ${MAX_PAGES} pages — ` +
          'results may be incomplete (unexpected Link: rel="next" chain)',
        );
        break;
      }
      pageUrl = safeNextPage(nextUrl, apiOrigin);
    }
    return out;
  }

  return {
    async listUpcomingMeetings(window): Promise<WebexMeeting[]> {
      const url = new URL(`${deps.webexApiBase}/meetings`);
      url.searchParams.set('hostEmail', deps.hostEmail);
      url.searchParams.set('from', new Date(window.from).toISOString());
      url.searchParams.set('to', new Date(window.to).toISOString());
      // Webex defaults to 10 items/page. Reading only the first page silently
      // drops meetings 11+ from the sync — they are never registered, dialed, or
      // marked failed, i.e. an unmonitored meeting with no surfaced signal. Ask
      // for a big page AND follow `Link: rel="next"` to the end.
      url.searchParams.set('max', String(PAGE_SIZE));
      return listPaged(url, 'meeting:admin_schedules_read', parseMeeting);
    },

    listParticipants(webexMeetingId): Promise<WebexParticipant[]> {
      // Throttle rule: ≤1 in-flight participants call per meeting.
      const existing = inflightParticipants.get(webexMeetingId);
      if (existing) return existing;
      const url = new URL(`${deps.webexApiBase}/meetingParticipants`);
      url.searchParams.set('meetingId', webexMeetingId);
      url.searchParams.set('hostEmail', deps.hostEmail);
      // Same 10/page default as /meetings, and here truncation FABRICATES a
      // compliance record: rosterMonitor stamps leftAt on anyone missing from a
      // poll, so on an 11+ person call the participants pushed off page 1 are
      // recorded as having LEFT while they are still on the meeting.
      url.searchParams.set('max', String(PAGE_SIZE));
      const flight = listPaged(url, 'meeting:admin_participants_read', parseParticipant)
        .finally(() => { inflightParticipants.delete(webexMeetingId); });
      inflightParticipants.set(webexMeetingId, flight);
      return flight;
    },

    async createMeeting(opts): Promise<CreatedMeeting> {
      const url = new URL(`${deps.webexApiBase}/meetings`);
      const { status, body } = await webexJson(url, 'meeting:admin_schedule_write', {
        method: 'POST',
        body: {
          title: opts.title,
          start: new Date(opts.start).toISOString(),
          end: new Date(opts.end).toISOString(),
          // Service apps act as a machine account: hostEmail names the
          // scheduler account the meeting is created for.
          hostEmail: deps.hostEmail,
          // The bot-dialability contract (spec): no lobby, join-before-host,
          // audio before host — a lobby'd/host-gated meeting strands the bot.
          unlockedMeetingJoinSecurity: 'allowJoin',
          enabledJoinBeforeHost: true,
          joinBeforeHostMinutes: 15,
          enableConnectAudioBeforeHost: true,
          invitees: opts.invitees.map((email) => ({ email })),
          sendEmail: true, // Webex emails the calendar invites
        },
      });
      return parseCreatedMeeting(status, url.pathname, body);
    },
  };
}
