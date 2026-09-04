/**
 * 乱数の入口。ゲーム内の乱数はすべてここを通す。
 *
 * ■ なぜ Math.random を直接使わないか
 *   Math.random はページの誰でも差し替えられる。実測で、コンソールに
 *
 *     Math.random = () => 0.9999
 *
 *   と1行入れるだけでスロットが **5回中5回ジャックポット** になった。
 *   重み付き抽選が「合計1000の目盛から引く」形なので、1.0 に近い値を返させると
 *   必ず最後の絵柄（青7 = JP当選）に落ちるため。
 *
 *   そこで Math.random に依存しない自前の PRNG を持ち、
 *   種だけ crypto.getRandomValues から取る。状態はモジュール内に閉じているので、
 *   window.game を落としてあれば（本番ビルド）コンソールからは触れない。
 *
 * ■ これは「防御」ではない
 *   バンドルを書き換えられたら終わりだし、devtools でヒープを覗く手もある。
 *   完全にクライアントで動くゲームである以上、チートは原理的に防げない。
 *   ここでやっているのは「コンソールから1行」という手軽さを潰すことだけ。
 *   本気で守るならサーバ権威にするしかない（DESIGN_SECURITY.md §8）。
 *
 * ■ アルゴリズム
 *   sfc32。ゲーム用途には十分な品質で、状態32bit×4と軽い。
 *   暗号用途には使わないこと（種は暗号乱数だが、出力は予測可能）。
 */

/** 種を作る。crypto が無い環境でも起動だけはできるようにしておく */
function makeSeed() {
  const s = new Uint32Array(4);
  try {
    if (globalThis.crypto && typeof globalThis.crypto.getRandomValues === 'function') {
      globalThis.crypto.getRandomValues(s);
      // 全ゼロだと sfc32 が縮退するので、ありえないが念のため
      if (s[0] || s[1] || s[2] || s[3]) return s;
    }
  } catch {
    /* 非セキュアコンテキストなど。下のフォールバックへ */
  }
  // フォールバック。種の質は落ちるが、ゲームの体感には影響しない
  const t = Date.now();
  s[0] = t >>> 0;
  s[1] = (t / 0x100000000) >>> 0 || 0x9e3779b9;
  s[2] = (performance.now() * 1000) >>> 0 || 0x85ebca6b;
  s[3] = 0xc2b2ae35;
  return s;
}

const seed = makeSeed();
let a = seed[0] | 0;
let b = seed[1] | 0;
let c = seed[2] | 0;
let d = seed[3] | 0;

/** @returns {number} 0 以上 1 未満 */
export function rnd() {
  const t = (((a + b) | 0) + d) | 0;
  d = (d + 1) | 0;
  a = b ^ (b >>> 9);
  b = (c + (c << 3)) | 0;
  c = (c << 21) | (c >>> 11);
  c = (c + t) | 0;
  return (t >>> 0) / 4294967296;
}

/** -0.5 以上 0.5 未満。「少し散らす」用途が多いので用意しておく */
export function rndSigned() {
  return rnd() - 0.5;
}

/** min 以上 max 未満 */
export function rndRange(min, max) {
  return min + rnd() * (max - min);
}

/** 0 以上 n 未満の整数 */
export function rndInt(n) {
  return (rnd() * n) | 0;
}

// 起動直後の出力の偏りを捨てる（sfc32 の慣例）
for (let i = 0; i < 12; i++) rnd();
