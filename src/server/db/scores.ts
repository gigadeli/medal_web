/**
 * scores / score_histogram テーブル (DESIGN_SERVER.md §8)
 *
 * ここのカウンタは `domain/plausibility.ts` が上限をかけてから書く。
 * 生の申告値をそのまま入れる経路を作らないこと。
 */
import { emptyScore, isEligible, type ScoreState } from '../domain/plausibility.js';
import { HISTOGRAM_BUCKETS, ELIGIBLE_DAYS, ELIGIBLE_PLAY_MS } from '../domain/limits.js';

export async function getScore(db: D1Database, userId: string): Promise<ScoreState> {
  const row = await db
    .prepare(
      `SELECT best_medals, lifetime_earned, jp_wins, jp_paid,
              play_ms, sync_days, last_sync_day, bucket, strikes, flagged
         FROM scores WHERE user_id = ?`
    )
    .bind(userId)
    .first<ScoreState>();
  return row ?? emptyScore();
}

export function upsertScoreStmt(
  db: D1Database, userId: string, s: ScoreState, now: number
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO scores (user_id, best_medals, lifetime_earned, jp_wins, jp_paid,
                           play_ms, sync_days, last_sync_day, bucket, strikes, flagged, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
       ON CONFLICT(user_id) DO UPDATE SET
         best_medals = ?2, lifetime_earned = ?3, jp_wins = ?4, jp_paid = ?5,
         play_ms = ?6, sync_days = ?7, last_sync_day = ?8, bucket = ?9,
         strikes = ?10, flagged = ?11, updated_at = ?12`
    )
    .bind(
      userId, s.best_medals, s.lifetime_earned, s.jp_wins, s.jp_paid,
      s.play_ms, s.sync_days, s.last_sync_day, s.bucket, s.strikes, s.flagged, now
    );
}

/* ---------------- 分布表 (§8.5) ---------------- */

export type Histogram = { total: number; cum: Map<number, number>; builtAt: number };

/**
 * 参照は分布表への引きだけで済ませる。
 *
 * 初稿は毎リクエストで `COUNT(*)` を2回まわす案だったが、
 * これは 1万人で1リクエスト約2万行の読み取りになり、
 * 無料枠 500万行/日を **250 リクエストで使い切る** (§15-7)。
 */
export async function loadHistogram(db: D1Database): Promise<Histogram> {
  const rows = await db
    .prepare('SELECT bucket, cum_count, built_at FROM score_histogram ORDER BY bucket')
    .all<{ bucket: number; cum_count: number; built_at: number }>();

  const cum = new Map<number, number>();
  let total = 0;
  let builtAt = 0;
  for (const r of rows.results) {
    cum.set(r.bucket, r.cum_count);
    total = Math.max(total, r.cum_count);
    builtAt = Math.max(builtAt, r.built_at);
  }
  return { total, cum, builtAt };
}

/** 自分の段より下に何人いるか → 上位何パーセントか */
export function percentileOf(h: Histogram, bucket: number): number {
  if (h.total <= 0) return 0;
  let below = 0;
  for (let b = bucket - 1; b >= 0; b--) {
    const v = h.cum.get(b);
    if (v !== undefined) { below = v; break; }
  }
  return (below / h.total) * 100;
}

/**
 * cron から呼ぶ。資格を満たした行だけを数える (§8.5)。
 *
 * 資格の条件は `isEligible()` と同じ内容を SQL で書いている。
 * 片方だけ直すと分母がずれるので、変えるときは必ず両方見ること。
 */
export async function rebuildHistogram(db: D1Database, now: number): Promise<number> {
  const rows = await db
    .prepare(
      `SELECT bucket, COUNT(*) AS n FROM scores
        WHERE flagged = 0 AND play_ms >= ? AND sync_days >= ?
        GROUP BY bucket ORDER BY bucket`
    )
    .bind(ELIGIBLE_PLAY_MS, ELIGIBLE_DAYS)
    .all<{ bucket: number; n: number }>();

  const counts = new Map<number, number>();
  for (const r of rows.results) counts.set(r.bucket, r.n);

  const stmts: D1PreparedStatement[] = [db.prepare('DELETE FROM score_histogram')];
  let cum = 0;
  for (let b = 0; b < HISTOGRAM_BUCKETS; b++) {
    cum += counts.get(b) ?? 0;
    if (cum === 0) continue;               // 空の段は行を作らない
    stmts.push(
      db.prepare('INSERT INTO score_histogram (bucket, cum_count, built_at) VALUES (?, ?, ?)')
        .bind(b, cum, now)
    );
  }
  await db.batch(stmts);
  return cum;
}

export { isEligible };
