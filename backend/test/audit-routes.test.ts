import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { openDb, type DB } from '../src/db/index.js';
import { appendAudit } from '../src/db/audit.js';
import { makeRequireRole } from '../src/auth/middleware.js';
import { signAppSession } from '../src/auth/appToken.js';
import { auditRouter } from '../src/audit/routes.js';

const SECRET = 'test-secret';
let db: DB;
function app() {
  const a = express();
  a.use(auditRouter({ db, requireRole: makeRequireRole(SECRET) }));
  return a;
}
const adminTok = () => signAppSession({ email: 'a@x.com', role: 'admin' }, SECRET);
const officerTok = () => signAppSession({ email: 'o@x.com', role: 'officer' }, SECRET);

beforeEach(() => {
  db = openDb();
  appendAudit(db, { id: '1', action: 'listen_start', meetingId: 'm1', officerEmail: 'o@x.com', at: 100 });
  appendAudit(db, { id: '2', action: 'bot_join', meetingId: 'm2', at: 200 });
});

describe('GET /audit', () => {
  it('admin reads all entries, and can filter by meetingId', async () => {
    const all = await request(app()).get('/audit').set('Authorization', `Bearer ${adminTok()}`);
    expect(all.status).toBe(200);
    expect(all.body.entries).toHaveLength(2);
    const one = await request(app()).get('/audit?meetingId=m1').set('Authorization', `Bearer ${adminTok()}`);
    expect(one.body.entries.map((e: any) => e.id)).toEqual(['1']);
  });
  it('filters by from/to window', async () => {
    const res = await request(app()).get('/audit?from=150&to=250').set('Authorization', `Bearer ${adminTok()}`);
    expect(res.body.entries.map((e: any) => e.id)).toEqual(['2']);
  });
  it('officer is forbidden (403)', async () => {
    expect((await request(app()).get('/audit').set('Authorization', `Bearer ${officerTok()}`)).status).toBe(403);
  });
  it('non-numeric from/to are ignored (treated as absent)', async () => {
    const all = await request(app()).get('/audit').set('Authorization', `Bearer ${adminTok()}`);
    const bad = await request(app()).get('/audit?from=abc&to=').set('Authorization', `Bearer ${adminTok()}`);
    expect(bad.status).toBe(200);
    expect(bad.body.entries).toHaveLength(all.body.entries.length);
  });
});
