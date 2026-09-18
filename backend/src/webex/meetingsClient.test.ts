import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  createMeetingsClient,
  WebexApiError,
  WebexScopeError,
  type WebexParticipant,
} from './meetingsClient.js';

function jsonRes(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

const RAW_MEETING = {
  id: 'wx-100',
  title: 'Q3 Earnings Preview',
  start: '2026-07-03T14:00:00.000Z',
  end: '2026-07-03T15:00:00.000Z',
  sipAddress: '777@site.webex.example',
  password: '4321',
};

/** Scripted-fetch harness. Each script entry is a factory (Response bodies
 *  are single-use). The last entry repeats. */
function harness(script: Array<() => Response>) {
  const urls: string[] = [];
  const inits: Array<RequestInit | undefined> = [];
  const sleeps: number[] = [];
  let i = 0;
  const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    urls.push(String(url));
    inits.push(init);
    const make = script[Math.min(i, script.length - 1)];
    i += 1;
    return make();
  }) as unknown as typeof fetch;
  const client = createMeetingsClient({
    getAccessToken: async () => 'at-1',
    webexApiBase: 'https://fake.example/v1',
    hostEmail: 'scheduler@bank.example',
    fetchImpl,
    sleep: async (ms) => { sleeps.push(ms); },
    maxRetryAfterS: 60,
  });
  return { client, urls, inits, sleeps, fetchImpl };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('listUpcomingMeetings', () => {
  it('calls GET {base}/meetings with hostEmail + ISO from/to and maps items', async () => {
    const h = harness([() => jsonRes(200, { items: [RAW_MEETING] })]);
    const from = Date.parse('2026-07-03T12:00:00.000Z');
    const to = Date.parse('2026-07-04T12:00:00.000Z');
    const items = await h.client.listUpcomingMeetings({ from, to });

    const u = new URL(h.urls[0]);
    expect(`${u.origin}${u.pathname}`).toBe('https://fake.example/v1/meetings');
    expect(u.searchParams.get('hostEmail')).toBe('scheduler@bank.example');
    expect(u.searchParams.get('from')).toBe('2026-07-03T12:00:00.000Z');
    expect(u.searchParams.get('to')).toBe('2026-07-04T12:00:00.000Z');

    expect(items).toEqual([{
      id: 'wx-100',
      title: 'Q3 Earnings Preview',
      start: Date.parse('2026-07-03T14:00:00.000Z'),
      end: Date.parse('2026-07-03T15:00:00.000Z'),
      sipAddress: '777@site.webex.example',
      password: '4321',
    }]);
  });

  // Webex pages this endpoint (default 10/page). Reading only page 1 silently drops
  // meetings 11+ from every sync: never registered, never dialed, never marked
  // failed — an unmonitored chaperoned call with NO surfaced signal.
  it('requests a large page size and follows Link rel="next" until exhausted', async () => {
    const m = (id: string) => ({ ...RAW_MEETING, id });
    const h = harness([
      () => jsonRes(200, { items: [m('wx-1')] }, {
        Link: '<https://fake.example/v1/meetings?offset=1>; rel="next"',
      }),
      () => jsonRes(200, { items: [m('wx-2')] }, {
        // A trailing rel="prev" must not be mistaken for the next link.
        Link: '<https://fake.example/v1/meetings?offset=2>; rel="next", <https://x>; rel="prev"',
      }),
      () => jsonRes(200, { items: [m('wx-3')] }), // no Link → last page
    ]);

    const items = await h.client.listUpcomingMeetings({ from: 0, to: 1 });

    expect(items.map((i) => i.id)).toEqual(['wx-1', 'wx-2', 'wx-3']);
    expect(h.urls).toHaveLength(3);
    expect(new URL(h.urls[0]).searchParams.get('max')).toBe('100');
    expect(h.urls[1]).toBe('https://fake.example/v1/meetings?offset=1');
    expect(h.urls[2]).toBe('https://fake.example/v1/meetings?offset=2');
  });

  // Every paged request carries the service app's ADMIN bearer token, so a next
  // link pointing off-origin (compromised/misbehaving proxy) would exfiltrate it.
  it('refuses to follow a Link rel="next" that points off-origin, and says so LOUDLY', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = harness([
      () => jsonRes(200, { items: [RAW_MEETING] }, { Link: '<https://evil.example/steal>; rel="next"' }),
      () => jsonRes(200, { items: [] }),
    ]);

    const items = await h.client.listUpcomingMeetings({ from: 0, to: 1 });

    expect(items).toHaveLength(1);      // page 1 kept
    expect(h.urls).toHaveLength(1);     // evil.example NEVER fetched
    expect(h.urls[0]).not.toContain('evil.example');
    expect(errSpy.mock.calls.map((c) => String(c[0])).some((l) => /off-origin/i.test(l))).toBe(true);
    errSpy.mockRestore();
  });

  it('stops LOUDLY instead of looping forever when Link rel="next" never terminates', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Every page points at a NEW next link, so only a page cap can end this.
    let n = 0;
    const h = harness([() => {
      n += 1;
      return jsonRes(200, { items: [{ ...RAW_MEETING, id: `wx-${n}` }] }, {
        Link: `<https://fake.example/v1/meetings?offset=${n}>; rel="next"`,
      });
    }]);

    const items = await h.client.listUpcomingMeetings({ from: 0, to: 1 });

    expect(h.urls.length).toBe(20);           // exactly the cap — fails loudly, never hangs
    expect(items.length).toBe(h.urls.length); // everything fetched is still returned
    expect(errSpy.mock.calls.map((c) => String(c[0])).some((l) => /page/i.test(l))).toBe(true);
    errSpy.mockRestore();
  });

  it('403 → WebexScopeError naming meeting:admin_schedules_read (loud, named)', async () => {
    const h = harness([() => jsonRes(403, { message: 'forbidden' })]);
    const err = await h.client.listUpcomingMeetings({ from: 0, to: 1 }).catch((e) => e);
    expect(err).toBeInstanceOf(WebexScopeError);
    expect(err).toBeInstanceOf(WebexApiError);
    expect((err as WebexApiError).status).toBe(403);
    expect((err as Error).message).toContain('meeting:admin_schedules_read');
  });

  it('429 with no Retry-After header defaults to a 1 s wait, then retries and succeeds', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = harness([
      () => jsonRes(429, {}), // header absent → `?? '1'` default
      () => jsonRes(200, { items: [] }),
    ]);
    await expect(h.client.listUpcomingMeetings({ from: 0, to: 1 })).resolves.toEqual([]);
    expect(h.sleeps).toEqual([1_000]);
    expect(h.fetchImpl).toHaveBeenCalledTimes(2);
    expect(errSpy).toHaveBeenCalledOnce();
  });

  it('429: honors Retry-After then retries once and succeeds', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = harness([
      () => jsonRes(429, {}, { 'Retry-After': '7' }),
      () => jsonRes(200, { items: [] }),
    ]);
    await expect(h.client.listUpcomingMeetings({ from: 0, to: 1 })).resolves.toEqual([]);
    expect(h.sleeps).toEqual([7_000]);
    expect(h.fetchImpl).toHaveBeenCalledTimes(2);
    expect(errSpy).toHaveBeenCalledOnce(); // the 429 notice is intentional and LOUD
  });

  it('429: Retry-After is capped at maxRetryAfterS', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = harness([
      () => jsonRes(429, {}, { 'Retry-After': '600' }),
      () => jsonRes(200, { items: [] }),
    ]);
    await h.client.listUpcomingMeetings({ from: 0, to: 1 });
    expect(h.sleeps).toEqual([60_000]);
    expect(errSpy).toHaveBeenCalledOnce();
  });

  it('a second consecutive 429 throws WebexApiError(429) — capped, not infinite', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = harness([() => jsonRes(429, {}, { 'Retry-After': '1' })]);
    const err = await h.client.listUpcomingMeetings({ from: 0, to: 1 }).catch((e) => e);
    expect(err).toBeInstanceOf(WebexApiError);
    expect((err as WebexApiError).status).toBe(429);
    expect(h.sleeps).toEqual([1_000]); // slept once, then gave up loudly
    expect(errSpy).toHaveBeenCalledOnce();
  });
});

describe('listParticipants', () => {
  it('calls GET {base}/meetingParticipants with meetingId + hostEmail and maps items', async () => {
    const h = harness([
      () => jsonRes(200, {
        items: [
          { id: 'p1', displayName: 'Dana Host', email: 'dana@bank.example', host: true, state: 'joined' },
          { id: 'p2', displayName: 'Guest', state: 'lobby' },
        ],
      }),
    ]);
    const items = await h.client.listParticipants('wx-100');
    const u = new URL(h.urls[0]);
    expect(`${u.origin}${u.pathname}`).toBe('https://fake.example/v1/meetingParticipants');
    expect(u.searchParams.get('meetingId')).toBe('wx-100');
    expect(u.searchParams.get('hostEmail')).toBe('scheduler@bank.example');
    expect(items).toEqual<WebexParticipant[]>([
      { id: 'p1', displayName: 'Dana Host', email: 'dana@bank.example', host: true, state: 'joined', pstn: false },
      { id: 'p2', displayName: 'Guest', email: undefined, host: false, state: 'lobby', pstn: false },
    ]);
  });

  // Truncation here FABRICATES a compliance record: rosterMonitor stamps leftAt
  // on anyone missing from a poll, so participants pushed off page 1 of an 11+
  // person call would be recorded as having left while still on the meeting.
  it('pages the participant list so a large meeting is never truncated', async () => {
    const p = (id: string) => ({ id, displayName: id, state: 'joined' });
    const h = harness([
      () => jsonRes(200, { items: [p('p1'), p('p2')] }, {
        Link: '<https://fake.example/v1/meetingParticipants?offset=2>; rel="next"',
      }),
      () => jsonRes(200, { items: [p('p3')] }),
    ]);

    const items = await h.client.listParticipants('wx-100');

    expect(items.map((i) => i.id)).toEqual(['p1', 'p2', 'p3']);
    expect(new URL(h.urls[0]).searchParams.get('max')).toBe('100');
    expect(h.urls).toHaveLength(2);
  });

  it('403 → WebexScopeError naming meeting:admin_participants_read', async () => {
    const h = harness([() => jsonRes(403, {})]);
    const err = await h.client.listParticipants('wx-100').catch((e) => e);
    expect(err).toBeInstanceOf(WebexScopeError);
    expect((err as Error).message).toContain('meeting:admin_participants_read');
  });

  it('≤1 in-flight participants call per meeting — concurrent callers share one fetch', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const fetchImpl = vi.fn(async () => {
      await gate;
      return jsonRes(200, { items: [] });
    }) as unknown as typeof fetch;
    const client = createMeetingsClient({
      getAccessToken: async () => 'at-1',
      webexApiBase: 'https://fake.example/v1',
      hostEmail: 'scheduler@bank.example',
      fetchImpl,
      sleep: async () => {},
    });
    const a = client.listParticipants('wx-100');
    const b = client.listParticipants('wx-100');
    const other = client.listParticipants('wx-200'); // different meeting → own flight
    release();
    await Promise.all([a, b, other]);
    expect(fetchImpl).toHaveBeenCalledTimes(2); // wx-100 shared + wx-200

    // After settling, the flight is cleared — a new call fetches again.
    await client.listParticipants('wx-100');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('a REJECTED flight clears the in-flight slot — same meeting refetches, no cached rejection', async () => {
    const h = harness([
      () => jsonRes(200, { items: [{ displayName: 'Ghost' }] }), // missing id → rejects
      () => jsonRes(200, { items: [] }),
    ]);
    const err = await h.client.listParticipants('wx-100').catch((e) => e);
    expect(err).toBeInstanceOf(WebexApiError);
    // Second call for the SAME meeting must trigger a fresh fetch, not replay the rejection.
    await expect(h.client.listParticipants('wx-100')).resolves.toEqual([]);
    expect(h.fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe('participant host/state — types validated if present, lenient when missing', () => {
  it.each([
    ['string "true"', 'true'],
    ['number 1', 1],
  ])('host present but not boolean (%s) → WebexApiError, never a silent false', async (_desc, host) => {
    const h = harness([() => jsonRes(200, { items: [{ id: 'p1', host, state: 'joined' }] })]);
    const err = await h.client.listParticipants('wx-100').catch((e) => e);
    expect(err).toBeInstanceOf(WebexApiError);
    expect((err as Error).message).toContain('invalid host');
  });

  it.each([
    ['number 1', 1],
    ['boolean true', true],
  ])('state present but not a string (%s) → WebexApiError, never a silent "end"', async (_desc, state) => {
    const h = harness([() => jsonRes(200, { items: [{ id: 'p1', state }] })]);
    const err = await h.client.listParticipants('wx-100').catch((e) => e);
    expect(err).toBeInstanceOf(WebexApiError);
    expect((err as Error).message).toContain('invalid state');
  });

  it('unknown STRING state (a new Webex value) still coerces to "end" — deliberate live-API leniency', async () => {
    const h = harness([() => jsonRes(200, { items: [{ id: 'p1', state: 'DISCONNECTED' }] })]);
    await expect(h.client.listParticipants('wx-100')).resolves.toEqual([
      { id: 'p1', displayName: '', email: undefined, host: false, state: 'end', pstn: false },
    ]);
  });

  it('missing host/state stay lenient: default false / "end"', async () => {
    const h = harness([() => jsonRes(200, { items: [{ id: 'p1' }] })]);
    await expect(h.client.listParticipants('wx-100')).resolves.toEqual([
      { id: 'p1', displayName: '', email: undefined, host: false, state: 'end', pstn: false },
    ]);
  });
});

describe('malformed 2xx bodies fail LOUD through the error taxonomy', () => {
  function textRes(body: string): Response {
    return new Response(body, { status: 200, headers: { 'Content-Type': 'text/html' } });
  }

  it('meetings: 200 non-JSON body → WebexApiError, never a raw SyntaxError', async () => {
    const h = harness([() => textRes('<html>proxy interstitial</html>')]);
    const err = await h.client.listUpcomingMeetings({ from: 0, to: 1 }).catch((e) => e);
    expect(err).toBeInstanceOf(WebexApiError);
    expect(err).not.toBeInstanceOf(SyntaxError);
    expect((err as WebexApiError).status).toBe(200);
    expect((err as Error).message).toContain('invalid response body');
  });

  it('meetings: items not an array → WebexApiError', async () => {
    const h = harness([() => jsonRes(200, { items: 'nope' })]);
    const err = await h.client.listUpcomingMeetings({ from: 0, to: 1 }).catch((e) => e);
    expect(err).toBeInstanceOf(WebexApiError);
    expect((err as Error).message).toContain('malformed response body');
  });

  it('meetings: item with unparseable start → WebexApiError, never a NaN start', async () => {
    const h = harness([() => jsonRes(200, { items: [{ ...RAW_MEETING, start: 'not-a-date' }] })]);
    const err = await h.client.listUpcomingMeetings({ from: 0, to: 1 }).catch((e) => e);
    expect(err).toBeInstanceOf(WebexApiError);
    expect((err as Error).message).toContain('start');
  });

  it('meetings: item missing id/title → WebexApiError(200)', async () => {
    const h = harness([() => jsonRes(200, { items: [{ start: '2026-07-03T14:00:00.000Z' }] })]);
    const err = await h.client.listUpcomingMeetings({ from: 0, to: 1 }).catch((e) => e);
    expect(err).toBeInstanceOf(WebexApiError);
    expect((err as WebexApiError).status).toBe(200);
  });

  it('participants: 200 non-JSON body → WebexApiError, never a raw SyntaxError', async () => {
    const h = harness([() => textRes('oops')]);
    const err = await h.client.listParticipants('wx-100').catch((e) => e);
    expect(err).toBeInstanceOf(WebexApiError);
    expect(err).not.toBeInstanceOf(SyntaxError);
    expect((err as Error).message).toContain('invalid response body');
  });

  it('participants: item missing id → WebexApiError', async () => {
    const h = harness([() => jsonRes(200, { items: [{ displayName: 'Ghost' }] })]);
    const err = await h.client.listParticipants('wx-100').catch((e) => e);
    expect(err).toBeInstanceOf(WebexApiError);
    expect((err as Error).message).toContain('participant');
  });
});

describe('parseParticipant — PSTN enrichment (additive, lenient)', () => {
  // All tests via listParticipants (exercising parseParticipant end-to-end)

  it('callIn device with phoneNumber → pstn=true, phone set', async () => {
    const h = harness([
      () => jsonRes(200, {
        items: [{
          id: 'p1', displayName: 'Dana Host', host: false, state: 'joined',
          devices: [{ callType: 'callIn', phoneNumber: '8452338546' }],
        }],
      }),
    ]);
    const [p] = await h.client.listParticipants('wx-1');
    expect(p!.pstn).toBe(true);
    expect(p!.phone).toBe('8452338546');
  });

  it('person.phoneNumber picked up when no devices entry', async () => {
    const h = harness([
      () => jsonRes(200, {
        items: [{
          id: 'p1', displayName: 'Alex', host: false, state: 'joined',
          person: { phoneNumber: '9175550100' },
        }],
      }),
    ]);
    const [p] = await h.client.listParticipants('wx-1');
    expect(p!.pstn).toBe(true);
    expect(p!.phone).toBe('9175550100');
  });

  it('masked displayName alone → pstn=true, phone=undefined', async () => {
    const h = harness([
      () => jsonRes(200, {
        items: [{ id: 'p1', displayName: '8452****46', host: false, state: 'joined' }],
      }),
    ]);
    const [p] = await h.client.listParticipants('wx-1');
    expect(p!.pstn).toBe(true);
    expect(p!.phone).toBeUndefined();
  });

  it('malformed devices (non-array, junk entries) → lenient, participant still parsed', async () => {
    const h = harness([
      () => jsonRes(200, {
        items: [
          {
            id: 'p1', displayName: 'Corrupted', host: false, state: 'joined',
            devices: 'not-an-array',
          },
          {
            id: 'p2', displayName: 'Junk entry', host: false, state: 'joined',
            devices: [null, { callType: 'callIn', phoneNumber: '5550001111' }, undefined],
          },
        ],
      }),
    ]);
    const items = await h.client.listParticipants('wx-1');
    expect(items).toHaveLength(2);
    expect(items[0]!.id).toBe('p1');
    expect(items[0]!.pstn).toBe(false);  // non-array devices → no PSTN signals
    expect(items[1]!.phone).toBe('5550001111'); // good entry in a mixed-junk array
  });

  it('non-PSTN web participant → pstn=false, phone=undefined', async () => {
    const h = harness([
      () => jsonRes(200, {
        items: [{ id: 'p1', displayName: 'Web User', email: 'web@fund.example', host: false, state: 'joined' }],
      }),
    ]);
    const [p] = await h.client.listParticipants('wx-1');
    expect(p!.pstn).toBe(false);
    expect(p!.phone).toBeUndefined();
  });
});

describe('createMeeting (in-portal scheduling)', () => {
  const CREATE_RESPONSE = {
    id: 'wx-500',
    title: 'Console-scheduled sync',
    start: '2026-08-01T14:00:00.000Z',
    sipAddress: '555@site.webex.example',
    webLink: 'https://site.webex.example/meet/500',
  };
  const OPTS = {
    title: 'Console-scheduled sync',
    start: Date.parse('2026-08-01T14:00:00.000Z'),
    end: Date.parse('2026-08-01T14:30:00.000Z'),
    invitees: ['alex@fund.example', 'dana@bank.example'],
  };

  it('POSTs {base}/meetings with the no-lobby/join-before-host body and maps the response', async () => {
    const h = harness([() => jsonRes(200, CREATE_RESPONSE)]);
    const created = await h.client.createMeeting(OPTS);

    const u = new URL(h.urls[0]);
    expect(`${u.origin}${u.pathname}`).toBe('https://fake.example/v1/meetings');
    const init = h.inits[0]!;
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer at-1');
    // The EXACT body — the no-lobby / join-before-host flags are the reason
    // this feature exists (a lobby'd meeting strands the bot).
    expect(JSON.parse(String(init.body))).toEqual({
      title: 'Console-scheduled sync',
      start: '2026-08-01T14:00:00.000Z',
      end: '2026-08-01T14:30:00.000Z',
      hostEmail: 'scheduler@bank.example',
      unlockedMeetingJoinSecurity: 'allowJoin',
      enabledJoinBeforeHost: true,
      joinBeforeHostMinutes: 15,
      enableConnectAudioBeforeHost: true,
      invitees: [{ email: 'alex@fund.example' }, { email: 'dana@bank.example' }],
      sendEmail: true,
    });

    expect(created).toEqual({
      webexMeetingId: 'wx-500',
      title: 'Console-scheduled sync',
      start: Date.parse('2026-08-01T14:00:00.000Z'),
      sipAddress: '555@site.webex.example',
      joinUrl: 'https://site.webex.example/meet/500',
    });
  });

  it('403 → WebexScopeError naming meeting:admin_schedule_write (loud, named)', async () => {
    const h = harness([() => jsonRes(403, { message: 'forbidden' })]);
    const err = await h.client.createMeeting(OPTS).catch((e) => e);
    expect(err).toBeInstanceOf(WebexScopeError);
    expect((err as WebexApiError).status).toBe(403);
    expect((err as Error).message).toContain('meeting:admin_schedule_write');
  });

  it('response missing sipAddress → LOUD WebexApiError naming sipAddress, never a half-result', async () => {
    const { sipAddress: _omit, ...noSip } = CREATE_RESPONSE;
    const h = harness([() => jsonRes(200, noSip)]);
    const err = await h.client.createMeeting(OPTS).catch((e) => e);
    expect(err).toBeInstanceOf(WebexApiError);
    expect(err).not.toBeInstanceOf(WebexScopeError);
    expect((err as Error).message).toContain('no sipAddress');
    expect((err as Error).message).toContain('wx-500'); // diagnosable in one read
  });

  it('response missing webLink → WebexApiError (malformed)', async () => {
    const { webLink: _omit, ...noLink } = CREATE_RESPONSE;
    const h = harness([() => jsonRes(200, noLink)]);
    const err = await h.client.createMeeting(OPTS).catch((e) => e);
    expect(err).toBeInstanceOf(WebexApiError);
    expect((err as Error).message).toContain('malformed response body');
  });

  it('response missing id/title/start → WebexApiError(200)', async () => {
    const h = harness([() => jsonRes(200, { sipAddress: 'x@y', webLink: 'https://z' })]);
    const err = await h.client.createMeeting(OPTS).catch((e) => e);
    expect(err).toBeInstanceOf(WebexApiError);
    expect((err as WebexApiError).status).toBe(200);
  });

  it('200 non-JSON body → WebexApiError, never a raw SyntaxError', async () => {
    const h = harness([() => new Response('<html>proxy</html>', {
      status: 200, headers: { 'Content-Type': 'text/html' },
    })]);
    const err = await h.client.createMeeting(OPTS).catch((e) => e);
    expect(err).toBeInstanceOf(WebexApiError);
    expect(err).not.toBeInstanceOf(SyntaxError);
    expect((err as Error).message).toContain('invalid response body');
  });

  it('429 honors Retry-After once then succeeds (429 = rejected before processing — POST-safe)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = harness([
      () => jsonRes(429, {}, { 'Retry-After': '3' }),
      () => jsonRes(200, CREATE_RESPONSE),
    ]);
    await expect(h.client.createMeeting(OPTS)).resolves.toMatchObject({ webexMeetingId: 'wx-500' });
    expect(h.sleeps).toEqual([3_000]);
    expect(h.fetchImpl).toHaveBeenCalledTimes(2);
    expect(errSpy).toHaveBeenCalledOnce();
  });
});
