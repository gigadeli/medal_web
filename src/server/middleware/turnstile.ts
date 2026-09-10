/**
 * 登録の入口にだけ挟む bot 対策 (DESIGN_SERVER.md §15-3)
 *
 * ■ なぜ登録だけなのか
 *   無認証でユーザーを作れると、無料枠の書き込み 10万行/日 を
 *   約 33,000 リクエストで焼き切れる。`ratelimits` binding は
 *   ロケーションごと・permissive なので IP を散らされると防げない。
 *   そして §15-1 の Sybil (パーセンタイルの分母を作る攻撃) も同じ入口から来る。
 *
 *   ゲーム中の同期には挟まない。挟むと遊びが止まる。
 *
 * ■ 未設定なら素通りする
 *   `TURNSTILE_SECRET` が無いときは検証しない。開発中とセルフホストで
 *   セットアップを強制しないため。本番では
 *   `npx wrangler secret put TURNSTILE_SECRET` を必ず実行すること。
 */
import type { Env } from '../types.js';

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export async function verifyTurnstile(
  env: Env, token: unknown, ip: string | undefined
): Promise<boolean> {
  if (!env.TURNSTILE_SECRET) return true;          // 未設定 = 検証しない
  if (typeof token !== 'string' || token.length === 0 || token.length > 2048) return false;

  const form = new FormData();
  form.append('secret', env.TURNSTILE_SECRET);
  form.append('response', token);
  if (ip) form.append('remoteip', ip);

  try {
    const res = await fetch(VERIFY_URL, { method: 'POST', body: form });
    if (!res.ok) return false;
    const data = (await res.json()) as { success?: boolean };
    return data.success === true;
  } catch {
    // Turnstile が落ちているときに登録できないほうが困る、とは考えない。
    // ここを開けると §15-3 の穴がそのまま開く。閉じる側に倒す
    return false;
  }
}
