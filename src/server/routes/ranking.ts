/**
 * GET /api/ranking (DESIGN_SERVER.md §8.5)
 *
 * 名前は出さない。出すのはパーセンタイルだけ。
 * ただし理由は初稿の「名前が要らないから安全」ではない —— それは逆だった (§15-1)。
 * パーセンタイルは **分母が攻撃対象** で、行はタダで作れる。
 * 成立させているのは下の「参加資格」で、
 * `play_ms` も `sync_days` もサーバの時計でしか進まない。
 */
import { Hono } from 'hono';
import type { AppEnv } from '../types.js';
import { requireIdentity } from '../middleware/identity.js';
import { getScore, loadHistogram, percentileOf, isEligible } from '../db/scores.js';
import { ELIGIBLE_DAYS, ELIGIBLE_PLAY_MS, RANKING_MIN_POPULATION } from '../domain/limits.js';

export const rankingRoutes = new Hono<AppEnv>();

rankingRoutes.get('/', requireIdentity, async (c) => {
  const score = await getScore(c.env.DB, c.get('userId'));

  // 資格に足りていない。あと何が要るかは返す (隠す理由がない)
  if (!isEligible(score)) {
    return c.json({
      status: 'ineligible',
      needPlayMs: Math.max(0, ELIGIBLE_PLAY_MS - score.play_ms),
      needDays: Math.max(0, ELIGIBLE_DAYS - score.sync_days),
    });
  }

  const hist = await loadHistogram(c.env.DB);
  // 母数が少ないうちは統計として意味を持たないので数字を見せない
  if (hist.total < RANKING_MIN_POPULATION) {
    return c.json({ status: 'building', population: hist.total });
  }

  return c.json({
    status: 'ok',
    // 「上位 N%」なので 100 から引く
    topPercent: Math.max(0.1, Math.round((100 - percentileOf(hist, score.bucket)) * 10) / 10),
    population: hist.total,
    best: score.best_medals,
    // §8.4 / DESIGN_SECURITY.md §5 案3。画面に必ず出す
    unverified: true,
  });
});
