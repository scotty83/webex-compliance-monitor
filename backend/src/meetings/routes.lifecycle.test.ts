import { test, expect } from 'vitest';
import request from 'supertest';
import express from 'express';
import { openDb } from '../db/index.js';
import { meetingsRouter, type MeetingLifecycle } from './routes.js';
import type { ChaperonedMeeting } from '../domain/types.js';

function makeApp(lifecycle?: MeetingLifecycle) {
  const db = openDb(':memory:');
  const a = express();
  a.use(express.json());
  a.use(meetingsRouter({
    db,
    requireRole: () => (_req, _res, next) => next(),
    lifecycle,
  }));
  return a;
}

test('POST /meetings calls onRegister with the created meeting', async () => {
  const registered: ChaperonedMeeting[] = [];
  const lifecycle: MeetingLifecycle = {
    onRegister: (m) => { registered.push(m); },
    onDeregister: () => {},
  };

  const app = makeApp(lifecycle);
  const res = await request(app)
    .post('/meetings')
    .send({ sipUri: 'test@site.webex.com', title: 'Test Meeting' });

  expect(res.status).toBe(201);
  expect(registered).toHaveLength(1);
  expect(registered[0].sipUri).toBe('test@site.webex.com');
});

test('DELETE /meetings/:meetingId calls onDeregister with that id', async () => {
  const deregistered: string[] = [];
  const lifecycle: MeetingLifecycle = {
    onRegister: () => {},
    onDeregister: (id) => { deregistered.push(id); },
  };

  const app = makeApp(lifecycle);

  const createRes = await request(app)
    .post('/meetings')
    .send({ sipUri: 'del@site.webex.com', title: 'To Delete' });
  expect(createRes.status).toBe(201);
  const meetingId = createRes.body.meetingId as string;

  const deleteRes = await request(app).delete(`/meetings/${meetingId}`);
  expect(deleteRes.status).toBe(204);

  expect(deregistered).toHaveLength(1);
  expect(deregistered[0]).toBe(meetingId);
});

test('lifecycle is optional — existing callers without lifecycle keep working', async () => {
  const app = makeApp();
  const res = await request(app)
    .post('/meetings')
    .send({ sipUri: 'nohook@site.webex.com', title: 'No Hook' });
  expect(res.status).toBe(201);
});

test('onDeregister is NOT called when meeting does not exist (404)', async () => {
  const deregistered: string[] = [];
  const lifecycle: MeetingLifecycle = {
    onRegister: () => {},
    onDeregister: (id) => { deregistered.push(id); },
  };

  const app = makeApp(lifecycle);
  const res = await request(app).delete('/meetings/nonexistent-id');
  expect(res.status).toBe(404);
  expect(deregistered).toHaveLength(0);
});
