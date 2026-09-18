import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db/index.js';
import { makeAuditEntry, appendAudit, queryAudit } from '../src/db/audit.js';

describe('audit log', () => {
  it('appends an entry and reads it back', () => {
    const db = openDb();
    const e = makeAuditEntry('listen_start', 'm1', { officerEmail: 'o@x.com' });
    appendAudit(db, e);
    const rows = queryAudit(db, {});
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(e);
  });

  it('filters by meetingId and time window, ordered by at ASC', () => {
    const db = openDb();
    appendAudit(db, { id: 'a', action: 'bot_join', meetingId: 'm1', at: 100 });
    appendAudit(db, { id: 'b', action: 'bot_error', meetingId: 'm1', detail: 'drop', at: 300 });
    appendAudit(db, { id: 'c', action: 'bot_join', meetingId: 'm2', at: 200 });
    expect(queryAudit(db, { meetingId: 'm1' }).map((r) => r.id)).toEqual(['a', 'b']);
    expect(queryAudit(db, { from: 150, to: 250 }).map((r) => r.id)).toEqual(['c']);
    expect(queryAudit(db, {}).map((r) => r.id)).toEqual(['a', 'c', 'b']);
  });
});
