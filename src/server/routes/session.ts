/**
 * POST /api/session —— 匿名ユーザーの登録 (DESIGN_SERVER.md §5.2)
 *
 * ログイン画面は無い。サーバが user_id とトークンを作り、
 * トークンは HttpOnly Cookie に入れる。D1 に入るのはハッシュだけ。
 *
 * 遅延登録 (§5.2): クライアントは「同期が必要になってから」ここを呼ぶ。
 * 開いて即閉じた人の行は作らない。
 */
import { Hono } from 'hono';
import type { AppEnv } from '../types.js';
import { HttpError } from '../middleware/core.js';
import { jsonBody } from '../middleware/validate.js';
import { issueCookie } from '../middleware/identity.js';
import { verifyTurnstile } from '../middleware/turnstile.js';
import { createUserStmt, tryCountSignup } from '../db/users.js';
import { createSessionStmt } from '../db/sessions.js';
import { newToken, sha256Hex } from '../tokens.js';
import { SESSION_TTL_MS } from '../domain/limits.js';

export const sessionRoutes = new Hono<AppEnv>();

sessionRoutes.post('/', jsonBody, async (c) => {
  const body = c.get('body') as Record<string, unknown> | null;
  const ip = c.req.header('cf-connecting-ip');

  // ここが Sybil と書き込み枠 DoS の唯一の入口 (§15-1 / §15-3)
  const ok = await verifyTurnstile(c.env, body?.['turnstile'], ip);
  if (!ok) throw new HttpError(403, 'turnstile_failed');

  const now = Date.now();
  if (!(await tryCountSignup(c.env.DB, now))) {
    throw new HttpError(429, 'signup_limit');
  }

  const userId = crypto.randomUUID();
  const token = newToken();

  /* users と sessions は必ず一緒に作る。
     実測で踏んだ: 別々の await にしていたところ、Cookie の発行で例外が出た結果
     **user 行だけが残る**孤児ができた。片方だけ残ると、
     誰も名乗れないユーザーが D1 に積もっていく。
     Cookie を先に積むのも同じ理由で、逆に失敗しても
     「セッションの無い Cookie」= 次のリクエストで 401 になって作り直されるだけで済む */
  issueCookie(c, token);
  await c.env.DB.batch([
    createUserStmt(c.env.DB, userId, now),
    createSessionStmt(c.env.DB, await sha256Hex(token), userId, now, now + SESSION_TTL_MS),
  ]);
  // rev 0 = まだセーブが無い。次の PUT はこの値を送ってくる
  return c.json({ userId, rev: 0 });
});
