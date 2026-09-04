import { CFG } from '../config.js';

/**
 * WebAudio で効果音をその場で合成する。音声ファイルは使わない。
 *
 * メダルの衝突音は「ノイズのアタック + 金属的な倍音の余韻」で作る。
 * 衝突の強さで音量・帯域・減衰が連続的に変わるので、
 * サンプルを数種類鳴らし分けるより自然な密度感になる。
 *
 * AudioContext はユーザー操作がないと始動できないため、
 * 最初のクリック/キー入力で resume する。
 */
export class Sound {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.muted = false;
    this._voices = 0;
    this._lastImpact = 0;
    this._frameVoices = 0;
    this._noise = null;

    const unlock = () => this.resume();
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);

    window.addEventListener('keydown', (e) => {
      if (e.code === 'KeyM') this.toggleMute();
    });
  }

  resume() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      try {
        this.ctx = new AC();
      } catch (e) {
        // 音声デバイスが無い環境 (CI やヘッドレス) では黙って無効にする
        this.ctx = null;
        return;
      }
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : CFG.audio.masterVolume;
      this.master.connect(this.ctx.destination);
      this._noise = this._makeNoiseBuffer(0.25);
    }
    if (this.ctx.state === 'suspended') {
      const p = this.ctx.resume();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    }
  }

  /** セーブから復元するときなど、値を直接指定する */
  setMuted(v) {
    if (this.muted === !!v) return;
    this.toggleMute();
  }

  toggleMute() {
    this.muted = !this.muted;
    if (this.master) {
      this.master.gain.setTargetAtTime(this.muted ? 0 : CFG.audio.masterVolume, this.ctx.currentTime, 0.02);
    }
    return this.muted;
  }

  _makeNoiseBuffer(seconds) {
    const n = Math.floor(this.ctx.sampleRate * seconds);
    const buf = this.ctx.createBuffer(1, n, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  /** 描画フレームの頭で呼ぶ。1フレームあたりの発音数をリセットする */
  beginFrame() { this._frameVoices = 0; }

  get ready() { return !!this.ctx && this.ctx.state === 'running' && !this.muted; }

  /**
   * メダルの衝突音。
   * @param {number} force Rapier の totalForceMagnitude
   */
  impact(force) {
    if (!this.ready) return;
    const A = CFG.audio;
    if (this._frameVoices >= A.maxVoicesPerFrame) return;
    const t = this.ctx.currentTime;
    if (t - this._lastImpact < A.minInterval) return;
    this._lastImpact = t;
    this._frameVoices++;

    // 0..1 に正規化。弱い接触ほど短く暗い音にする
    const k = Math.min(1, Math.max(0, (force - A.impactThreshold) / (A.impactFullScale - A.impactThreshold)));
    const vol = 0.05 + 0.55 * k * k;
    const decay = 0.035 + 0.075 * k;

    // --- アタック: 帯域を絞ったノイズ ---
    const src = this.ctx.createBufferSource();
    src.buffer = this._noise;
    src.playbackRate.value = 0.8 + Math.random() * 0.5;

    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 2600 + k * 3400 + Math.random() * 900;
    bp.Q.value = 1.6;

    const g = this.ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0008, t + decay);

    src.connect(bp).connect(g).connect(this.master);
    src.start(t);
    src.stop(t + decay + 0.02);

    // --- 余韻: 金属的な倍音を2本 ---
    const base = 2900 + Math.random() * 1500;
    for (const [mult, amp] of [[1, 0.5], [2.41, 0.28]]) {
      const o = this.ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = base * mult;
      const og = this.ctx.createGain();
      og.gain.setValueAtTime(vol * amp, t);
      og.gain.exponentialRampToValueAtTime(0.0006, t + decay * 1.5);
      o.connect(og).connect(this.master);
      o.start(t);
      o.stop(t + decay * 1.5 + 0.02);
    }
  }

  /** 汎用: 単音 */
  _tone(freq, dur, type = 'sine', vol = 0.2, delay = 0, glideTo = null) {
    if (!this.ready) return;
    const t = this.ctx.currentTime + delay;
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (glideTo) o.frequency.exponentialRampToValueAtTime(glideTo, t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  /** メダル1枚獲得 */
  payout() {
    if (!this.ready) return;
    // ジャックポットの大量払い出しで鳴りっぱなしにならないよう間引く
    const t = this.ctx.currentTime;
    if (t - (this._lastPayout || 0) < 0.05) return;
    this._lastPayout = t;
    this._tone(1750 + Math.random() * 250, 0.07, 'square', 0.055);
  }

  /** チャッカー通過 */
  chucker() {
    this._tone(880, 0.10, 'triangle', 0.30, 0, 1760);
    this._tone(1320, 0.22, 'sine', 0.20, 0.05);
  }

  /** リールが1つ停止 */
  reelStop() {
    this._tone(420, 0.06, 'square', 0.16);
  }

  /** リーチ */
  reach() {
    this._tone(660, 0.5, 'sawtooth', 0.10, 0, 990);
  }

  /** はずれ */
  lose() {
    this._tone(320, 0.18, 'sine', 0.14, 0, 200);
  }

  /** 当たり。level 0..2 で派手さが変わる */
  win(level = 0) {
    const scale = [523.25, 659.25, 783.99, 1046.5, 1318.5];
    const n = 3 + level;
    for (let i = 0; i < n; i++) {
      this._tone(scale[Math.min(i, scale.length - 1)], 0.20, 'triangle', 0.22, i * 0.075);
    }
  }

  /** ジャックポット */
  jackpot() {
    const notes = [523.25, 659.25, 783.99, 1046.5, 783.99, 1046.5, 1318.5];
    notes.forEach((f, i) => {
      this._tone(f, 0.28, 'square', 0.20, i * 0.11);
      this._tone(f * 2, 0.28, 'triangle', 0.10, i * 0.11);
    });
    // 上昇スイープ
    this._tone(300, 0.9, 'sawtooth', 0.12, 0, 2400);
  }
}
