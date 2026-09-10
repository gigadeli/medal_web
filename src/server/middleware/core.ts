/**
 * ミドルウェア連鎖の外側4枚 (DESIGN_SERVER.md §4.1)
 *
 *   ① requestId  ─┐  リクエストIDを振る
 *   ② error      ─┤  ここより下の例外を JSON に変える。スタックは返さない
 *   ③ security   ─┤  応答ヘッダ
 *   ④ cors       ─┘  開発時の localhost だけ
 *
 * 順序には意味がある。`error` を外側、`security` を内側に置くのは、
 * `error` が作った 500 の応答にもセキュリティヘッダを通すため。
 * 逆にすると付与を通らない。
 */
import type { ErrorHandler, MiddlewareHandler } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { AppEnv } from '../types.js';

/** 想定内のエラー。これ以外は 500 に丸める */
export class HttpError extends Error {
  constructor(public readonly status: number, public readonly code: string) {
    super(code);
  }
}

export const requestId: MiddlewareHandler<AppEnv> = async (c, next) => {
  const id = crypto.randomUUID();
  c.set('reqId', id);
  await next();
  c.header('X-Request-Id', id);
};

/**
 * 例外を JSON に変える。
 *
 * ■ ミドルウェアではなく `app.onError` で登録する理由（実測で判明）
 *   最初は `try { await next() } catch` のミドルウェアとして書いたが、
 *   **一度も catch に入らなかった**。Hono の `compose` は
 *   ミドルウェア1枚ごとに try/catch を持っていて、内側が投げた時点で
 *   その場で `onError` を呼ぶ。外側の `await next()` は reject しない。
 *
 *   `onError` にすると、応答は投げた深さで作られ、そこから外側の
 *   ミドルウェアの `await next()` の後ろが順に実行される。
 *   つまり **500 の応答にも security のヘッダが付く** —— 元々狙っていた
 *   性質はそのまま得られる。
 */
export const errorHandler: ErrorHandler<AppEnv> = (e, c) => {
  const reqId = c.get('reqId');
  if (e instanceof HttpError) {
    return c.json({ error: e.code, reqId }, e.status as ContentfulStatusCode);
  }
  // 想定外。**メッセージをそのまま返さない**。
  // D1 の例外文にはテーブル名やクエリが乗る
  console.error(JSON.stringify({ reqId, msg: String(e) }));
  return c.json({ error: 'internal', reqId }, 500);
};

export const security: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('Cache-Control', 'no-store');
  // Cookie でユーザーが変わる応答なので、取り違えを防ぐ (§15 15.5)
  c.header('Vary', 'Cookie');
};

/**
 * 本番は同一オリジンなので CORS は要らない (§2)。
 * 効くのは `vite dev` を別ポートで動かしたときだけ。
 */
export const devCors: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.env.ENVIRONMENT !== 'dev') return next();

  const origin = c.req.header('Origin');
  const allowed = origin && /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin);
  if (allowed) {
    c.header('Access-Control-Allow-Origin', origin);
    c.header('Access-Control-Allow-Credentials', 'true');
    c.header('Access-Control-Allow-Headers', 'Content-Type');
    c.header('Access-Control-Allow-Methods', 'GET, PUT, POST, DELETE, OPTIONS');
  }
  if (c.req.method === 'OPTIONS') return c.body(null, 204);
  return next();
};

/**
 * CSRF (§4.5)
 *
 * 独自ヘッダを必須にする手は使えない。`pagehide` からの書き込みは
 * `navigator.sendBeacon` で送るが、sendBeacon は独自ヘッダを付けられないため。
 * 防御は2枚:
 *   1. Cookie の SameSite=Lax —— 他サイトからの POST には Cookie が付かない
 *   2. Origin の照合 —— ここ
 *
 * ※ 1 が主で 2 は保険。sendBeacon が Origin を送ることは
 *    実装フェーズ2で実測する (§15-13)。送らないと分かった場合、
 *    ここを通らなくなるので必ず気付く。
 */
export const sameOrigin: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.req.method === 'GET' || c.req.method === 'OPTIONS') return next();

  const origin = c.req.header('Origin');
  if (!origin) return next();          // 同一オリジンの fetch では省略されることがある

  const self = new URL(c.req.url).origin;
  if (origin === self) return next();
  if (c.env.ENVIRONMENT === 'dev' && /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin)) {
    return next();
  }
  throw new HttpError(403, 'bad_origin');
};
