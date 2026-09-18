import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/server.js';
import { openDb } from '../src/db/index.js';
import { loadConfig } from '../src/config.js';
import { signAppSession } from '../src/auth/appToken.js';

// loadConfig() requires APP_SECRET; set a test value if none provided by CI.
beforeAll(() => {
  if (!process.env.APP_SECRET) process.env.APP_SECRET = 'test-secret';
});

function testApp() {
  return createApp({ config: loadConfig(), db: openDb() });
}

describe('createApp', () => {
  it('GET /health returns ok with a CORS header', async () => {
    const res = await request(testApp()).get('/health').set('Origin', 'http://localhost:5173');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
  });

  it('wires the meeting + audit routers end-to-end', async () => {
    const app = testApp();
    const admin = signAppSession({ email: 'a@x.com', role: 'admin' }, loadConfig().appSecret);
    const created = await request(app).post('/meetings').set('Authorization', `Bearer ${admin}`)
      .send({ sipUri: '1@s.webex.com', title: 'A' });
    expect(created.status).toBe(201);
    const audit = await request(app).get('/audit').set('Authorization', `Bearer ${admin}`);
    expect(audit.status).toBe(200);
    expect(audit.body.entries).toEqual([]);
  });

  it('protects /meetings without a token (401)', async () => {
    expect((await request(testApp()).get('/meetings')).status).toBe(401);
  });
});
