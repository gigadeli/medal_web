import * as THREE from 'three';
import { CFG } from '../config.js';
import { rnd } from '../core/Rng.js';
import { drawSymbol } from '../render/SymbolArt.js';
import { LINES, buildGrid, tierOf } from './SlotLines.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SYMBOLS = CFG.slot.symbols;
const D = CFG.slot.display;
const SHOW = CFG.slot.show;
const VID = CFG.fever.video;

const TEX_W = 1024;
const TEX_H = Math.round(TEX_W * (D.height / D.width));

const FONT = '"Segoe UI", system-ui, sans-serif';

/* --- 盤面の寸法。すべてテクスチャのピクセル --- */
const CELL = 122;
const GAP = 9;
const GRID_W = CELL * 3 + GAP * 2;
const GRID_H = GRID_W;
const GRID_X = (TEX_W - GRID_W) / 2;
const GRID_Y = 50;
const SYM = 96;                       // 1マスに描く絵柄の大きさ

const cellX = (c) => GRID_X + c * (CELL + GAP);
const cellY = (r) => GRID_Y + r * (CELL + GAP);
const cellCX = (c) => cellX(c) + CELL / 2;
const cellCY = (r) => cellY(r) + CELL / 2;

/** 重み付き抽選 */
function pickWeighted(weights) {
  let total = 0;
  for (const w of weights) total += w;
  let r = rnd() * total;
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i];
    if (r <= 0) return i;
  }
  return weights.length - 1;
}

const randSym = () => (rnd() * SYMBOLS.length) | 0;
const randCol = () => [randSym(), randSym(), randSym()];

/**
 * スロットの表示装置。
 *
 * DOM のオーバーレイではなく、筐体の前面（ガラスの内側）に貼った
 * 液晶パネルとして 3D シーンの中に描く。プレイ中の盤面を覆わないのが狙い。
 *
 * 実体は Canvas 2D で毎回描き直しているテクスチャ。
 * 変化があるときだけ描き直す（`_dirty` フラグ）。
 *
 * 進行役も兼ねていて、SlotMachine からは play(res) を await するだけでよい。
 *
 * ─────────────────────────────────────────────────────────────
 * 盤面は 3列 x 3段、ペイラインは5本 (DESIGN_GIMMICKS.md §3.10)
 *
 * リールは縦に回るので、状態も cols[列][段] で持つ。1列止めると3マスが
 * 同時に確定するぶん、リーチの掛かり方が1ライン時代より賑やかになる。
 *
 * 絵柄は SVG のパス (render/SymbolArt.js) を Path2D にして描いている。
 * 同じデータを HUD の配当表も読むので、液晶とHUDで絵が食い違わない。
 * ─────────────────────────────────────────────────────────────
 *
 * ─────────────────────────────────────────────────────────────
 * 演出の骨格 (DESIGN_GIMMICKS.md §3.9)
 *
 * 実機の演出は「色で期待度を示す」という一本の約束でできている
 * （業界共通で 白 < 青 < 黄 < 緑 < 赤 < 金 < 虹。虹は大当り濃厚）。
 * ここでは黄を省いた6段を heat 0〜5 に割り当てている。
 *
 * 大事なのは色を賑やかしに振らないこと。**結果を先に決めてから、
 * その結果に応じた重みで heat を引く**ので、色と当選率が本当に対応する。
 *
 *   heat 0 白  8.6%  演出なし
 *   heat 1 青 36.2%  予告音 + 青枠
 *   heat 2 緑 59.9%  緑枠 + 擬似連1回
 *   heat 3 赤 76.0%  赤枠 + カットイン
 *   heat 4 金 85.7%  金枠 + 擬似連2回 + カットイン
 *   heat 5 虹  100%  虹枠 + フリーズ + カットイン
 *
 * 1回の流れ:
 *   予告 → 回転 → (擬似連) → 第1停止 → 第2停止
 *        → リーチなら (カットイン / フリーズ) → 第3停止 (ハズレなら滑り) → 結果
 * ─────────────────────────────────────────────────────────────
 */
export class SlotDisplay {
  constructor(scene, sound, onWin) {
    this.sound = sound;
    this.onWin = onWin || (() => {});

    // --- 表示状態 ---
    this.state = {
      playing: false,
      label: 'READY',
      cols: [randCol(), randCol(), randCol()],   // 止まっている盤面 [列][段]
      spinning: [false, false, false],
      reach: false,
      winLines: [],            // 揃ったペイライン番号
      winSymbol: -1,
      result: '',
      tone: 'idle',            // 'idle' | 'miss' | 'win' | 'big'
      // --- 演出 ---
      heat: 0,
      notice: false,           // 予告の枠を出しているか
      cutIn: 0,                // 0..1。カットインの帯の進み
      cutInLabel: '',
      freeze: 0,               // 0..1。フリーズの白フラッシュ
      slip: 0,                 // 1..0。第3リールの滑り (1コマぶん)
      slipStrip: null,         // 滑っている最中のリール帯 4コマ [新, T0, T1, T2]
      pseudo: 0,               // 擬似連の回数表示 (0 なら出さない)
    };
    // 常時表示のメーター類
    this.meters = {
      jp: CFG.jackpot.initial,
      odds: 1,
      hold: 0,
      holdMax: CFG.slot.maxQueue,
      steps: 0,
      stepsMax: CFG.fever.stepsToEnter,
      fever: 0,                // 残り秒。0 なら通常
    };
    /** フィーバー中の映像 (game/FeverVideo.js)。setVideo で挿す */
    this.video = null;

    this._spinTimer = 0;
    this._blinkTimer = 0;
    this._videoTimer = 0;
    this._dirty = true;
    this._blink = 0;

    // --- キャンバス ---
    this.canvas = document.createElement('canvas');
    this.canvas.width = TEX_W;
    this.canvas.height = TEX_H;
    this.ctx = this.canvas.getContext('2d');

    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 4;

    // --- メッシュ ---
    this.group = new THREE.Group();
    this.group.position.set(D.x, D.y, D.z);
    scene.add(this.group);

    const screen = new THREE.Mesh(
      new THREE.PlaneGeometry(D.width, D.height),
      new THREE.MeshBasicMaterial({ map: this.texture, toneMapped: false })
    );
    this.group.add(screen);

    // ベゼル。演出中は heat の色で光らせるので、マテリアルを持っておく
    this.bezelMat = new THREE.MeshStandardMaterial({
      color: 0x8b97ad, metalness: 0.9, roughness: 0.3,
      emissive: 0x000000, emissiveIntensity: 1.0,
    });
    const t = 0.22;
    const frames = [
      [0, D.height / 2 + t / 2, D.width + t * 2, t],
      [0, -D.height / 2 - t / 2, D.width + t * 2, t],
      [-D.width / 2 - t / 2, 0, t, D.height],
      [D.width / 2 + t / 2, 0, t, D.height],
    ];
    for (const [x, y, w, h] of frames) {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.16), this.bezelMat);
      bar.position.set(x, y, -0.05);
      this.group.add(bar);
    }

    this._draw();
  }

  /** フィーバー中に背景へ流す映像を挿す (game/FeverVideo.js) */
  setVideo(video) { this.video = video; }

  /**
   * 常時表示のメーターを更新する。
   * 値が1つも変わっていなければ描き直さない (毎フレーム呼んでよい)
   */
  setMeters(patch) {
    let changed = false;
    for (const k in patch) {
      if (this.meters[k] !== patch[k]) { this.meters[k] = patch[k]; changed = true; }
    }
    if (changed) this._dirty = true;
  }

  /* ------------------------------------------------------------------ */
  /* 描画                                                                */
  /* ------------------------------------------------------------------ */

  _roundRect(x, y, w, h, r) {
    const c = this.ctx;
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }

  /** #rrggbb に不透明度を足す */
  _alphaHex(hex, a) {
    const v = Math.round(Math.max(0, Math.min(1, a)) * 255);
    return hex + v.toString(16).padStart(2, '0');
  }

  /** 絵柄を1つ描く */
  _sym(index, cx, cy, alpha = 1) {
    const s = SYMBOLS[index] || SYMBOLS[0];
    drawSymbol(this.ctx, s.id, cx, cy, SYM, s.color, alpha);
  }

  _draw() {
    const c = this.ctx;
    const s = this.state;
    const m = this.meters;
    const fever = m.fever > 0;
    const heatColor = SHOW.colors[s.heat] || SHOW.colors[0];

    c.clearRect(0, 0, TEX_W, TEX_H);
    c.fillStyle = fever ? '#180a04' : '#070b14';
    c.fillRect(0, 0, TEX_W, TEX_H);

    // フィーバー中は背景に映像を流す。
    // **別の板に貼ってはいけない**。液晶は手前のガラスの裏にあるので、
    // 透過を使った瞬間にガラス越しで消える (§3.11 の実測)。
    // この canvas に不透明のまま焼き込めば、その制約に触れない
    this._drawVideo();

    // 上下のうっすらした光
    const g = c.createLinearGradient(0, 0, 0, TEX_H);
    if (fever) {
      const p = 0.16 + 0.12 * Math.sin(this._blink * 8);
      g.addColorStop(0, `rgba(255,176,58,${p})`);
      g.addColorStop(0.55, 'rgba(0,0,0,0)');
      g.addColorStop(1, `rgba(255,77,94,${p})`);
    } else {
      g.addColorStop(0, 'rgba(92,200,255,0.10)');
      g.addColorStop(0.5, 'rgba(0,0,0,0)');
      g.addColorStop(1, 'rgba(255,176,58,0.08)');
    }
    c.fillStyle = g;
    c.fillRect(0, 0, TEX_W, TEX_H);

    c.textBaseline = 'middle';

    this._drawHeader(fever, heatColor);
    this._drawSideMeters();
    this._drawGrid(heatColor);
    this._drawWinLines();
    this._drawResult();

    // --- 演出のオーバーレイ ---
    this._drawNotice(heatColor);
    this._drawCutIn(heatColor);
    this._drawFreeze();

    this.texture.needsUpdate = true;
    this._dirty = false;
  }

  /**
   * フィーバーの映像を背景に敷く。
   *
   * 液晶は 2.04:1 と横に長い。素材の縦横比に関わらず帯を出したくないので、
   * はみ出すぶんを切る「cover」で貼る。
   * そのままだとリールも数字も読めないので、上に黒を敷いてから本体を描く。
   */
  _drawVideo() {
    const v = this.video && this.video.frame;
    if (!v) return;
    const c = this.ctx;
    const scale = Math.max(TEX_W / v.videoWidth, TEX_H / v.videoHeight);
    const w = v.videoWidth * scale;
    const h = v.videoHeight * scale;
    c.drawImage(v, (TEX_W - w) / 2, (TEX_H - h) / 2, w, h);
    c.fillStyle = `rgba(0,0,0,${VID.dim})`;
    c.fillRect(0, 0, TEX_W, TEX_H);

    // 左右の端をさらに落とす。盤面 (幅 384) の外はメーターの置き場で、
    // 明るい映像が来ると数字が読めない。中央は明るいまま残したいので端だけ
    const e = VID.edge;
    const scrim = (x0, x1) => {
      const gr = c.createLinearGradient(x0, 0, x1, 0);
      gr.addColorStop(0, `rgba(0,0,0,${VID.edgeDim})`);
      // メーターが載っているのは端から 210px ほど。そこまでは濃さを保ち、
      // 盤面 (320px から) までの残りで一気に抜く。
      // 直線に落とすと数字に掛かるころには薄くなっていて読めない (実測)
      gr.addColorStop(0.65, `rgba(0,0,0,${VID.edgeDim * 0.92})`);
      gr.addColorStop(1, 'rgba(0,0,0,0)');
      return gr;
    };
    c.fillStyle = scrim(0, e);
    c.fillRect(0, 0, e, TEX_H);
    c.fillStyle = scrim(TEX_W, TEX_W - e);
    c.fillRect(TEX_W - e, 0, e, TEX_H);
  }

  /** 最上段。いま何の演出中なのかだけを大きく出す */
  _drawHeader(fever, heatColor) {
    const c = this.ctx;
    const s = this.state;
    const m = this.meters;

    c.textAlign = 'center';
    c.font = `600 26px ${FONT}`;
    c.fillStyle = fever ? '#ffb03a'
      : (s.heat > 0 && s.playing ? heatColor : (s.tone === 'big' ? '#ffcf5c' : '#8ea0c0'));
    c.letterSpacing = '9px';
    const label = fever ? `FEVER ${Math.ceil(m.fever)}` : s.label;
    c.fillText(label, TEX_W / 2, 26);
    c.letterSpacing = '0px';
  }

  /**
   * 左右のメーター。
   *
   * 3x3 にすると盤面が縦に伸びる。メーター類まで上下に置いたままだと
   * パネルの背が高くなりすぎて上段デッキか HUD のどちらかに掛かるので、
   * 盤面の左右にできた余白へ逃がしてある。おかげで背は 0.82 しか伸びていない
   */
  _drawSideMeters() {
    const c = this.ctx;
    const m = this.meters;
    const L = 28;                 // 左の基準
    const R = TEX_W - 28;         // 右の基準

    const cap = (text, x, y, align) => {
      c.textAlign = align;
      c.font = `600 16px ${FONT}`;
      c.fillStyle = '#7f8fae';
      c.letterSpacing = '4px';
      c.fillText(text, x, y);
      c.letterSpacing = '0px';
    };

    // --- 左上: ジャックポット ---
    cap('JACKPOT', L, 108, 'left');
    c.textAlign = 'left';
    c.font = `700 42px ${FONT}`;
    c.fillStyle = '#ffcf5c';
    c.shadowColor = 'rgba(255,176,58,0.75)';
    c.shadowBlur = 16;
    c.fillText(String(Math.floor(m.jp)), L, 148);
    c.shadowBlur = 0;

    // --- 左下: 倍率 ---
    const hot = m.odds > 1;
    cap('ODDS', L, 258, 'left');
    c.textAlign = 'left';
    c.font = `700 42px ${FONT}`;
    c.fillStyle = hot ? '#ff9f4d' : 'rgba(140,165,210,0.35)';
    if (hot) { c.shadowColor = 'rgba(255,159,77,0.8)'; c.shadowBlur = 14; }
    c.fillText(`x${m.odds}`, L, 298);
    c.shadowBlur = 0;

    // --- 右上: フィーバーまでのステップ ---
    cap('STEP', R, 108, 'right');
    for (let i = 0; i < m.stepsMax; i++) {
      const lit = i < m.steps;
      const cx = R - (m.stepsMax - 1 - i) * 34 - 12;
      c.beginPath();
      c.arc(cx, 146, 11, 0, Math.PI * 2);
      c.fillStyle = lit ? '#ffb03a' : 'rgba(140,165,210,0.18)';
      c.fill();
      if (lit) {
        c.strokeStyle = 'rgba(255,207,92,0.9)';
        c.lineWidth = 3;
        c.stroke();
      }
    }

    // --- 右下: 保留 ---
    cap('HOLD', R, 258, 'right');
    for (let i = 0; i < m.holdMax; i++) {
      const lit = i < m.hold;
      const cx = R - (m.holdMax - 1 - i) * 34 - 12;
      c.beginPath();
      c.arc(cx, 296, 11, 0, Math.PI * 2);
      c.fillStyle = lit ? '#5cc8ff' : 'rgba(140,165,210,0.18)';
      c.fill();
      if (lit) {
        c.strokeStyle = 'rgba(92,200,255,0.9)';
        c.lineWidth = 3;
        c.stroke();
      }
    }
  }

  /** 3列 x 3段の盤面 */
  _drawGrid(heatColor) {
    const c = this.ctx;
    const s = this.state;

    // 盤面全体の下敷き。マスの隙間から背景が透けると落ち着かない
    c.fillStyle = 'rgba(10,14,24,0.75)';
    this._roundRect(GRID_X - 12, GRID_Y - 12, GRID_W + 24, GRID_H + 24, 22);
    c.fill();

    // 当たったマスは後で強調するので、先に印を集めておく
    const litCell = [[false, false, false], [false, false, false], [false, false, false]];
    for (const li of s.winLines) {
      const L = LINES[li];
      for (let col = 0; col < 3; col++) litCell[col][L[col]] = true;
    }
    const flash = 0.55 + 0.45 * Math.sin(this._blink * 9);

    // マスの下地は段ごとに同じ。9個作ると点滅のたびに捨てるゴミが増えるので3個で使い回す
    const rowGrad = [];
    for (let row = 0; row < 3; row++) {
      const by = cellY(row);
      const grad = c.createLinearGradient(0, by, 0, by + CELL);
      grad.addColorStop(0, '#202a40');
      grad.addColorStop(1, '#0f1420');
      rowGrad.push(grad);
    }

    for (let col = 0; col < 3; col++) {
      // リーチが掛かっている間は最後の列だけ枠を光らせる。色は heat に従う
      const reaching = s.reach && col === 2 && s.spinning[2];

      for (let row = 0; row < 3; row++) {
        const bx = cellX(col);
        const by = cellY(row);
        const lit = litCell[col][row];

        c.fillStyle = rowGrad[row];
        this._roundRect(bx, by, CELL, CELL, 16);
        c.fill();

        if (lit) {
          c.fillStyle = `rgba(255,207,92,${0.10 + 0.12 * flash})`;
          c.fill();
        }

        c.lineWidth = lit || reaching ? 5 : 2;
        c.strokeStyle = lit
          ? `rgba(255,207,92,${0.45 + 0.55 * flash})`
          : reaching
            ? this._alphaHex(heatColor, 0.55 + 0.45 * Math.sin(this._blink * 9))
            : 'rgba(140,165,210,0.22)';
        c.stroke();
      }

      // 絵柄。滑っている最中の3列目だけ、リール帯を4コマぶん流す
      c.save();
      this._roundRect(GRID_X, GRID_Y, GRID_W, GRID_H, 16);
      c.clip();
      if (col === 2 && s.slip > 0 && s.slipStrip) {
        // slip は 1→0。shift が 0→1 で帯が1コマぶん下がる。
        // shift=0 で [T0,T1,T2] (揃っていた窓)、shift=1 で [新,T0,T1] (実際の出目)
        const shift = 1 - s.slip;
        for (let i = 0; i < 4; i++) {
          const y = cellCY(0) + (i - 1 + shift) * (CELL + GAP);
          this._sym(s.slipStrip[i], cellCX(2), y, 1);
        }
      } else {
        for (let row = 0; row < 3; row++) {
          this._sym(s.cols[col][row], cellCX(col), cellCY(row), s.spinning[col] ? 0.6 : 1);
        }
      }
      c.restore();
    }
  }

  /** 揃ったラインを1本の線で串刺しにする。どこで当たったのかを一目で示す */
  _drawWinLines() {
    const s = this.state;
    if (!s.winLines.length) return;
    const c = this.ctx;
    const sym = SYMBOLS[s.winSymbol] || SYMBOLS[0];
    const pulse = 0.5 + 0.5 * Math.sin(this._blink * 9);

    c.save();
    c.lineCap = 'round';
    c.lineJoin = 'round';
    for (const li of s.winLines) {
      const L = LINES[li];
      c.beginPath();
      c.moveTo(cellCX(0), cellCY(L[0]));
      c.lineTo(cellCX(1), cellCY(L[1]));
      c.lineTo(cellCX(2), cellCY(L[2]));

      c.strokeStyle = `rgba(255,255,255,${0.25 + 0.35 * pulse})`;
      c.lineWidth = 14;
      c.shadowColor = sym.color;
      c.shadowBlur = 26;
      c.stroke();

      c.strokeStyle = sym.color;
      c.lineWidth = 5;
      c.shadowBlur = 0;
      c.stroke();
    }
    c.restore();
  }

  /** 盤面の下に出す結果 */
  _drawResult() {
    const s = this.state;
    if (!s.result) return;
    const c = this.ctx;

    c.textAlign = 'center';
    c.font = `700 32px ${FONT}`;
    if (s.tone === 'big') {
      c.fillStyle = `rgba(255,255,255,${0.55 + 0.45 * Math.sin(this._blink * 11)})`;
      c.shadowColor = 'rgba(255,176,58,0.9)';
      c.shadowBlur = 26;
    } else if (s.tone === 'win') {
      c.fillStyle = '#ffcf5c';
    } else {
      c.fillStyle = '#8ea0c0';
    }
    c.fillText(s.result, TEX_W / 2, GRID_Y + GRID_H + 32);
    c.shadowBlur = 0;
  }

  /** 予告の枠。heat の色で画面の縁を光らせる */
  _drawNotice(color) {
    const s = this.state;
    if (!s.notice || s.heat <= 0) return;
    const c = this.ctx;
    const pulse = 0.55 + 0.45 * Math.sin(this._blink * 7);
    c.save();
    c.globalAlpha = pulse;
    c.strokeStyle = color;
    c.lineWidth = 10;
    c.strokeRect(5, 5, TEX_W - 10, TEX_H - 10);
    // 虹だけは内側にもう1本引いて「別格」に見せる
    if (s.heat >= 5) {
      c.globalAlpha = pulse * 0.8;
      c.lineWidth = 4;
      c.strokeStyle = '#ffffff';
      c.strokeRect(20, 20, TEX_W - 40, TEX_H - 40);
    }
    c.restore();
  }

  /** カットイン。画面を斜めに横切る帯 */
  _drawCutIn(color) {
    const s = this.state;
    if (s.cutIn <= 0) return;
    const c = this.ctx;
    // 0→1 で左から右へ抜ける。中央付近でいちばん濃い
    const p = s.cutIn;
    const x = -TEX_W * 0.6 + p * TEX_W * 1.9;
    const alpha = Math.sin(Math.min(1, p) * Math.PI);

    c.save();
    c.globalAlpha = alpha;
    c.translate(x, 0);
    c.transform(1, 0, -0.35, 1, 0, 0);   // 斜めに倒す
    const grad = c.createLinearGradient(0, 0, TEX_W * 0.55, 0);
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(0.5, color);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = grad;
    c.fillRect(0, TEX_H * 0.18, TEX_W * 0.55, TEX_H * 0.64);
    c.restore();

    if (s.cutInLabel) {
      c.save();
      c.globalAlpha = alpha;
      c.textAlign = 'center';
      c.font = `800 62px ${FONT}`;
      c.fillStyle = '#ffffff';
      c.shadowColor = color;
      c.shadowBlur = 30;
      c.letterSpacing = '6px';
      c.fillText(s.cutInLabel, TEX_W / 2, TEX_H / 2);
      c.letterSpacing = '0px';
      c.restore();
    }
  }

  /** フリーズ。全部止まって白く飛ぶ */
  _drawFreeze() {
    const s = this.state;
    if (s.freeze <= 0) return;
    const c = this.ctx;
    c.save();
    c.globalAlpha = Math.min(1, s.freeze) * 0.85;
    c.fillStyle = '#ffffff';
    c.fillRect(0, 0, TEX_W, TEX_H);
    c.globalAlpha = 1;
    c.textAlign = 'center';
    c.font = `800 64px ${FONT}`;
    c.fillStyle = '#101828';
    c.letterSpacing = '14px';
    c.fillText('FREEZE', TEX_W / 2, TEX_H / 2);
    c.letterSpacing = '0px';
    c.restore();
  }

  /** 描画フレームごとに呼ぶ。回転とちらつきの更新だけを行う */
  update(dt) {
    const s = this.state;
    const anySpin = s.spinning[0] || s.spinning[1] || s.spinning[2];
    const anyBlink = (s.reach && s.spinning[2]) || s.tone === 'big'
      || s.winLines.length > 0 || s.notice || this.meters.fever > 0;

    if (anySpin) {
      this._spinTimer += dt;
      if (this._spinTimer >= 0.055) {
        this._spinTimer = 0;
        for (let col = 0; col < 3; col++) {
          if (s.spinning[col]) s.cols[col] = randCol();
        }
        this._dirty = true;
      }
    }
    if (anyBlink) {
      // 位相は実時間で進める。滑らかさが要るのはここだけ
      this._blink += dt;
      // ただし **描き直しは間引く**。点滅のためだけに 1024x501 を毎フレーム
      // 描き直してテクスチャを再アップロードすると、当たりのたび (全回転の 38.7%)
      // に数ms/フレームが乗る。リールの回転と同じ 18Hz で十分見える
      this._blinkTimer += dt;
      if (this._blinkTimer >= 0.055) { this._blinkTimer = 0; this._dirty = true; }
    } else {
      this._blinkTimer = 0;
    }

    // フィーバーの映像。点滅の 18Hz では動画がカクつくので、
    // 流れている間だけ描き直しを速める (§3.3)
    if (this.video && this.video.playing) {
      this._videoTimer += dt;
      if (this._videoTimer >= 1 / VID.fps) { this._videoTimer = 0; this._dirty = true; }
    } else {
      this._videoTimer = 0;
    }

    // カットイン・フリーズ・滑りは秒で進める
    if (s.cutIn > 0) {
      s.cutIn += dt / (SHOW.cutInMs / 1000);
      if (s.cutIn >= 1) { s.cutIn = 0; s.cutInLabel = ''; }
      this._dirty = true;
    }
    if (s.freeze > 0) {
      s.freeze -= dt / (SHOW.freezeMs / 1000) * 1.6;
      if (s.freeze < 0) s.freeze = 0;
      this._dirty = true;
    }
    if (s.slip > 0) {
      s.slip -= dt / (SHOW.slipMs / 1000);
      if (s.slip <= 0) { s.slip = 0; s.slipStrip = null; }
      this._dirty = true;
    }

    if (this._dirty) this._draw();
  }

  /* ------------------------------------------------------------------ */
  /* 進行                                                                */
  /* ------------------------------------------------------------------ */

  /** 1列 (3マス) をまとめて止める */
  _stopReel(col, values) {
    this.state.cols[col] = values.slice();
    this.state.spinning[col] = false;
    this._dirty = true;
    this.sound.reelStop();
  }

  /** heat（期待度）を引く。結果を先に決めてから、その格に応じた重みで引く */
  _pickHeat(res) {
    const w = SHOW.weights[tierOf(res)] || SHOW.weights.miss;
    return pickWeighted(w);
  }

  /** 擬似連。中段が揃いかけて、また回り出す */
  async _pseudo(times) {
    const s = this.state;
    for (let i = 1; i <= times; i++) {
      const chance = randSym();
      // 中段の3マスだけ揃えて「あと一歩」に見せる
      s.cols = [
        [randSym(), chance, randSym()],
        [randSym(), chance, randSym()],
        [randSym(), chance, randSym()],
      ];
      s.spinning = [false, false, false];
      s.pseudo = i;
      s.label = `CHANCE x${i + 1}`;
      this._dirty = true;
      this.sound.pseudo(i);
      await sleep(SHOW.pseudoMs * 0.55);
      s.spinning = [true, true, true];
      this._dirty = true;
      await sleep(SHOW.pseudoMs * 0.45);
    }
    s.pseudo = 0;
  }

  /** SlotMachine から await される */
  async play(res) {
    const s = this.state;
    const { cols, winLines, reach, tease } = buildGrid(res);
    const heat = this._pickHeat(res);
    const tier = tierOf(res);

    s.playing = true;
    s.heat = heat;
    s.reach = false;
    s.winLines = [];
    s.winSymbol = -1;
    s.result = '';
    s.tone = 'idle';
    s.cutIn = 0; s.freeze = 0; s.slip = 0; s.slipStrip = null; s.pseudo = 0;
    this._blink = 0;

    // ── ① 予告。heat 0 は無演出（実機も「無演出だから外れ」ではない）
    if (heat > 0) {
      s.notice = true;
      s.label = SHOW.names[heat] || 'CHANCE';
      s.spinning = [false, false, false];
      this._dirty = true;
      this.sound.notice(heat);
      this.bezelMat.emissive.set(SHOW.colors[heat]);
      await sleep(SHOW.noticeMs);
    } else {
      s.notice = false;
      s.label = 'CHANCE';
    }

    // ── ② 回転
    s.spinning = [true, true, true];
    this._dirty = true;
    await sleep(520);

    // ── ③ 擬似連
    const pseudo = SHOW.pseudoAt[heat] || 0;
    if (pseudo > 0) {
      await this._pseudo(pseudo);
      // 連数の表示を残したままリーチに入ると何の演出中か分からなくなる
      s.label = SHOW.names[heat] || 'CHANCE';
      this._dirty = true;
    }

    // ── ④ 第1・第2停止。1列で3マス確定するので、リーチの掛かり方が賑やかになる
    this._stopReel(0, cols[0]);
    await sleep(420);
    this._stopReel(1, cols[1]);

    if (reach) {
      s.reach = true;
      this._dirty = true;
      this.sound.reach();

      // ── ⑤ カットイン
      if (heat >= SHOW.cutInAt) {
        s.cutIn = 0.001;
        s.cutInLabel = SHOW.names[heat] || '';
        this._dirty = true;
        this.sound.cutIn(heat);
        await sleep(SHOW.cutInMs * 0.75);
      }

      // ── ⑥ フリーズ。ここまで来たら当たり濃厚
      if (heat >= SHOW.freezeAt) {
        s.freeze = 1;
        s.label = 'FREEZE';
        this._dirty = true;
        this.sound.freeze();
        await sleep(SHOW.freezeMs);
      }

      // 引っ張りの長さは格で変える。大きい役ほど長く待たせる
      const pull = tier === 'big' || tier === 'jp' ? 2 : heat >= 3 ? 1 : 0;
      await sleep(SHOW.reachMs[pull]);
    } else {
      await sleep(420);
    }

    // ── ⑦ 第3停止。ハズレのリーチは「滑り」で、揃っていた窓を一瞬だけ見せる。
    //     見た目のごまかしではなく、本当にリール帯を1コマ送っている
    if (reach && !res.win && tease) {
      s.slipStrip = [cols[2][0], tease[0], tease[1], tease[2]];
      s.slip = 1;
      this.sound.slip();
    }
    this._stopReel(2, cols[2]);

    // ── ⑧ 結果
    s.notice = false;
    this.bezelMat.emissive.setHex(0x000000);

    if (res.win) {
      s.winLines = winLines;
      s.winSymbol = res.index;
      this._dirty = true;
    }

    if (res.jp) {
      s.tone = 'big';
      s.result = 'JACKPOT!!';
      s.label = 'JACKPOT';
      this._dirty = true;
      this.onWin(res.index);
      this.sound.jackpot();
      await sleep(2600);
    } else if (res.win) {
      // 大当たり扱いにするかどうか。2つの条件の OR にしてある。
      //
      //   ① 格が big (バー / 赤7)
      //      amount だけで見ると、1ラインあたりの pay を削ったときに
      //      「最長のリーチで煽ってから中位役の扱いで落ちる」ずれが起きる。
      //      赤7の85%は1ライン = 44枚で、旧閾値 60 に届かなかった
      //   ② 枚数が伸びた回 (多ライン / 高倍率)。格が下でも手応えは大きい
      //
      // 枚数の閾値は 3x3 化で pay を約2/3に削ったぶん、同じ比率で下げてある
      // (60 → 40 / 150 → 100 / 12 → 8)。旧構成と同じ頻度で鳴る
      const big = tier === 'big' || res.amount >= 40;
      s.tone = big ? 'big' : 'win';
      const mul = res.odds > 1 ? ` x${res.odds}` : '';
      const ln = res.lines > 1 ? ` ${res.lines}LINE` : '';
      s.result = `${res.symbol.name}${ln}${mul}  +${res.amount}`;
      this._dirty = true;
      this.onWin(res.index);
      if (res.amount >= 100) this.sound.jackpot();
      else this.sound.win(big ? 2 : res.amount >= 8 ? 1 : 0);
      await sleep(big ? 2400 : 1400);
    } else {
      s.tone = 'miss';
      s.result = 'MISS';
      this._dirty = true;
      this.sound.lose();
      await sleep(650);
    }

    // 待機表示に戻す。出目はそのまま残しておくと「さっき何が出たか」が分かる
    s.playing = false;
    s.label = 'READY';
    s.reach = false;
    s.tone = 'idle';
    s.result = '';
    s.heat = 0;
    s.winLines = [];
    s.winSymbol = -1;
    this._dirty = true;
  }
}
