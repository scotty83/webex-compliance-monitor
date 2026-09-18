import { createRequire } from 'node:module';
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { DatabaseSync, DatabaseSyncOptions } from 'node:sqlite';

// vite-node's prefixedBuiltins only includes 'node:test'; 'sqlite' is absent from
// Node's builtinModules list, so vite-node cannot auto-externalize node:sqlite.
// createRequire uses Node's native loader and bypasses Vite's module graph entirely.
const { DatabaseSync: DatabaseSyncCtor } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string, options?: DatabaseSyncOptions) => DatabaseSync;
};

export type DB = DatabaseSync;

const schemaPath = join(dirname(fileURLToPath(import.meta.url)), 'schema.sql');

/** Open (or create) the SQLite db and apply the schema. Defaults to an in-memory db for tests. */
export function openDb(path = ':memory:'): DB {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new DatabaseSyncCtor(path);
  db.exec('PRAGMA foreign_keys = ON');
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  db.exec(readFileSync(schemaPath, 'utf8'));
  // Additive migration: CREATE TABLE IF NOT EXISTS never alters an
  // existing table, so pre-Plan-07 db files lack meetings.source — patch in place.
  const meetingCols = db.prepare('PRAGMA table_info(meetings)').all() as unknown as Array<{ name: string }>;
  if (!meetingCols.some((c) => c.name === 'source')) {
    db.exec("ALTER TABLE meetings ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'");
  }
  // PSTN caller-id additive migration: CREATE TABLE IF NOT EXISTS never alters an
  // existing table, so pre-PSTN db files lack roster_presence.pstn / phone — patch in place.
  // Idempotent: runs on every openDb; PRAGMA table_info is read-only.
  const presenceCols = db.prepare('PRAGMA table_info(roster_presence)').all() as unknown as Array<{ name: string }>;
  if (!presenceCols.some((c) => c.name === 'pstn')) {
    db.exec('ALTER TABLE roster_presence ADD COLUMN pstn INTEGER NOT NULL DEFAULT 0');
  }
  if (!presenceCols.some((c) => c.name === 'phone')) {
    db.exec('ALTER TABLE roster_presence ADD COLUMN phone TEXT');
  }
  return db;
}
