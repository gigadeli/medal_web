/**
 * saves テーブル (DESIGN_SERVER.md §6.2 / §7.2)
 *
 * payload は不透明な blob。中身の形が変わっても ALTER TABLE が要らない。
 * 比較に使う数字だけ scores に切り出す (db/scores.ts)。
 */

export type SaveRow = {
  rev: number;
  payload: string;
  client_saved_at: number;
  updated_at: number;
};

export async function getSave(db: D1Database, userId: string): Promise<SaveRow | null> {
  return db
    .prepare('SELECT rev, payload, client_saved_at, updated_at FROM saves WHERE user_id = ?')
    .bind(userId)
    .first<SaveRow>();
}

/**
 * `rev` は **サーバが持つ** (§15-5)。
 * クライアントに単調増加カウンタを持たせると `rev: 2^53` を送られて、
 * 以後どの端末からも上書きできない行ができる。
 */
export function upsertSaveStmt(
  db: D1Database, userId: string, rev: number, payload: string,
  clientSavedAt: number, now: number
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO saves (user_id, rev, payload, client_saved_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(user_id) DO UPDATE SET
         rev = ?2, payload = ?3, client_saved_at = ?4, updated_at = ?5`
    )
    .bind(userId, rev, payload, clientSavedAt, now);
}
