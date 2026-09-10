/**
 * users テーブル (DESIGN_SERVER.md §6.1)
 *
 * ここ (db/) 以外に SQL を書かない。理由は §3 の通りで、
 * SQL がハンドラに散らばると外れ値判定やランキングのクエリを直せなくなる。
 *
 * ■ 決まりごと (§15-12)
 *   prepared statement と `bind()` のみ。文字列連結でクエリを作らない。
 */
import { dayOf, SIGNUP_PER_DAY } from '../domain/limits.js';

export type UserRow = { id: string; created_at: number; last_seen_at: number };

/**
 * 文で返す。`sessions` への INSERT と `batch()` で一緒に流すため。
 * 別々に await すると、片方だけ成功して名乗れないユーザーが残る (実測で踏んだ)。
 */
export function createUserStmt(db: D1Database, id: string, now: number): D1PreparedStatement {
  return db
    .prepare('INSERT INTO users (id, created_at, last_seen_at) VALUES (?, ?, ?)')
    .bind(id, now, now);
}

export async function getUser(db: D1Database, id: string): Promise<UserRow | null> {
  return db
    .prepare('SELECT id, created_at, last_seen_at FROM users WHERE id = ?')
    .bind(id)
    .first<UserRow>();
}

/**
 * `last_seen_at` は §8.3 のレート許容量と play_ms の分母になる。
 * **クライアントの申告値をここに入れてはいけない。**
 */
export function touchUserStmt(db: D1Database, id: string, now: number): D1PreparedStatement {
  return db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').bind(now, id);
}

/**
 * 「記録を消す」(§7.3)。
 * 論理削除にしない。`ON DELETE CASCADE` で sessions / saves / scores /
 * transfer_codes が一緒に消える。
 * 消したのに識別子が残るのでは消したことにならない (DESIGN.md §11.10)。
 */
export async function deleteUser(db: D1Database, id: string): Promise<void> {
  await db.prepare('DELETE FROM users WHERE id = ?').bind(id).run();
}

/**
 * 1日に作れるユーザー数の上限 (§15-3)。
 *
 * 無認証の登録は D1 の書き込み枠を焼く経路になる。`ratelimits` binding は
 * ロケーションごとで permissive なので、D1 側に実カウンタを持つ。
 * @returns 上限内なら true
 */
export async function tryCountSignup(db: D1Database, now: number): Promise<boolean> {
  const day = dayOf(now);
  const row = await db
    .prepare(
      `INSERT INTO signup_counter (day, count) VALUES (?, 1)
         ON CONFLICT(day) DO UPDATE SET count = count + 1
       RETURNING count`
    )
    .bind(day)
    .first<{ count: number }>();
  return (row?.count ?? 0) <= SIGNUP_PER_DAY;
}
