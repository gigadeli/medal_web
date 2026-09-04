import * as THREE from 'three';
import { CFG } from '../config.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SYMBOLS = CFG.slot.symbols;
const D = CFG.slot.display;

const TEX_W = 1024;
const TEX_H = Math.round(TEX_W * (D.height / D.width));

/** 絵柄と文字が両方出るフォント指定 */
const FONT = '"Noto Color Emoji", "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI", system-ui, sans-serif';

/**
 * スロットの表示装置。
 *
 * DOM のオーバーレイではなく、筐体の前面（ガラスの内側）に貼った
 * 液晶パネルとして 3D シーンの中に描く。プレイ中の盤面を覆わないのが狙い。
 *
 * 実体は Canvas 2D で毎回描き直しているテクスチャ。
 * リールが回っている間だけ 18Hz 程度で描き直し、止まっているときは更新しない。
 *
 * 進行役も兼ねていて、SlotMachine からは play(res) を await するだけでよい。
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

    // 画面。自己発光させたいので Basic (ライティングの影響を受けない)
    const screen = new THREE.Mesh(
      new THREE.PlaneGeometry(D.width, D.height),
      new THREE.MeshBasicMaterial({ map: this.texture, toneMapped: false })
    );
    this.group.add(screen);

    // ベゼル
    const bezelMat = new THREE.MeshStandardMaterial({
      color: 0x8b97ad, metalness: 0.9, roughness: 0.3,
    });
    const t = 0.22;
    const frames = [
      [0, D.height / 2 + t / 2, D.width + t * 2, t],
      [0, -D.height / 2 - t / 2, D.width + t * 2, t],
      [-D.width / 2 - t / 2, 0, t, D.height],
      [D.width / 2 + t / 2, 0, t, D.height],
    ];
    for (const [x, y, w, h] of frames) {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.16), bezelMat);
      bar.position.set(x, y, -0.05);
      this.group.add(bar);
    }

    this._draw();
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

  _draw() {
    const c = this.ctx;
    const s = this.state;

    c.clearRect(0, 0, TEX_W, TEX_H);
    c.fillStyle = '#070b14';
    c.fillRect(0, 0, TEX_W, TEX_H);

    // 上下のうっすらした光
    const g = c.createLinearGradient(0, 0, 0, TEX_H);
    g.addColorStop(0, 'rgba(92,200,255,0.10)');
    g.addColorStop(0.5, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(255,176,58,0.08)');
    c.fillStyle = g;
    c.fillRect(0, 0, TEX_W, TEX_H);

    // --- ラベル ---
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.font = `600 30px ${FONT}`;
    c.fillStyle = s.tone === 'big' ? '#ffcf5c' : '#8ea0c0';
    c.letterSpacing = '10px';
    c.fillText(s.label, TEX_W / 2, 44);
    c.letterSpacing = '0px';

    // --- リール ---
    const boxW = 190, boxH = 190, gap = 26;
    const totalW = boxW * 3 + gap * 2;
    const x0 = (TEX_W - totalW) / 2;
    const y0 = 82;

    for (let i = 0; i < 3; i++) {
      const bx = x0 + i * (boxW + gap);
      const grad = c.createLinearGradient(0, y0, 0, y0 + boxH);
      grad.addColorStop(0, '#202a40');
      grad.addColorStop(1, '#0f1420');
      c.fillStyle = grad;
      this._roundRect(bx, y0, boxW, boxH, 18);
      c.fill();

      // リーチ中の3番目だけ枠を光らせる
      const reaching = s.reach && i === 2 && s.spinning[2];
      c.lineWidth = reaching ? 6 : 2;
      c.strokeStyle = reaching
        ? `rgba(255,77,94,${0.55 + 0.45 * Math.sin(this._blink * 9)})`
        : 'rgba(140,165,210,0.25)';
      c.stroke();

      const sym = SYMBOLS[s.symbols[i]] || SYMBOLS[0];
      c.fillStyle = sym.color;
      c.globalAlpha = s.spinning[i] ? 0.6 : 1;
      // 文字の絵柄 (BAR) は枠に収まるよう小さく
      c.font = sym.glyph.length > 1 ? `700 62px ${FONT}` : `700 112px ${FONT}`;
      c.fillText(sym.glyph, bx + boxW / 2, y0 + boxH / 2 + 6);
      c.globalAlpha = 1;
    }

    // --- 結果 ---
    if (s.result) {
      c.font = `700 46px ${FONT}`;
      if (s.tone === 'big') {
        c.fillStyle = `rgba(255,255,255,${0.55 + 0.45 * Math.sin(this._blink * 11)})`;
        c.shadowColor = 'rgba(255,176,58,0.9)';
        c.shadowBlur = 26;
      } else if (s.tone === 'win') {
        c.fillStyle = '#ffcf5c';
      } else {
        c.fillStyle = '#8ea0c0';
      }
      c.fillText(s.result, TEX_W / 2, TEX_H - 42);
      c.shadowBlur = 0;
    }

    this.texture.needsUpdate = true;
    this._dirty = false;
  }

  /** 描画フレームごとに呼ぶ。回転とちらつきの更新だけを行う */
  update(dt) {
    const s = this.state;
    const anySpin = s.spinning[0] || s.spinning[1] || s.spinning[2];
    const anyBlink = (s.reach && s.spinning[2]) || s.tone === 'big';

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
    if (anyBlink) {
      this._blink += dt;
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

  /** 出目を決める。アタリならゾロ目、ハズレは3つとも別の絵柄にする */
  _figures(res) {
    if (res.win) return { symbols: [res.index, res.index, res.index], reach: true };
    const n = SYMBOLS.length;
    const pick = () => (Math.random() * n) | 0;
    const a = pick();
    if (Math.random() < 0.45) {
      let c = pick();
      while (c === a) c = pick();
      return { symbols: [a, a, c], reach: true };   // リーチだけかけて外す
    }
    let b = pick();
    while (b === a) b = pick();
    let c = pick();
    while (c === a || c === b) c = pick();
    return { symbols: [a, b, c], reach: false };
  }

  /** SlotMachine から await される */
  async play(res) {
    const s = this.state;
    const { symbols, reach } = this._figures(res);

    s.playing = true;
    s.label = 'CHANCE';
    s.spinning = [true, true, true];
    s.reach = false;
    s.result = '';
    s.tone = 'idle';
    this._blink = 0;
    this._dirty = true;

    await sleep(600);
    this._stopReel(0, symbols[0]);
    await sleep(450);
    this._stopReel(1, symbols[1]);

    if (reach) {
      s.reach = true;
      this._dirty = true;
      this.sound.reach();
      await sleep(1200);
    } else {
      await sleep(450);
    }
    this._stopReel(2, symbols[2]);

    if (res.win) {
      const big = res.amount >= 40;
      s.tone = big ? 'big' : 'win';
      s.result = `${res.symbol.name}  +${res.amount}`;
      this._dirty = true;
      this.onWin(res.index);
      if (res.amount >= 80) this.sound.jackpot();
      else this.sound.win(res.amount >= 40 ? 2 : res.amount >= 10 ? 1 : 0);
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
    this._dirty = true;
  }
}
