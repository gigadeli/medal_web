/**
 * スロットの絵柄。
 *
 * 絵文字をやめて SVG のパスに置き換えてある。理由は3つ:
 *   ① 絵文字は環境によって字形も色も違う。Windows と Mac で別のゲームに見える
 *   ② 液晶パネル (Canvas) と配当表 (DOM) で見た目を揃えられない
 *   ③ 3x3 になると1マスが小さくなり、絵文字の細部が潰れる
 *
 * パスは 100x100 の座標系で書き、使う側が好きな大きさに拡大する。
 * 同じデータを Canvas 2D (Path2D) と React の <svg> の両方から読むので、
 * 液晶とHUDで必ず同じ絵になる。
 *
 * part の形は3種類:
 *   { d, fill }                     塗り
 *   { d, stroke, width, cap }       線
 *   { text, size, fill }            文字 (BAR だけ)
 */

const C = (cx, cy, r) =>
  `M${cx - r} ${cy} a${r} ${r} 0 1 0 ${r * 2} 0 a${r} ${r} 0 1 0 ${-r * 2} 0`;

export const SYMBOL_ART = {
  /** ブランク。何も揃わなかったことが一目で分かる、意味を持たない棒 */
  blank: [
    { d: 'M28 43 h44 a7 7 0 0 1 0 14 h-44 a7 7 0 0 1 0-14 z', fill: 'currentColor' },
  ],

  /** リプレイ。ほぼ一周する矢印 */
  replay: [
    { d: 'M50 20 A30 30 0 1 1 22 40', stroke: 'currentColor', width: 11, cap: 'round' },
    { d: 'M40 7 L67 21 L40 35 Z', fill: 'currentColor' },
  ],

  /** チェリー。実の色だけ絵柄色に従い、軸と葉は緑で固定する */
  cherry: [
    { d: 'M52 18 C44 34 34 44 31 58', stroke: '#6fbf78', width: 6, cap: 'round' },
    { d: 'M52 18 C60 32 68 44 71 61', stroke: '#6fbf78', width: 6, cap: 'round' },
    { d: 'M52 18 C64 5 80 7 89 13 C78 26 60 28 52 18 Z', fill: '#7ee08a' },
    { d: C(30, 71, 17), fill: 'currentColor' },
    { d: C(72, 73, 15), fill: 'currentColor' },
    { d: 'M22 65 a5 6 0 1 0 10 0 a5 6 0 1 0 -10 0', fill: 'rgba(255,255,255,0.45)' },
  ],

  /** ベル */
  bell: [
    { d: C(50, 13, 6), fill: 'currentColor' },
    {
      d: 'M50 17 C67 17 74 33 74 49 C74 63 78 71 86 79 H14 C22 71 26 63 26 49 C26 33 33 17 50 17 Z',
      fill: 'currentColor',
    },
    { d: 'M38 31 C34 41 33 53 34 63', stroke: 'rgba(255,255,255,0.5)', width: 5, cap: 'round' },
    { d: C(50, 87, 8), fill: 'currentColor' },
  ],

  /** スイカ。実機と同じく切った断面ではなく、縞の入った丸ごと1個 */
  melon: [
    { d: 'M50 21 C50 12 46 9 41 8', stroke: '#3f7a2f', width: 5, cap: 'round' },
    { d: C(50, 53, 33), fill: 'currentColor' },
    { d: 'M50 20 C44 37 44 69 50 86', stroke: '#1d7a3f', width: 7, cap: 'round' },
    { d: 'M31 25 C23 41 23 65 31 81', stroke: '#1d7a3f', width: 7, cap: 'round' },
    { d: 'M69 25 C77 41 77 65 69 81', stroke: '#1d7a3f', width: 7, cap: 'round' },
    { d: 'M30 37 C34 31 40 27 46 25', stroke: 'rgba(255,255,255,0.45)', width: 5, cap: 'round' },
  ],

  /** バー。板に文字を乗せた実機そのままの形 */
  bar: [
    {
      d: 'M10 33 h80 a8 8 0 0 1 8 8 v18 a8 8 0 0 1 -8 8 h-80 a8 8 0 0 1 -8 -8 v-18 a8 8 0 0 1 8 -8 z',
      fill: 'currentColor',
    },
    { text: 'BAR', size: 26, fill: '#0b1020' },
  ],

  /** 7。赤7と青7で色だけを変える (実機と同じ) */
  seven: [
    { d: 'M25 17 H77 V31 L52 87 H30 L56 33 H25 Z', fill: 'currentColor' },
  ],
};

/** id から使うパーツを引く。赤7と青7は同じ形を共有する */
export function artOf(id) {
  if (id === 'red7' || id === 'blue7') return SYMBOL_ART.seven;
  return SYMBOL_ART[id] || SYMBOL_ART.blank;
}

/* ------------------------------------------------------------------ */
/* Canvas 2D 側                                                        */
/* ------------------------------------------------------------------ */

/** Path2D の生成はそれなりに重いので、パス文字列ごとに1つだけ作って使い回す */
const path2d = new Map();
function pathFor(d) {
  let p = path2d.get(d);
  if (!p) { p = new Path2D(d); path2d.set(d, p); }
  return p;
}

/**
 * 絵柄を1つ描く。
 * @param {CanvasRenderingContext2D} ctx
 * @param {string} id     絵柄の id
 * @param {number} cx     中心
 * @param {number} cy
 * @param {number} size   一辺の長さ (100x100 の座標系がこの大きさに収まる)
 * @param {string} color  currentColor に入る色
 * @param {number} alpha
 */
export function drawSymbol(ctx, id, cx, cy, size, color, alpha = 1) {
  const parts = artOf(id);
  const k = size / 100;

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(cx - size / 2, cy - size / 2);
  ctx.scale(k, k);

  for (const p of parts) {
    if (p.text) {
      ctx.fillStyle = p.fill === 'currentColor' ? color : p.fill;
      ctx.font = `800 ${p.size}px system-ui, "Segoe UI", sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.letterSpacing = '2px';
      ctx.fillText(p.text, 50, 51);
      ctx.letterSpacing = '0px';
      continue;
    }
    const path = pathFor(p.d);
    if (p.stroke) {
      ctx.strokeStyle = p.stroke === 'currentColor' ? color : p.stroke;
      // 線の太さは 100x100 系のままでよい。scale が掛かるので見かけは揃う
      ctx.lineWidth = p.width;
      ctx.lineCap = p.cap || 'butt';
      ctx.lineJoin = 'round';
      ctx.stroke(path);
    } else {
      ctx.fillStyle = p.fill === 'currentColor' ? color : p.fill;
      ctx.fill(path);
    }
  }
  ctx.restore();
}
