/**
 * 乱打を止める蓋 (DESIGN_SERVER.md §4.3)
 *
 * ■ 性質を誤解しないこと
 *   - period は 10 か 60 秒しか取れない
 *   - カウンタは Cloudflare のロケーションごと。グローバルには正確でない
 *   - ドキュメントが明言している通り「permissive, eventually consistent,
 *     正確な計上に使うな」
 *
 *   したがってこれは不正の **検出手段ではない**。
 *   §8 の外れ値判定をここで代用しようとしないこと。
 *
 * identity より上に置く。認証前に落とせば、攻撃時に D1 を読まずに済む。
 */
import type { MiddlewareHandler } from 'hono';
import type { AppEnv, RateLimiter } from '../types.js';
import { HttpError } from './core.js';

type Pick = (c: { env: AppEnv['Bindings'] }) => RateLimiter;

export function rateLimit(pick: Pick): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    // identity より上なので user_id はまだ無い。IP で引く。
    // この IP は D1 に保存しない (§6.1)
    const key = c.req.header('cf-connecting-ip') ?? 'unknown';
    const { success } = await pick({ env: c.env }).limit({ key });
    if (!success) {
      c.header('Retry-After', '60');
      throw new HttpError(429, 'rate_limited');
    }
    return next();
  };
}

export const apiRateLimit = rateLimit((c) => c.env.API_LIMITER);
export const transferRateLimit = rateLimit((c) => c.env.TRANSFER_LIMITER);
