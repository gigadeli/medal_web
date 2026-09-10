/**
 * 端末間の引き継ぎ (DESIGN_SERVER.md §5.3)
 *
 * ログイン画面を作らないので、使い捨てコードで移す。
 * 失効・使用済み・不一致は **区別せず** 同じ 404 を返す (総当たりに情報を与えない)。
 */
import { Hono } from 'hono';
import type { AppEnv } from '../types.js';
import { HttpError } from '../middleware/core.js';
import { jsonBody } from '../middleware/validate.js';
import { requireIdentity, issueCookie } from '../middleware/identity.js';
import { transferRateLimit } from '../middleware/rateLimit.js';
import { parseRedeemRequest, ValidationError } from '../domain/schema.js';
import {
  createTransferCode, invalidateUserCodes, redeemTransferCode,
} from '../db/transfer.js';
import { createSession } from '../db/sessions.js';
import { getUser } from '../db/users.js';
import { newToken, newTransferCode, normalizeTransferCode, sha256Hex } from '../tokens.js';
import { SESSION_TTL_MS, TRANSFER_TTL_MS } from '../domain/limits.js';

export const transferRoutes = new Hono<AppEnv>();

/** 元の端末で発行する */
transferRoutes.post('/code', requireIdentity, async (c) => {
  const userId = c.get('userId');
  const now = Date.now();

  // 未使用のコードを何枚も持たせない
  await invalidateUserCodes(c.env.DB, userId, now);

  const code = newTransferCode();
  await createTransferCode(
    c.env.DB, await sha256Hex(normalizeTransferCode(code)),
    userId, now, now + TRANSFER_TTL_MS
  );
  return c.json({ code, expiresInMs: TRANSFER_TTL_MS });
});

/**
 * 新しい端末で使う。identity は要らない (まだ Cookie が無い)。
 * そのぶん rate limit を厳しくかける。
 */
transferRoutes.post('/redeem', transferRateLimit, jsonBody, async (c) => {
  let raw: string;
  try {
    raw = parseRedeemRequest(c.get('body'));
  } catch (e) {
    if (e instanceof ValidationError) throw new HttpError(400, 'bad_request');
    throw e;
  }

  const now = Date.now();
  const hash = await sha256Hex(normalizeTransferCode(raw));
  const userId = await redeemTransferCode(c.env.DB, hash, now);
  // 失効も使用済みも不一致も同じ応答
  if (!userId) throw new HttpError(404, 'bad_code');

  // ユーザーが消えている (「記録を消す」の直後) 場合を弾く
  if (!(await getUser(c.env.DB, userId))) throw new HttpError(404, 'bad_code');

  // 元の端末のセッションは残す。端末ごとに1行なので両方使える (§5.2)
  const token = newToken();
  await createSession(c.env.DB, await sha256Hex(token), userId, now, now + SESSION_TTL_MS);
  issueCookie(c, token);

  return c.json({ userId });
});
