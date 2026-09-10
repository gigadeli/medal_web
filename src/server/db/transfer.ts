/**
 * transfer_codes テーブル (DESIGN_SERVER.md §5.3)
 *
 * コードもハッシュで保存し、`used_at` を立てて1回で使い切る。
 * 失効・使用済み・不一致は **区別せず** 同じ結果を返す (総当たりに情報を与えない)。
 */

export async function createTransferCode(
  db: D1Database, codeHash: string, userId: string, now: number, expiresAt: number
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO transfer_codes (code_hash, user_id, created_at, expires_at, used_at)
       VALUES (?, ?, ?, ?, NULL)`
    )
    .bind(codeHash, userId, now, expiresAt)
    .run();
}

/**
 * 使えたら user_id を返す。使えなければ null。
 *
 * `UPDATE ... WHERE used_at IS NULL ... RETURNING` の1文にして、
 * 「引いてから更新する」の隙間で2回使われるのを防ぐ。
 */
export async function redeemTransferCode(
  db: D1Database, codeHash: string, now: number
): Promise<string | null> {
  const row = await db
    .prepare(
      `UPDATE transfer_codes SET used_at = ?1
        WHERE code_hash = ?2 AND used_at IS NULL AND expires_at > ?1
       RETURNING user_id`
    )
    .bind(now, codeHash)
    .first<{ user_id: string }>();
  return row?.user_id ?? null;
}

/** 同じユーザーが何枚も未使用のコードを持たないようにする */
export async function invalidateUserCodes(
  db: D1Database, userId: string, now: number
): Promise<void> {
  await db
    .prepare('UPDATE transfer_codes SET used_at = ? WHERE user_id = ? AND used_at IS NULL')
    .bind(now, userId)
    .run();
}

/** 期限切れの掃除。cron から呼ぶ */
export async function purgeExpiredCodes(db: D1Database, now: number): Promise<void> {
  await db.prepare('DELETE FROM transfer_codes WHERE expires_at <= ?').bind(now).run();
}
