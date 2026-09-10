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
 * `rev` が一致するときだけ書く。**1文で完結させるのが要点**。
 *
 * ■ なぜ read → 比較 → write に分けてはいけないか（本番で実測した）
 *   `visibilitychange` と `pagehide` の両方から `sendBeacon` が飛び、
 *   **1ms 差で 2 本が届いた**。ハンドラ側で「読む→比べる→書く」に分けていたため、
 *   両方が `rev=1` を読んで両方が検査を通り、両方が書いた
 *   （`rev` が 3 ではなく 2 で止まったのがその証拠）。
 *   今回は同じ内容だったので実害は無かったが、2端末が同時に同期すると
 *   **409 を返さずに片方が黙って消える** —— §7.2 が防ぐはずのケースそのもの。
 *
 *   `ON CONFLICT ... DO UPDATE ... WHERE` は SQLite が1文の中で評価するので、
 *   同時に来ても片方しか通らない。
 *
 * `rev` は **サーバが持つ** (§15-5)。クライアントに単調増加カウンタを持たせると
 * `rev: 2^53` を送られて、以後どの端末からも上書きできない行ができる。
 *
 * @param expectedRev クライアントが前回サーバから受け取った rev
 * @returns 書けたら新しい rev。競合で書けなければ null
 */
export async function tryWriteSave(
  db: D1Database, userId: string, expectedRev: number, payload: string,
  clientSavedAt: number, now: number
): Promise<number | null> {
  const row = await db
    .prepare(
      `INSERT INTO saves (user_id, rev, payload, client_saved_at, updated_at)
       VALUES (?1, 1, ?2, ?3, ?4)
       ON CONFLICT(user_id) DO UPDATE SET
         rev = saves.rev + 1, payload = ?2, client_saved_at = ?3, updated_at = ?4
         WHERE saves.rev = ?5
       RETURNING rev`
    )
    .bind(userId, payload, clientSavedAt, now, expectedRev)
    .first<{ rev: number }>();
  return row?.rev ?? null;
}
