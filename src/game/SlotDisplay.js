import * as THREE from 'three';
import { CFG } from '../config.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SYMBOLS = CFG.slot.symbols;
const D = CFG.slot.display;
const SHOW = CFG.slot.show;

const TEX_W = 1024;
const TEX_H = Math.round(TEX_W * (D.height / D.width));

/** 絵柄と文字が両方出るフォント指定 */
const FONT = '"Noto Color Emoji", "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI", system-ui, sans-serif';

/** 役の格。heat の重みを選ぶのに使う (DESIGN_GIMMICKS.md §3.9) */
function tierOf(res) {
  if (res.jp) return 'jp';
  if (!res.win) return 'miss';
  const id = res.symbol.id;
  if (id === 'bar' || id === 'red7') return 'big';
  if (id === 'bell' || id === 'melon') return 'mid';
  return 'small';
}

/** 重み付き抽選 */
function pickWeighted(weights) {
  let total = 0;
  for (const w of weights) total += w;
  let r = Math.random() * total;
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i];
    if (r <= 0) return i;
  }
  return weights.length - 1;
}

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
      symbols: [7, 6, 5],      // 止まっている絵柄 (SYMBOLS のインデックス)
      spinning: [false, false, false],
      reach: false,
      result: '',
      tone: 'idle',            // 'idle' | 'miss' | 'win' | 'big'
      // --- 演出 ---
      heat: 0,
      notice: false,           // 予告の枠を出しているか
      cutIn: 0,                // 0..1。カットインの帯の進み
      cutInLabel: '',
      freeze: 0,               // 0..1。フリーズの白フラッシュ
      slip: 0,                 // 0..1。第3リールの滑り
      slipFrom: 0,             // 滑る前に見せる絵柄
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
      tilt: 0,
    };
    this._spinTimer = 0;
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

  /** 絵柄を1つ描く */
  _glyph(sym, cx, cy, alpha = 1) {
    const c = this.ctx;
    c.fillStyle = sym.color;
    c.globalAlpha = alpha;
    c.font = sym.glyph.length > 1 ? `700 56px ${FONT}` : `700 100px ${FONT}`;
    c.fillText(sym.glyph, cx, cy);
    c.globalAlpha = 1;
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

    // --- 1段目: 左 JP / 中央 ラベル / 右 STEP ---
    const rowY = 30;

    c.textAlign = 'left';
    c.font = `600 17px ${FONT}`;
    c.fillStyle = '#7f8fae';
    c.letterSpacing = '4px';
    c.fillText('JACKPOT', 26, rowY - 12);
    c.letterSpacing = '0px';
    c.font = `700 40px ${FONT}`;
    c.fillStyle = '#ffcf5c';
    c.shadowColor = 'rgba(255,176,58,0.75)';
    c.shadowBlur = 16;
    c.fillText(String(Math.floor(m.jp)), 26, rowY + 22);
    c.shadowBlur = 0;

    c.textAlign = 'center';
    c.font = `600 28px ${FONT}`;
    c.fillStyle = fever ? '#ffb03a' : (s.heat > 0 && s.playing ? heatColor : (s.tone === 'big' ? '#ffcf5c' : '#8ea0c0'));
    c.letterSpacing = '9px';
    const label = m.tilt > 0 ? `TILT ${Math.ceil(m.tilt)}`
      : fever ? `FEVER ${Math.ceil(m.fever)}` : s.label;
    c.fillText(label, TEX_W / 2, rowY + 4);
    c.letterSpacing = '0px';

    c.textAlign = 'right';
    c.font = `600 17px ${FONT}`;
    c.fillStyle = '#7f8fae';
    c.letterSpacing = '4px';
    c.fillText('STEP', TEX_W - 26, rowY - 12);
    c.letterSpacing = '0px';
    for (let i = 0; i < m.stepsMax; i++) {
      const lit = i < m.steps;
      const cx = TEX_W - 26 - (m.stepsMax - 1 - i) * 34 - 12;
      c.beginPath();
      c.arc(cx, rowY + 22, 11, 0, Math.PI * 2);
      c.fillStyle = lit ? '#ffb03a' : 'rgba(140,165,210,0.18)';
      c.fill();
      if (lit) {
        c.strokeStyle = 'rgba(255,207,92,0.9)';
        c.lineWidth = 3;
        c.stroke();
      }
    }

    // --- リール ---
    const boxW = 168, boxH = 168, gap = 24;
    const totalW = boxW * 3 + gap * 2;
    const x0 = (TEX_W - totalW) / 2;
    const y0 = 74;

    c.textAlign = 'center';
    for (let i = 0; i < 3; i++) {
      const bx = x0 + i * (boxW + gap);
      const grad = c.createLinearGradient(0, y0, 0, y0 + boxH);
      grad.addColorStop(0, '#202a40');
      grad.addColorStop(1, '#0f1420');
      c.fillStyle = grad;
      this._roundRect(bx, y0, boxW, boxH, 18);
      c.fill();

      // リーチ中の3番目だけ枠を光らせる。色は heat に従う
      const reaching = s.reach && i === 2 && s.spinning[2];
      c.lineWidth = reaching ? 6 : 2;
      c.strokeStyle = reaching
        ? `${heatColor}${Math.round((0.55 + 0.45 * Math.sin(this._blink * 9)) * 255).toString(16).padStart(2, '0')}`
        : 'rgba(140,165,210,0.25)';
      c.stroke();

      // 絵柄。滑っている最中の3番目だけ2枚描く
      c.save();
      this._roundRect(bx, y0, boxW, boxH, 18);
      c.clip();
      const cx = bx + boxW / 2;
      const cy = y0 + boxH / 2 + 6;
      if (i === 2 && s.slip > 0) {
        const dy = s.slip * boxH;
        this._glyph(SYMBOLS[s.slipFrom] || SYMBOLS[0], cx, cy - dy, 1);
        this._glyph(SYMBOLS[s.symbols[2]] || SYMBOLS[0], cx, cy - dy + boxH, 1);
      } else {
        this._glyph(SYMBOLS[s.symbols[i]] || SYMBOLS[0], cx, cy, s.spinning[i] ? 0.6 : 1);
      }
      c.restore();
    }

    // --- 3段目: 左 倍率 / 中央 保留 / 右 結果 ---
    const botY = y0 + boxH + 34;

    c.textAlign = 'left';
    const hot = m.odds > 1;
    c.font = `700 30px ${FONT}`;
    c.fillStyle = hot ? '#ff9f4d' : 'rgba(140,165,210,0.35)';
    if (hot) { c.shadowColor = 'rgba(255,159,77,0.8)'; c.shadowBlur = 14; }
    c.fillText(`ODDS x${m.odds}`, 26, botY);
    c.shadowBlur = 0;

    for (let i = 0; i < m.holdMax; i++) {
      const cx = TEX_W / 2 - ((m.holdMax - 1) / 2) * 26 + i * 26;
      c.beginPath();
      c.arc(cx, botY, 8, 0, Math.PI * 2);
      c.fillStyle = i < m.hold ? '#5cc8ff' : 'rgba(140,165,210,0.18)';
      c.fill();
    }

    if (s.result) {
      c.textAlign = 'right';
      c.font = `700 34px ${FONT}`;
      if (s.tone === 'big') {
        c.fillStyle = `rgba(255,255,255,${0.55 + 0.45 * Math.sin(this._blink * 11)})`;
        c.shadowColor = 'rgba(255,176,58,0.9)';
        c.shadowBlur = 26;
      } else if (s.tone === 'win') {
        c.fillStyle = '#ffcf5c';
      } else {
        c.fillStyle = '#8ea0c0';
      }
      c.fillText(s.result, TEX_W - 26, botY);
      c.shadowBlur = 0;
    }

    // --- 演出のオーバーレイ ---
    this._drawNotice(heatColor);
    this._drawCutIn(heatColor);
    this._drawFreeze();

    this.texture.needsUpdate = true;
    this._dirty = false;
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
    c.fillRect(0, TEX_H * 0.22, TEX_W * 0.55, TEX_H * 0.56);
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
      || s.notice || this.meters.fever > 0;

    if (anySpin) {
      this._spinTimer += dt;
      if (this._spinTimer >= 0.055) {
        this._spinTimer = 0;
        for (let i = 0; i < 3; i++) {
          if (s.spinning[i]) s.symbols[i] = (Math.random() * SYMBOLS.length) | 0;
        }
        this._dirty = true;
      }
    }
    if (anyBlink) { this._blink += dt; this._dirty = true; }

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
      if (s.slip < 0) s.slip = 0;
      this._dirty = true;
    }

    if (this._dirty) this._draw();
  }

  /* ------------------------------------------------------------------ */
  /* 進行                                                                */
  /* ------------------------------------------------------------------ */

  _stopReel(i, index) {
    this.state.symbols[i] = index;
    this.state.spinning[i] = false;
    this._dirty = true;
    this.sound.reelStop();
  }

  /**
   * 出目を決める。
   * アタリならゾロ目、ハズレは3つとも別の絵柄にする。
   * ハズレでもリーチをかけたときは、滑りで見せる「当たっていた絵柄」も返す。
   */
  _figures(res) {
    if (res.win) return { symbols: [res.index, res.index, res.index], reach: true, tease: res.index };
    const n = SYMBOLS.length;
    const pick = () => (Math.random() * n) | 0;
    const a = pick();
    if (Math.random() < 0.55) {
      let c = pick();
      while (c === a) c = pick();
      return { symbols: [a, a, c], reach: true, tease: a };   // リーチをかけて外す
    }
    let b = pick();
    while (b === a) b = pick();
    let c = pick();
    while (c === a || c === b) c = pick();
    return { symbols: [a, b, c], reach: false, tease: -1 };
  }

  /** heat（期待度）を引く。結果を先に決めてから、その格に応じた重みで引く */
  _pickHeat(res) {
    const w = SHOW.weights[tierOf(res)] || SHOW.weights.miss;
    return pickWeighted(w);
  }

  /** 擬似連。3つとも止まりかけて、また回り出す */
  async _pseudo(times) {
    const s = this.state;
    for (let i = 1; i <= times; i++) {
      const n = SYMBOLS.length;
      const chance = (Math.random() * n) | 0;
      s.symbols = [chance, chance, chance];
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
    const { symbols, reach, tease } = this._figures(res);
    const heat = this._pickHeat(res);
    const tier = tierOf(res);

    s.playing = true;
    s.heat = heat;
    s.reach = false;
    s.result = '';
    s.tone = 'idle';
    s.cutIn = 0; s.freeze = 0; s.slip = 0; s.pseudo = 0;
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

    // ── ④ 第1・第2停止
    this._stopReel(0, symbols[0]);
    await sleep(420);
    this._stopReel(1, symbols[1]);

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

    // ── ⑦ 第3停止。ハズレのリーチは「滑り」で当たり絵柄を一瞬見せる
    if (reach && !res.win && tease >= 0) {
      s.slipFrom = tease;
      s.slip = 1;
      this.sound.slip();
    }
    this._stopReel(2, symbols[2]);

    // ── ⑧ 結果
    s.notice = false;
    this.bezelMat.emissive.setHex(0x000000);

    if (res.jp) {
      s.tone = 'big';
      s.result = 'JACKPOT!!';
      s.label = 'JACKPOT';
      this._dirty = true;
      this.onWin(res.index);
      this.sound.jackpot();
      await sleep(2600);
    } else if (res.win) {
      const big = res.amount >= 60;
      s.tone = big ? 'big' : 'win';
      const mul = res.odds > 1 ? ` x${res.odds}` : '';
      s.result = `${res.symbol.name}${mul}  +${res.amount}`;
      this._dirty = true;
      this.onWin(res.index);
      if (res.amount >= 150) this.sound.jackpot();
      else this.sound.win(res.amount >= 60 ? 2 : res.amount >= 12 ? 1 : 0);
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
    this._dirty = true;
  }
}
