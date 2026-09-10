/**
 * セーブのミラー (DESIGN_SERVER.md §7)
 *
 * localStorage が正で、ここはミラー。落ちてもゲームは止まらない。
 * だから 5xx を返しても構わないし、クライアントは黙って捨てて次の同期で送り直す。
 */
import { Hono } from 'hono';
import type { Handler } from 'hono';
import type { AppEnv } from '../types.js';
import { HttpError } from '../middleware/core.js';
import { jsonBody } from '../middleware/validate.js';
import { requireIdentity } from '../middleware/identity.js';
import { extractClaim, parseSaveRequest, ValidationError } from '../domain/schema.js';
import { applyClaim } from '../domain/plausibility.js';
import { getUser, touchUserStmt } from '../db/users.js';
import { getSave, tryWriteSave } from '../db/saves.js';
import { getScore, upsertScoreStmt } from '../db/scores.js';
import { MAX_BODY_BYTES } from '../domain/limits.js';

export const saveRoutes = new Hono<AppEnv>();

/** 別端末から引き継いだ直後など、ローカルが空のときだけ使う */
saveRoutes.get('/', requireIdentity, async (c) => {
  const row = await getSave(c.env.DB, c.get('userId'));
  if (!row) return c.json({ rev: 0, payload: null });
  return c.json({ rev: row.rev, payload: JSON.parse(row.payload) as unknown });
});

/**
 * セーブの書き込み本体。
 *
 * 2つの経路から入る:
 *   PUT  /api/save         … 通常の同期 (fetch)
 *   POST /api/save/beacon  … pagehide からの最後の1回 (sendBeacon)
 * sendBeacon は **POST 固定でメソッドを選べない** ので、経路を分けている。
 * 中身は同じ。CSRF 防御 (SameSite=Lax + Origin 照合) も同じように効く。
 */
const writeSave: Handler<AppEnv> = async (c) => {
  let req;
  try {
    req = parseSaveRequest(c.get('body'));
  } catch (e) {
    if (e instanceof ValidationError) throw new HttpError(400, 'bad_request');
    throw e;
  }

  const userId = c.get('userId');
  const now = Date.now();
  const db = c.env.DB;

  const [user, save, score] = await Promise.all([
    getUser(db, userId),
    getSave(db, userId),
    getScore(db, userId),
  ]);
  if (!user) throw new HttpError(401, 'no_session');

  /* --- 競合 (§7.2)。rev はサーバが持つので、クライアントは
         「前回もらった値」を返してくるだけ --- */
  const storedRev = save?.rev ?? 0;
  if (req.rev !== storedRev) {
    return c.json(
      {
        error: 'conflict',
        rev: storedRev,
        payload: save ? (JSON.parse(save.payload) as unknown) : null,
      },
      409
    );
  }

  const serialized = JSON.stringify(req.payload);
  if (serialized.length > MAX_BODY_BYTES) throw new HttpError(413, 'body_too_large');

  /* --- 申告に頭を押さえる (§8.2)。
         分母の last_seen_at はサーバの時計。クライアントは申告できない --- */
  const { next, clamped } = applyClaim(
    score, extractClaim(req.payload), now, user.last_seen_at, user.created_at
  );

  /* 書き込みは1文で条件付きに行う。上の rev 検査は
     「サーバ側の payload を返してマージさせる」ための親切な経路であって、
     **競合の検査そのものはここ**。分けると 1ms 差の同時リクエストが
     両方通る（本番で実測。db/saves.ts の注記を参照） */
  const nextRev = await tryWriteSave(
    db, userId, storedRev, serialized, req.clientSavedAt, now
  );
  if (nextRev === null) {
    const fresh = await getSave(db, userId);
    return c.json(
      {
        error: 'conflict',
        rev: fresh?.rev ?? storedRev,
        payload: fresh ? (JSON.parse(fresh.payload) as unknown) : null,
      },
      409
    );
  }

  await db.batch([
    touchUserStmt(db, userId, now),
    upsertScoreStmt(db, userId, next, now),
  ]);

  // clamped はクライアントに伝えない。伝えると
  // 「どこまでなら通るか」を調べる道具になる
  if (clamped) {
    console.warn(JSON.stringify({ reqId: c.get('reqId'), event: 'clamped', userId }));
  }
  return c.json({ rev: nextRev });
};

saveRoutes.put('/', requireIdentity, jsonBody, writeSave);
saveRoutes.post('/beacon', requireIdentity, jsonBody, writeSave);
