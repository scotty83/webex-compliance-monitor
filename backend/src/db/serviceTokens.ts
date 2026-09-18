import type { DB } from './index.js';

/** Stored rotated refresh token, or undefined when the table is empty
 *  (first boot — caller falls back to the env bootstrap value). */
export function getServiceRefreshToken(
  db: DB,
): { refreshToken: string; rotatedAt: number } | undefined {
  const r = db
    .prepare('SELECT refresh_token, rotated_at FROM service_tokens WHERE id = 1')
    .get() as { refresh_token: string; rotated_at: number } | undefined;
  return r ? { refreshToken: r.refresh_token, rotatedAt: r.rotated_at } : undefined;
}

/** Persist the rotated refresh token (single row, upsert). */
export function saveServiceRefreshToken(db: DB, refreshToken: string, rotatedAt: number): void {
  db.prepare(
    `INSERT INTO service_tokens (id, refresh_token, rotated_at) VALUES (1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       refresh_token = excluded.refresh_token,
       rotated_at = excluded.rotated_at`,
  ).run(refreshToken, rotatedAt);
}
