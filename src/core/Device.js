import { CFG } from '../config.js';

/**
 * 端末の判定と、そこから決まる描画品質・UI の出しわけ (DESIGN.md §12)
 *
 * ■ 出しわけてよいもの / いけないもの
 *   ここで変えるのは **描画と UI と入力だけ**。
 *   物理のパラメータ (timestep / solverIterations / maxCount / 各ギミックの
 *   当選率) には一切触れない。触った瞬間に「同じ操作をしても結果が違う台」
 *   になり、PC とモバイルで別のゲームになってしまう。
 *
 *   触ってよい: 影 / アンチエイリアス / 解像度 / ガラスの屈折 / メダルの
 *               円柱の分割数 / カメラの画角 / HUD の量
 *   触らない  : CFG.physics.* / CFG.medal の物理量 / CFG.slot / CFG.kuruun /
 *               CFG.launcher (弾道が変わると狙いが変わる)
 *
 *   メダルの分割数だけは見た目と紛らわしいが、コライダーは Rapier の
 *   cylinder で別に作っているので、いくら削っても当たり方は変わらない。
 */

const nav = typeof navigator !== 'undefined' ? navigator : {};
const UA = nav.userAgent || '';
const TOUCH_POINTS = nav.maxTouchPoints || 0;

const media = (q) => (typeof matchMedia === 'function' ? matchMedia(q).matches : false);

/** ?device=mobile / ?device=desktop で強制する。PC からモバイル版を確認するため */
const FORCED = (() => {
  try {
    const v = new URLSearchParams(location.search).get('device');
    return v === 'mobile' || v === 'desktop' ? v : null;
  } catch {
    return null;
  }
})();

/**
 * iOS / iPadOS か。
 * iPadOS 13 以降の Safari は UA が Macintosh になるので UA だけでは分からない。
 * 「Mac を名乗るのにタッチ点を持っている」= iPad とみなす。
 */
export const IS_IOS = /iP(hone|od|ad)/.test(UA) || (/Macintosh/.test(UA) && TOUCH_POINTS > 1);

/**
 * モバイル (タッチ主体の端末) か。
 *
 * UA 判定は当てにならないので、入力デバイスの性質を見る。
 * (hover: none) and (pointer: coarse) なら「指で触る画面しかない」。
 * タッチパネル付きの Windows ノートはマウスも持っているので hover: hover になり、
 * ここには入らない (= PC 扱いで正しい)。
 */
export const IS_MOBILE = FORCED
  ? FORCED === 'mobile'
  : media('(hover: none) and (pointer: coarse)') || (IS_IOS && TOUCH_POINTS > 0);

/**
 * 描画品質。IS_MOBILE から一度だけ決まる定数。
 *
 * モバイルで落としているものと、その理由:
 *
 *   shadows           影マップ 2048 の追加パス。投影する物が多く、いちばん重い
 *   antialias         MSAA。GPU 帯域を素直に食う。解像度を下げるほうが効く
 *   medalSegments     円柱の分割 24 → 12。585枚ぶんの三角形が半分になる
 *   maxPixelRatio     iPhone の DPR は 3。等倍で描くと画素数が9倍になる
 *   lcdScale          液晶のテクスチャ。1024x501 は電話の画面には過剰で、
 *                     書き直すたびに 2MB が上がる。フィーバーの映像は毎秒
 *                     何十回もそれをやるので、ここが効く
 *   videoFps          フィーバーの映像を液晶に焼き直す頻度
 */
export const QUALITY = IS_MOBILE
  ? {
      shadows: false,
      antialias: false,
      medalSegments: 12,
      lcdScale: 0.625,       // 1024x501 → 640x313 (アップロード量は 2.6分の1)
      videoFps: 24,
      maxPixelRatio: 1.5,
      // 実測で追いつかないときはここまで落とす。
      // 余裕が戻れば maxPixelRatio まで上げ直す (core/Renderer.js の _adapt)
      minPixelRatio: 0.75,
      adaptiveResolution: true,
    }
  : {
      shadows: true,
      antialias: true,
      medalSegments: CFG.medal.segments,
      lcdScale: 1,
      videoFps: CFG.fever.video.fps,
      maxPixelRatio: 2,
      minPixelRatio: 2,
      adaptiveResolution: false,
    };

/**
 * 端末に合わせた DOM 側の下ごしらえ。main() の最初に一度だけ呼ぶ。
 *
 * data-device は CSS から参照している (*.module.css の :global(html[data-device=...]))。
 * ?device= の強制がそのまま CSS にも効くよう、メディアクエリではなく属性で持つ。
 */
export function initDevice() {
  const root = document.documentElement;
  root.dataset.device = IS_MOBILE ? 'mobile' : 'desktop';
  if (!IS_MOBILE) return;

  // iOS Safari は viewport の user-scalable=no / maximum-scale を無視する
  // (アクセシビリティのため)。ピンチとダブルタップの拡大は
  // gesture イベントを止めて防ぐしかない。
  // canvas 側のスクロール・長押しメニューは CSS の touch-action / callout で殺してある
  const stop = (e) => e.preventDefault();
  document.addEventListener('gesturestart', stop, { passive: false });
  document.addEventListener('gesturechange', stop, { passive: false });
  document.addEventListener('gestureend', stop, { passive: false });
}
