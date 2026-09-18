import { Router, type RequestHandler } from 'express';
import type { Role } from '../domain/types.js';
import type { DB } from '../db/index.js';
import { queryAudit } from '../db/audit.js';

function numParam(v: unknown): number | undefined {
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export function auditRouter(opts: { db: DB; requireRole: (role: Role) => RequestHandler }): Router {
  const router = Router();

  router.get('/audit', opts.requireRole('admin'), (req, res) => {
    const meetingId = req.query.meetingId ? String(req.query.meetingId) : undefined;
    const from = numParam(req.query.from);
    const to = numParam(req.query.to);
    return res.json({ entries: queryAudit(opts.db, { meetingId, from, to }) });
  });

  return router;
}
