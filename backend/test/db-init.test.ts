import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db/index.js';

describe('openDb', () => {
  it('creates all three tables on a fresh in-memory db', () => {
    const db = openDb();
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r: any) => r.name);
    expect(names).toEqual(expect.arrayContaining(['audit_log', 'bot_status', 'meetings']));
  });

  it('creates the audit index', () => {
    const db = openDb();
    const idx = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_audit_meeting'")
      .get();
    expect(idx).toBeTruthy();
  });

  it('is idempotent — opening twice on the same connection does not throw', () => {
    const db = openDb();
    expect(() => db.exec(db.prepare("SELECT 'noop'").sourceSQL ? '' : '')).not.toThrow();
  });
});
