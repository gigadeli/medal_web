/**
 * sessions テーブル (DESIGN_SERVER.md §5.2)
 *
 * 1 user に複数行。端末ごとに1行なので、引き継ぎ後も元の端末が使える。
 * 保存するのは SHA-256(token) だけで、生トークンは保存しない。
 */

export type SessionRow = { user_id: string };

export function createSessionStmt(
  db: D1Database, tokenHash: string, userId: string, now: number, expiresAt: number
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO sessions (token_hash, user_id, created_at, last_used_at, expires_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .bind(tokenHash, userId, now, now, expiresAt);
}

export async function createSession(
  db: D1Database, tokenHash: string, userId: string, now: number, expiresAt: number
): Promise<void> {
  await createSessionStmt(db, tokenHash, userId, now, expiresAt).run();
}

/**
 * トークンからユーザーを引く。
 * **`expires_at` を必ず見る** (§15-10)。見落とすと期限が無いのと同じになる。
 */
export async function findSession(
  db: D1Database, tokenHash: string, now: number
): Promise<SessionRow | null> {
  return db
    .prepare('SELECT user_id FROM sessions WHERE token_hash = ? AND expires_at > ?')
    .bind(tokenHash, now)
    .first<SessionRow>();
}

export function touchSessionStmt(
  db: D1Database, tokenHash: string, now: number
): D1PreparedStatement {
  return db
    .prepare('UPDATE sessions SET last_used_at = ? WHERE token_hash = ?')
    .bind(now, tokenHash);
}

/** 期限切れの掃除 (§14-3)。cron から呼ぶ */
export async function purgeExpiredSessions(db: D1Database, now: number): Promise<void> {
  await db.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(now).run();
}
