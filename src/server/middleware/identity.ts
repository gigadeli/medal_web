/**
 * Cookie のトークン → user_id (DESIGN_SERVER.md §5)
 *
 * ■ このファイルの一行要約
 *   **クライアントが名乗った ID を絶対に見ない。**
 *
 *   `DESIGN.md §11.3` が書いている通り、localStorage の `userId` は
 *   プレイヤーが自由に書き換えられる。それをサーバが信じると、
 *   他人の ID を入れるだけで他人のセーブを読み書きできてしまう。
 *   受け付けるのは **サーバが発行した秘密** だけ。
 */
import type { Context, MiddlewareHandler } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { AppEnv } from '../types.js';
import { COOKIE_NAME, SESSION_TTL_MS } from '../domain/limits.js';
import { findSession, touchSessionStmt } from '../db/sessions.js';
import { sha256Hex } from '../tokens.js';
import { HttpError } from './core.js';

/**
 * 有効なトークンが無ければ 401。
 *
 * 初稿には「無ければその場で発行する」ensure モードもあったが、廃止した。
 * 登録は `POST /api/session` に分離してある。理由は2つ:
 *   1. Turnstile のトークンは `sendBeacon` に載せられない。
 *      登録が同期の経路に混ざっていると、Turnstile を掛けられない
 *   2. 登録は書き込み枠を焼く経路なので (§15-3)、入口を1つに絞りたい
 * 遅延登録 (開いて即閉じた人の行を作らない) の性質は、
 * クライアントが「同期が必要になってから呼ぶ」ことで保たれる。
 */
export const requireIdentity: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = getCookie(c, COOKIE_NAME);
  if (!token) throw new HttpError(401, 'no_session');

  const hash = await sha256Hex(token);
  const now = Date.now();
  // expires_at を必ず見る (§15-10)。見落とすと期限が無いのと同じになる
  const row = await findSession(c.env.DB, hash, now);
  if (!row) throw new HttpError(401, 'no_session');

  c.set('userId', row.user_id);
  await next();
  // 応答を返したあとに最終利用時刻を更新する。失敗しても本筋は止めない
  c.executionCtx.waitUntil(touchSessionStmt(c.env.DB, hash, now).run().then(() => {}, () => {}));
};

/** 発行したトークンを Cookie に入れる (§5.2) */
export function issueCookie(c: Context<AppEnv>, token: string): void {
  setCookie(c, COOKIE_NAME, token, {
    httpOnly: true,                 // JS から読めない。XSS が入っても盗まれない
    secure: true,
    sameSite: 'Lax',                // Strict は外部リンクから開いた初回に付かない (§5.2)
    path: '/',
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
}

/** 「記録を消す」で Cookie も落とす (§7.3) */
export function clearCookie(c: Context<AppEnv>): void {
  deleteCookie(c, COOKIE_NAME, { path: '/', secure: true, sameSite: 'Lax' });
}
