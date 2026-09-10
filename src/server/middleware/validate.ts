/**
 * 本文の受け取り (DESIGN_SERVER.md §4.2 ⑦ / §15-9)
 *
 * Workers は 100MB のリクエストまで受けてしまう。巨大な JSON をパースさせると
 * 無料枠 10ms の CPU が飛ぶので、**`json()` を呼ぶ前に** 長さで弾く。
 *
 * 実測のセーブは 319 バイト。8KB あれば当分足りる。
 */
import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../types.js';
import { MAX_BODY_BYTES } from '../domain/limits.js';
import { HttpError } from './core.js';

export const jsonBody: MiddlewareHandler<AppEnv> = async (c, next) => {
  const declared = c.req.header('Content-Length');
  if (declared && Number(declared) > MAX_BODY_BYTES) {
    throw new HttpError(413, 'body_too_large');
  }

  const text = await c.req.text();
  // Content-Length が無い (chunked) 場合の二段目
  if (text.length > MAX_BODY_BYTES) throw new HttpError(413, 'body_too_large');

  let parsed: unknown = {};
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new HttpError(400, 'bad_json');
    }
  }
  c.set('body', parsed);
  return next();
};
