import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { openDb, type DB } from '../src/db/index.js';
import { getMeeting as getMeetingRow } from '../src/db/meetings.js';
import { upsertBotStatus } from '../src/db/botStatus.js';
import { makeRequireRole } from '../src/auth/middleware.js';
import { signAppSession } from '../src/auth/appToken.js';
import { meetingsRouter } from '../src/meetings/routes.js';
import type { RosterAttendee } from '../src/domain/types.js';

const SECRET = 'test-secret';
let db: DB;
function app(webex?: Parameters<typeof meetingsRouter>[0]['webex']) {
  const a = express();
  a.use(express.json());
  a.use(meetingsRouter({ db, requireRole: makeRequireRole(SECRET), webex }));
  return a;
}
const adminTok = () => signAppSession({ email: 'a@x.com', role: 'admin' }, SECRET);
const officerTok = () => signAppSession({ email: 'o@x.com', role: 'officer' }, SECRET);

beforeEach(() => { db = openDb(); });

describe('POST /meetings', () => {
  it('admin creates a meeting (201)', async () => {
    const res = await request(app()).post('/meetings')
      .set('Authorization', `Bearer ${adminTok()}`)
      .send({ sipUri: '123@site.webex.com', title: 'Analyst call' });
    expect(res.status).toBe(201);
    expect(res.body.meetingId).toMatch(/[0-9a-f-]{36}/);
    expect(res.body.sipUri).toBe('123@site.webex.com');
    expect(typeof res.body.createdAt).toBe('number');
  });
  it('accepts dtmf but NEVER echoes it back (credential — persisted for the bot only)', async () => {
    const res = await request(app()).post('/meetings')
      .set('Authorization', `Bearer ${adminTok()}`)
      .send({ sipUri: '999@site.webex.com', title: 'DTMF call', dtmf: '5678#' });
    expect(res.status).toBe(201);
    expect(res.body).not.toHaveProperty('dtmf');
    // The DB row keeps it — BotManager needs dtmf to dial.
    expect(getMeetingRow(db, res.body.meetingId)?.dtmf).toBe('5678#');
  });
  it('officer is forbidden (403)', async () => {
    const res = await request(app()).post('/meetings')
      .set('Authorization', `Bearer ${officerTok()}`).send({ sipUri: '1@s.webex.com', title: 'X' });
    expect(res.status).toBe(403);
  });
  it('rejects a body missing sipUri/title (400)', async () => {
    const res = await request(app()).post('/meetings').set('Authorization', `Bearer ${adminTok()}`).send({ title: 'X' });
    expect(res.status).toBe(400);
  });
});

describe('GET /meetings', () => {
  it('officer sees meetings with idle bot status by default, connected once a row exists', async () => {
    const created = await request(app()).post('/meetings').set('Authorization', `Bearer ${adminTok()}`)
      .send({ sipUri: '1@s.webex.com', title: 'A' });
    const id = created.body.meetingId;
    let res = await request(app()).get('/meetings').set('Authorization', `Bearer ${officerTok()}`);
    expect(res.status).toBe(200);
    expect(res.body.meetings[0].bot.state).toBe('idle');
    upsertBotStatus(db, { meetingId: id, state: 'connected', joinedAt: 5, updatedAt: 6 });
    res = await request(app()).get('/meetings').set('Authorization', `Bearer ${officerTok()}`);
    expect(res.body.meetings[0].bot.state).toBe('connected');
  });
  it('includes a meeting whose bot is failed (fail-LOUD)', async () => {
    const { body } = await request(app()).post('/meetings')
      .set('Authorization', `Bearer ${adminTok()}`)
      .send({ sipUri: '2@s.webex.com', title: 'B' });
    upsertBotStatus(db, { meetingId: body.meetingId, state: 'failed', joinedAt: 10, updatedAt: 11 });
    const res = await request(app()).get('/meetings').set('Authorization', `Bearer ${officerTok()}`);
    const found = res.body.meetings.find((m: any) => m.meetingId === body.meetingId);
    expect(found.bot.state).toBe('failed');
  });
  it('admin can also call GET /meetings', async () => {
    const res = await request(app()).get('/meetings').set('Authorization', `Bearer ${adminTok()}`);
    expect(res.status).toBe(200);
  });
});

describe('GET /meetings/:id', () => {
  it('officer gets meeting + bot + roster; 404 for unknown', async () => {
    const created = await request(app()).post('/meetings').set('Authorization', `Bearer ${adminTok()}`)
      .send({ sipUri: '1@s.webex.com', title: 'A' });
    const id = created.body.meetingId;
    const ok = await request(app()).get(`/meetings/${id}`).set('Authorization', `Bearer ${officerTok()}`);
    expect(ok.status).toBe(200);
    expect(ok.body.meeting.meetingId).toBe(id);
    expect(ok.body.bot.state).toBe('idle');
    expect(ok.body.roster).toEqual([]);
    const miss = await request(app()).get('/meetings/nope').set('Authorization', `Bearer ${officerTok()}`);
    expect(miss.status).toBe(404);
  });
});

describe('DELETE /meetings/:id', () => {
  it('admin deletes (204); officer forbidden (403)', async () => {
    const created = await request(app()).post('/meetings').set('Authorization', `Bearer ${adminTok()}`)
      .send({ sipUri: '1@s.webex.com', title: 'A' });
    const id = created.body.meetingId;
    expect((await request(app()).delete(`/meetings/${id}`).set('Authorization', `Bearer ${officerTok()}`)).status).toBe(403);
    expect((await request(app()).delete(`/meetings/${id}`).set('Authorization', `Bearer ${adminTok()}`)).status).toBe(204);
    expect((await request(app()).get(`/meetings/${id}`).set('Authorization', `Bearer ${officerTok()}`)).status).toBe(404);
  });
});

describe('GET /meetings/upcoming', () => {
  const dto = {
    meetingId: 'wx-1',
    title: 'Pre-Market Huddle',
    scheduledStart: 1_700_000_600_000,
    scheduledEnd: 1_700_004_200_000,
    sipUri: '777@site.webex.example',
  };

  it('serves the injected upcoming cache to officers (console UpcomingMeeting shape)', async () => {
    const res = await request(app({ getUpcoming: () => [dto] }))
      .get('/meetings/upcoming').set('Authorization', `Bearer ${officerTok()}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ meetings: [dto] });
  });

  it("is NOT swallowed by the :meetingId route — default seams give 200 { meetings: [] }", async () => {
    const res = await request(app())
      .get('/meetings/upcoming').set('Authorization', `Bearer ${officerTok()}`);
    expect(res.status).toBe(200); // a route-order bug would 404 'meeting not found'
    expect(res.body).toEqual({ meetings: [] });
  });

  it('requires auth (401 without a token)', async () => {
    const res = await request(app()).get('/meetings/upcoming');
    expect(res.status).toBe(401);
  });
});

describe('GET /meetings — webex_integration field', () => {
  it("defaults to 'failed' when no integration is wired (honest: no Webex data)", async () => {
    const res = await request(app()).get('/meetings').set('Authorization', `Bearer ${officerTok()}`);
    expect(res.status).toBe(200);
    expect(res.body.webex_integration).toBe('failed');
  });

  it('reflects the injected status', async () => {
    const res = await request(app({ integrationStatus: () => 'degraded' }))
      .get('/meetings').set('Authorization', `Bearer ${officerTok()}`);
    expect(res.body.webex_integration).toBe('degraded');
  });
});

describe('GET /meetings/:id — live roster from the injected cache', () => {
  it('serves RosterAttendee entries from getRoster', async () => {
    const attendee = {
      id: 'p-fo', name: 'Dana Host', role: 'fo' as const,
      isHost: true, joinedAt: 5, leftAt: null,
    };
    const a = app({ getRoster: (meetingId) => (meetingId ? [attendee] : []) });
    const created = await request(a).post('/meetings').set('Authorization', `Bearer ${adminTok()}`)
      .send({ sipUri: '1@s.webex.com', title: 'A' });
    const res = await request(a).get(`/meetings/${created.body.meetingId}`)
      .set('Authorization', `Bearer ${officerTok()}`);
    expect(res.status).toBe(200);
    expect(res.body.roster).toEqual([attendee]);
  });
});

describe('dtmf redaction — the credential never appears in any response body', () => {
  it('GET /meetings list rows omit dtmf', async () => {
    await request(app()).post('/meetings').set('Authorization', `Bearer ${adminTok()}`)
      .send({ sipUri: '999@site.webex.com', title: 'DTMF call', dtmf: '5678#' });
    const res = await request(app()).get('/meetings').set('Authorization', `Bearer ${officerTok()}`);
    expect(res.status).toBe(200);
    expect(res.body.meetings).toHaveLength(1);
    expect(res.body.meetings[0]).not.toHaveProperty('dtmf');
  });

  it('GET /meetings/:id detail omits dtmf', async () => {
    const created = await request(app()).post('/meetings').set('Authorization', `Bearer ${adminTok()}`)
      .send({ sipUri: '999@site.webex.com', title: 'DTMF call', dtmf: '5678#' });
    const res = await request(app()).get(`/meetings/${created.body.meetingId}`)
      .set('Authorization', `Bearer ${officerTok()}`);
    expect(res.status).toBe(200);
    expect(res.body.meeting).not.toHaveProperty('dtmf');
  });
});

describe("POST /meetings — manual registrations are stamped source 'manual'", () => {
  it('returns source manual on the created meeting', async () => {
    const res = await request(app()).post('/meetings').set('Authorization', `Bearer ${adminTok()}`)
      .send({ sipUri: '1@s.webex.com', title: 'A' });
    expect(res.status).toBe(201);
    expect(res.body.source).toBe('manual');
  });
});

describe('POST /meetings/schedule (in-portal scheduling)', () => {
  const FUTURE = () => Date.now() + 3_600_000;
  const CREATED = {
    webexMeetingId: 'wx-900',
    title: 'Scheduled from console',
    start: 1_800_000_000_000,
    sipAddress: '900@site.webex.example',
    joinUrl: 'https://site.webex.example/meet/900',
  };
  const valid = (start: number) => ({
    title: 'Scheduled from console',
    start,
    durationMinutes: 45,
    invitees: ['alex@fund.example'],
  });

  it('admin schedules → 201 with the exact CreatedMeeting shape; seam gets end = start + duration', async () => {
    const seam = vi.fn().mockResolvedValue(CREATED);
    const start = FUTURE();
    const res = await request(app({ scheduleMeeting: seam }))
      .post('/meetings/schedule')
      .set('Authorization', `Bearer ${adminTok()}`)
      .send(valid(start));
    expect(res.status).toBe(201);
    expect(res.body).toEqual(CREATED);
    // Credential hygiene: EXACTLY these five fields — no dtmf, no password.
    expect(Object.keys(res.body).sort()).toEqual(
      ['joinUrl', 'sipAddress', 'start', 'title', 'webexMeetingId'],
    );
    expect(seam).toHaveBeenCalledWith({
      title: 'Scheduled from console',
      start,
      end: start + 45 * 60_000,
      invitees: ['alex@fund.example'],
    });
  });

  it('officer → 403 and the seam is never called', async () => {
    const seam = vi.fn();
    const res = await request(app({ scheduleMeeting: seam }))
      .post('/meetings/schedule')
      .set('Authorization', `Bearer ${officerTok()}`)
      .send(valid(FUTURE()));
    expect(res.status).toBe(403);
    expect(seam).not.toHaveBeenCalled();
  });

  it('401 without a token', async () => {
    const res = await request(app({ scheduleMeeting: vi.fn() }))
      .post('/meetings/schedule').send(valid(FUTURE()));
    expect(res.status).toBe(401);
  });

  it.each([
    ['whitespace title', { title: '   ' }, 'title'],
    ['missing start', { start: undefined }, 'start'],
    ['non-numeric start', { start: 'tomorrow' }, 'start'],
    ['past start', { start: 1 }, 'future'],
    ['zero duration', { durationMinutes: 0 }, 'durationMinutes'],
    ['duration over 480', { durationMinutes: 481 }, 'durationMinutes'],
    ['fractional duration', { durationMinutes: 1.5 }, 'durationMinutes'],
    ['non-email invitee', { invitees: ['not-an-email'] }, 'invitees'],
    ['non-array invitees', { invitees: 'a@b.example' }, 'invitees'],
  ])('%s → 400 with a field-naming message; seam not called', async (_desc, patch, needle) => {
    const seam = vi.fn();
    const res = await request(app({ scheduleMeeting: seam }))
      .post('/meetings/schedule')
      .set('Authorization', `Bearer ${adminTok()}`)
      .send({ ...valid(FUTURE()), ...patch });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain(needle);
    expect(seam).not.toHaveBeenCalled();
  });

  it('invitees are optional — omitted becomes []', async () => {
    const seam = vi.fn().mockResolvedValue(CREATED);
    const start = FUTURE();
    const res = await request(app({ scheduleMeeting: seam }))
      .post('/meetings/schedule')
      .set('Authorization', `Bearer ${adminTok()}`)
      .send({ title: 'No invites', start, durationMinutes: 30 });
    expect(res.status).toBe(201);
    expect(seam).toHaveBeenCalledWith(expect.objectContaining({ invitees: [] }));
  });

  it('seam rejection carrying status 403 → 403 with the scope-named message (WebexScopeError shape)', async () => {
    // Repo convention: the expected LOUD line is silenced AND asserted.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const seam = vi.fn().mockRejectedValue(Object.assign(
      new Error(
        'Webex returned 403 for /v1/meetings — the service app is missing scope ' +
        'meeting:admin_schedules_write (verify org-admin authorization and exact scope names at deploy)',
      ),
      { status: 403 },
    ));
    const res = await request(app({ scheduleMeeting: seam }))
      .post('/meetings/schedule')
      .set('Authorization', `Bearer ${adminTok()}`)
      .send(valid(FUTURE()));
    expect(res.status).toBe(403);
    expect(res.body.error).toContain('meeting:admin_schedules_write');
    expect(errSpy).toHaveBeenCalledOnce();
    errSpy.mockRestore();
  });

  it('non-scope seam failure → 502 with the message (e.g. created-but-no-sipAddress fail-LOUD)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const seam = vi.fn().mockRejectedValue(
      new Error('Webex created meeting wx-9 with no sipAddress — the bot cannot dial it'),
    );
    const res = await request(app({ scheduleMeeting: seam }))
      .post('/meetings/schedule')
      .set('Authorization', `Bearer ${adminTok()}`)
      .send(valid(FUTURE()));
    expect(res.status).toBe(502);
    expect(res.body.error).toContain('no sipAddress');
    expect(errSpy).toHaveBeenCalledOnce();
    errSpy.mockRestore();
  });

  it('no seam wired (integration disabled) → 503, honest and loud', async () => {
    const res = await request(app())
      .post('/meetings/schedule')
      .set('Authorization', `Bearer ${adminTok()}`)
      .send(valid(FUTURE()));
    expect(res.status).toBe(503);
    expect(res.body.error).toContain('not configured');
  });
});

describe('GET /meetings/:id — roster peek (?peek=1)', () => {
  const PEEKED: RosterAttendee[] = [
    { id: 'p1', name: 'Ana Lyst', role: 'analyst', isHost: true, joinedAt: 111, leftAt: null },
  ];
  async function makeMeeting(a: ReturnType<typeof app>, body: Record<string, unknown>): Promise<string> {
    const res = await request(a).post('/meetings')
      .set('Authorization', `Bearer ${adminTok()}`).send(body);
    expect(res.status).toBe(201);
    return res.body.meetingId as string;
  }

  it('no ?peek → cache-empty meeting reports rosterSource stored (stored fallback), peek NOT called', async () => {
    const peekRoster = vi.fn(async () => PEEKED);
    const a = app({ peekRoster });
    const id = await makeMeeting(a, { sipUri: '1@s.webex.com', title: 'A', webexMeetingId: 'wx-1' });
    const res = await request(a).get(`/meetings/${id}`).set('Authorization', `Bearer ${officerTok()}`);
    expect(res.status).toBe(200);
    expect(res.body.roster).toEqual([]);
    expect(res.body.rosterSource).toBe('stored'); // stored fallback (no rows yet) — not 'none'
    expect(res.body).not.toHaveProperty('rosterError');
    expect(peekRoster).not.toHaveBeenCalled();
  });

  it('?peek=1 + webexMeetingId + seam → peek roster, rosterSource peek', async () => {
    const peekRoster = vi.fn(async (webexId: string) => {
      expect(webexId).toBe('wx-2');
      return PEEKED;
    });
    const a = app({ peekRoster });
    const id = await makeMeeting(a, { sipUri: '2@s.webex.com', title: 'B', webexMeetingId: 'wx-2' });
    const res = await request(a).get(`/meetings/${id}?peek=1`).set('Authorization', `Bearer ${officerTok()}`);
    expect(res.status).toBe(200);
    expect(res.body.roster).toEqual(PEEKED);
    expect(res.body.rosterSource).toBe('peek');
    expect(res.body).not.toHaveProperty('rosterError');
  });

  it('live cache wins: non-empty getRoster → rosterSource live, peek NOT called', async () => {
    const live: RosterAttendee[] = [
      { id: 'r1', name: 'Compliance Bot', role: 'bot', isHost: false, joinedAt: 5, leftAt: null },
    ];
    const peekRoster = vi.fn(async () => PEEKED);
    const a = app({ getRoster: () => live, peekRoster });
    const id = await makeMeeting(a, { sipUri: '3@s.webex.com', title: 'C', webexMeetingId: 'wx-3' });
    const res = await request(a).get(`/meetings/${id}?peek=1`).set('Authorization', `Bearer ${officerTok()}`);
    expect(res.body.roster).toEqual(live);
    expect(res.body.rosterSource).toBe('live');
    expect(peekRoster).not.toHaveBeenCalled();
  });

  it('?peek=1 without webexMeetingId → honest rosterError, peek NOT called', async () => {
    const peekRoster = vi.fn(async () => PEEKED);
    const a = app({ peekRoster });
    const id = await makeMeeting(a, { sipUri: '4@s.webex.com', title: 'D' }); // manual row, no webex id
    const res = await request(a).get(`/meetings/${id}?peek=1`).set('Authorization', `Bearer ${officerTok()}`);
    expect(res.status).toBe(200);
    expect(res.body.roster).toEqual([]);
    expect(res.body.rosterSource).toBe('none');
    expect(res.body.rosterError).toMatch(/no webexMeetingId/);
    expect(peekRoster).not.toHaveBeenCalled();
  });

  it('?peek=1 with no seam wired → honest rosterError (integration disabled)', async () => {
    const a = app(); // no webex seams at all
    const id = await makeMeeting(a, { sipUri: '5@s.webex.com', title: 'E', webexMeetingId: 'wx-5' });
    const res = await request(a).get(`/meetings/${id}?peek=1`).set('Authorization', `Bearer ${officerTok()}`);
    expect(res.status).toBe(200);
    expect(res.body.rosterSource).toBe('none');
    expect(res.body.rosterError).toMatch(/not configured/);
  });

  it('peek throws → 200, LOUD log, rosterError carries the message, detail intact', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const peekRoster = vi.fn(async () => {
      throw new Error('Webex API error 502 for /meetingParticipants');
    });
    const a = app({ peekRoster });
    const id = await makeMeeting(a, { sipUri: '6@s.webex.com', title: 'F', webexMeetingId: 'wx-6' });
    const res = await request(a).get(`/meetings/${id}?peek=1`).set('Authorization', `Bearer ${officerTok()}`);
    expect(res.status).toBe(200);
    expect(res.body.meeting.title).toBe('F');
    expect(res.body.roster).toEqual([]);
    expect(res.body.rosterSource).toBe('none');
    expect(res.body.rosterError).toMatch(/roster peek failed: Webex API error 502/);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('dtmf NEVER appears in the peek response', async () => {
    const peekRoster = vi.fn(async () => PEEKED);
    const a = app({ peekRoster });
    const id = await makeMeeting(a, { sipUri: '7@s.webex.com', title: 'G', webexMeetingId: 'wx-7', dtmf: '1234#' });
    const res = await request(a).get(`/meetings/${id}?peek=1`).set('Authorization', `Bearer ${officerTok()}`);
    expect(JSON.stringify(res.body)).not.toContain('1234#');
    expect(res.body.meeting).not.toHaveProperty('dtmf');
  });
});
