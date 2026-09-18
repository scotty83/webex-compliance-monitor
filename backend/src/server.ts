import express, { type Express } from 'express';
import cors from 'cors';
import path from 'node:path';
import { loadConfig, type Config } from './config.js';
import { openDb, type DB } from './db/index.js';
import { makeRequireRole } from './auth/middleware.js';
import { authRouter } from './auth/routes.js';
import { meetingsRouter, type MeetingLifecycle, type WebexReadSeams } from './meetings/routes.js';
import { auditRouter } from './audit/routes.js';

export function createApp(deps: {
  config?: Config;
  db?: DB;
  fetchImpl?: typeof fetch;
  lifecycle?: MeetingLifecycle;
  webex?: Partial<WebexReadSeams>;
} = {}): Express {
  const config = deps.config ?? loadConfig();
  const db = deps.db ?? openDb(config.databasePath);
  const requireRole = makeRequireRole(config.appSecret);

  const app = express();
  app.use(cors({ origin: config.appBaseUrl }));
  app.use(express.json());
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));

  app.use(authRouter({
    appSecret: config.appSecret,
    oauth: config.oauth,
    appBaseUrl: config.appBaseUrl,
    officerEmails: config.officerEmails,
    adminEmails: config.adminEmails,
    fetchImpl: deps.fetchImpl,
    webexApiBase: config.webexApiBase,
  }));
  app.use(meetingsRouter({ db, requireRole, lifecycle: deps.lifecycle, webex: deps.webex }));
  app.use(auditRouter({ db, requireRole }));

  // Single-origin production deploy: serve the built SPA, falling back to index.html
  // for client-side routes. Registered AFTER the API routers, so only unmatched GETs
  // hit the SPA fallback.
  if (config.frontendDist) {
    const dist = config.frontendDist;
    app.use(express.static(dist));
    app.get('*', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  }
  return app;
}
