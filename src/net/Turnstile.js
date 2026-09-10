/**
 * 登録のときだけ使う bot 対策 (DESIGN_SERVER.md §15-3)
 *
 * サイトキーが未設定なら **何もしない**。開発中とセルフホストで
 * セットアップを強制しないため。本番では .env に
 *   VITE_TURNSTILE_SITE_KEY=0x...
 * を入れ、Worker 側にも `wrangler secret put TURNSTILE_SECRET` を実行する。
 *
 * 呼ばれるのはユーザーの一生に1回 (初回同期時) だけなので、
 * スクリプトも必要になってから読む。
 */
const SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY || '';
const SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

/** ここで固まるとセーブの同期ごと止まるので、必ず時間を切る */
const TIMEOUT_MS = 15000;

let scriptPromise = null;

function loadScript() {
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = SRC;
    el.async = true;
    el.onload = resolve;
    el.onerror = reject;
    document.head.appendChild(el);
  });
  return scriptPromise;
}

/**
 * @returns {Promise<string|null>} トークン。未設定・失敗・時間切れなら null。
 *   null でもサーバ側が未設定なら通る。設定済みなら弾かれる (そちらが正しい)
 */
export async function getTurnstileToken() {
  if (!SITE_KEY) return null;
  try {
    await loadScript();
    const holder = document.createElement('div');
    holder.style.cssText = 'position:fixed;left:-9999px;top:0';
    document.body.appendChild(holder);

    const token = await new Promise((resolve) => {
      const done = (v) => { clearTimeout(t); resolve(v); };
      const t = setTimeout(() => done(null), TIMEOUT_MS);
      window.turnstile.render(holder, {
        sitekey: SITE_KEY,
        // 疑わしいときだけ出す。通常のプレイヤーには何も見えない
        appearance: 'interaction-only',
        callback: done,
        'error-callback': () => done(null),
        'timeout-callback': () => done(null),
      });
    });

    holder.remove();
    return token;
  } catch {
    return null;
  }
}
