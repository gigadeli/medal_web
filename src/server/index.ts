/**
 * Worker のエントリ (DESIGN_SERVER.md §2 / §4)
 *
 * この Worker が起動するのは `/api/*` だけ。
 * `wrangler.jsonc` の `run_worker_first: ["/api/*"]` により、
 * 3.7MB の JS と 7.1MB の mp4 は Worker を通らずに配信される。
 *
 * ミドルウェアの順序 (§4.1):
 *   ① requestId → ② error → ③ security → ④ cors → sameOrigin
 *   → ⑤ rateLimit → ⑥ identity → ⑦ validate → ⑧ handler
 * ⑥⑦は経路ごとに違うので、各ルート側で挟んでいる。
 */
import { Hono } from 'hono';
import type { AppEnv, Env } from './types.js';
import {
  HttpError, devCors, errorHandler, requestId, sameOrigin, security,
} from './middleware/core.js';
import { apiRateLimit } from './middleware/rateLimit.js';
import { sessionRoutes } from './routes/session.js';
import { saveRoutes } from './routes/save.js';
import { rankingRoutes } from './routes/ranking.js';
import { transferRoutes } from './routes/transfer.js';
import { userRoutes } from './routes/user.js';
import { rebuildHistogram } from './db/scores.js';
import { purgeExpiredSessions } from './db/sessions.js';
import { purgeExpiredCodes } from './db/transfer.js';

const app = new Hono<AppEnv>();

/* ---- 例外の受け口 (§4.1 ②) ----
   ミドルウェアとして挟むと Hono の compose に先取りされて一度も動かない。
   onError で登録すると、応答が作られたあとに外側のミドルウェアの
   後半 (security のヘッダ付与など) が順に走る */
app.onError(errorHandler);

/* ---- 全経路に掛ける枚数 + CSRF ---- */
app.use('*', requestId);
app.use('*', security);
app.use('*', devCors);
app.use('*', sameOrigin);

/* ---- identity より上で落とす (§4.1) ---- */
app.use('/api/*', apiRateLimit);

app.get('/api/health', (c) => c.json({ ok: true, env: c.env.ENVIRONMENT }));
app.route('/api/session', sessionRoutes);
app.route('/api/save', saveRoutes);
app.route('/api/ranking', rankingRoutes);
app.route('/api/transfer', transferRoutes);
app.route('/api/user', userRoutes);

app.all('/api/*', () => {
  throw new HttpError(404, 'not_found');
});

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    const url = new URL(request.url);
    // /api/* 以外がここに来るのは not_found_handling の取りこぼしだけ。
    // 静的側にそのまま渡す
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    return app.fetch(request, env, ctx);
  },

  /**
   * 10分おき (§8.5)。
   * ランキングの分布表を作り直し、期限切れを掃除する。
   * 毎リクエストで COUNT(*) をまわす初稿の案だと無料枠が枯れる (§15-7)。
   */
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const now = Date.now();
    ctx.waitUntil(
      (async () => {
        const total = await rebuildHistogram(env.DB, now);
        await purgeExpiredSessions(env.DB, now);
        await purgeExpiredCodes(env.DB, now);
        console.log(JSON.stringify({ event: 'histogram_rebuilt', total }));
      })()
    );
  },
} satisfies ExportedHandler<Env>;
