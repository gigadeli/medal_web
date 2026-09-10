/**
 * 受け取る JSON の形 (DESIGN_SERVER.md §4.2 ⑦)
 *
 * zod は入れていない (§13)。検証したいのは「非負整数か・上限内か」だけで、
 * `Wallet.uint()` と同じ実装をここに写すほうが軽く、
 * しきい値がゲーム本体と同じ場所 (`CFG`) を向く。
 *
 * ■ 重要 (§15-12)
 *   `JSON.parse` した値に **スプレッドや `Object.assign` を使わない**。
 *   `__proto__` が自前プロパティとして乗った状態で展開すると事故る。
 *   必ず「知っているキーだけを拾う」。`Wallet._byId` と同じ方針。
 */
import { uint } from './limits.js';

export class ValidationError extends Error {}

/** プレーンなオブジェクトか (配列と null を弾く) */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 知らないキーを持ち込まないための取り出し。プロトタイプ経由を見に行かない */
function pick(src: unknown, key: string): unknown {
  if (!isPlainObject(src)) return undefined;
  return Object.prototype.hasOwnProperty.call(src, key) ? src[key] : undefined;
}

/* ---------------- PUT /api/save ---------------- */

export type SaveRequest = {
  /** 前回サーバがくれた rev。クライアントは自分で数字を作らない (§7.2) */
  rev: number;
  /** セーブ JSON。中身は不透明な blob として保存する (§6.2) */
  payload: Record<string, unknown>;
  /** クライアントの時計。信じない。表示用にだけ持つ */
  clientSavedAt: number;
};

export function parseSaveRequest(body: unknown): SaveRequest {
  if (!isPlainObject(body)) throw new ValidationError('body must be an object');

  const rev = pick(body, 'rev');
  if (typeof rev !== 'number' || !Number.isInteger(rev) || rev < 0) {
    throw new ValidationError('rev must be a non-negative integer');
  }

  const payload = pick(body, 'payload');
  if (!isPlainObject(payload)) throw new ValidationError('payload must be an object');

  return {
    rev,
    payload,
    clientSavedAt: uint(pick(body, 'clientSavedAt'), 0, Number.MAX_SAFE_INTEGER),
  };
}

/* ---------------- payload からランキング用の数字を切り出す ---------------- */

/**
 * クライアントが申告した数字。**この時点では一切信じていない。**
 * ここを通ったあと `plausibility.ts` が上限をかける
 */
export type ScoreClaim = {
  best: number;
  lifetimeEarned: number;
  jpWins: number;
  jpPaid: number;
};

export function extractClaim(payload: Record<string, unknown>): ScoreClaim {
  const lifetime = pick(payload, 'lifetime');
  const jp = pick(lifetime, 'jp');
  return {
    best: uint(pick(payload, 'best')),
    lifetimeEarned: uint(pick(lifetime, 'earned')),
    jpWins: uint(pick(jp, 'wins')),
    jpPaid: uint(pick(jp, 'paid')),
  };
}

/* ---------------- POST /api/transfer/redeem ---------------- */

export function parseRedeemRequest(body: unknown): string {
  const code = pick(body, 'code');
  if (typeof code !== 'string' || code.length > 32) {
    throw new ValidationError('code must be a short string');
  }
  return code;
}
