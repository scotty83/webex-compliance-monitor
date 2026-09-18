import { randomUUID } from 'node:crypto';
import type { DB } from './index.js';
import type { AuditAction, AuditEntry } from '../domain/types.js';

interface AuditRow {
  id: string;
  action: string;
  meeting_id: string;
  officer_email: string | null;
  detail: string | null;
  at: number;
}

function toEntry(r: AuditRow): AuditEntry {
  return {
    id: r.id,
    action: r.action as AuditAction,
    meetingId: r.meeting_id,
    officerEmail: r.officer_email ?? undefined,
    detail: r.detail ?? undefined,
    at: r.at,
  };
}

export function makeAuditEntry(
  action: AuditAction,
  meetingId: string,
  opts: { officerEmail?: string; detail?: string } = {},
): AuditEntry {
  return { id: randomUUID(), action, meetingId, officerEmail: opts.officerEmail, detail: opts.detail, at: Date.now() };
}

export function appendAudit(db: DB, entry: AuditEntry): void {
  db.prepare(
    `INSERT INTO audit_log (id, action, meeting_id, officer_email, detail, at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(entry.id, entry.action, entry.meetingId, entry.officerEmail ?? null, entry.detail ?? null, entry.at);
}

export interface AuditFilter {
  meetingId?: string;
  from?: number;
  to?: number;
}

export function queryAudit(db: DB, filter: AuditFilter = {}): AuditEntry[] {
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (filter.meetingId) {
    clauses.push('meeting_id = ?');
    params.push(filter.meetingId);
  }
  if (filter.from !== undefined) {
    clauses.push('at >= ?');
    params.push(filter.from);
  }
  if (filter.to !== undefined) {
    clauses.push('at <= ?');
    params.push(filter.to);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db
    .prepare(`SELECT * FROM audit_log ${where} ORDER BY at ASC`)
    .all(...params) as unknown as AuditRow[];
  return rows.map(toEntry);
}
