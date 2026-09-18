import { test, expect } from 'vitest';
import request from 'supertest';
import express from 'express';
import { openDb } from '../db/index.js';
import { insertMeeting } from '../db/meetings.js';
import { upsertPresence } from '../db/presence.js';
import { meetingsRouter } from './routes.js';
import type { RosterAttendee } from '../domain/types.js';

const dana: RosterAttendee = { id: 'p-fo', name: 'Dana Host', role: 'fo', isHost: true, joinedAt: 900, leftAt: null };
const alex: RosterAttendee = { id: 'p-an', name: 'Alex Analyst', role: 'analyst', isHost: false, joinedAt: 1_000, leftAt: 5_000 };

function makeApp(liveRoster: RosterAttendee[]) {
  const db = openDb(':memory:');
  const app = express();
  app.use(express.json());
  app.use(
    meetingsRouter({
      db,
      requireRole: () => (_req, _res, next) => next(),
      webex: { getRoster: () => liveRoster },
    }),
  );
  return { app, db };
}

test('GET /meetings/:id serves the live cache when non-empty (rosterSource: live)', async () => {
  const { app, db } = makeApp([dana]);
  const m = insertMeeting(db, { sipUri: 'a@site.webex.com', title: 'Live' });
  upsertPresence(db, m.meetingId, [dana, alex]); // stored rows exist too — live wins
  const res = await request(app).get(`/meetings/${m.meetingId}`);
  expect(res.status).toBe(200);
  expect(res.body.rosterSource).toBe('live');
  expect(res.body.roster).toHaveLength(1);
  expect(res.body.roster[0].id).toBe('p-fo');
});

test('GET /meetings/:id falls back to stored presence when the live cache is empty (rosterSource: stored)', async () => {
  const { app, db } = makeApp([]);
  const m = insertMeeting(db, { sipUri: 'b@site.webex.com', title: 'Ended' });
  upsertPresence(db, m.meetingId, [dana, alex]);
  const res = await request(app).get(`/meetings/${m.meetingId}`);
  expect(res.status).toBe(200);
  expect(res.body.rosterSource).toBe('stored');
  expect(res.body.roster.map((a: RosterAttendee) => a.id)).toEqual(['p-fo', 'p-an']); // joined_at order
  expect(res.body.roster[1].leftAt).toBe(5_000);
});

test('GET /meetings/:id with no live cache and no stored rows returns [] (rosterSource: stored)', async () => {
  const { app, db } = makeApp([]);
  const m = insertMeeting(db, { sipUri: 'c@site.webex.com', title: 'Never joined' });
  const res = await request(app).get(`/meetings/${m.meetingId}`);
  expect(res.status).toBe(200);
  expect(res.body.roster).toEqual([]);
  expect(res.body.rosterSource).toBe('stored');
});

// M3 / C1a seam: ?peek=1 must NOT starve stored-history fallback.
// Before the C1a fix the guard was `roster.length === 0 && req.query.peek !== '1'`,
// which skipped stored whenever the client sent ?peek=1 — silently emptying the
// history panel for ended meetings. After the fix the guard is `roster.length === 0`
// (stored is the unconditional final fallback).
test('GET /meetings/:id with ?peek=1 and empty live cache falls back to stored presence (rosterSource: stored)', async () => {
  const { app, db } = makeApp([]); // live cache empty
  const m = insertMeeting(db, { sipUri: 'd@site.webex.com', title: 'Ended peek' });
  upsertPresence(db, m.meetingId, [dana, alex]); // stored rows present
  const res = await request(app).get(`/meetings/${m.meetingId}?peek=1`);
  expect(res.status).toBe(200);
  expect(res.body.rosterSource).toBe('stored');
  expect(res.body.roster.map((a: RosterAttendee) => a.id)).toEqual(['p-fo', 'p-an']);
});
