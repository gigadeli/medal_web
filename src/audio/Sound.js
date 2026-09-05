import { CFG } from '../config.js';
import { rnd, rndInt } from '../core/Rng.js';

/**
 * 効果音。ほとんどを WebAudio でその場で合成する。
 *
 * メダルの衝突音は「ノイズのアタック + 金属的な倍音の余韻」で作る。
 * 衝突の強さで音量・帯域・減衰が連続的に変わるので、
 * サンプルを数種類鳴らし分けるより自然な密度感になる。
 *
 * 例外がフィールドの抽選ボールが落ちる音 (ballFall) で、ここだけ音声ファイル。
 * 20秒に1回ほどしか鳴らない「見せ場」の音なので、密度ではなく1発の質が要る。
 * 合成では作りにくい種類の音でもある。
 *
 * AudioContext はユーザー操作がないと始動できないため、
 * 最初のクリック/キー入力で resume する。
 */

/**
 * 落球音。src/audio/ballFall/ に置いたぶんだけ自動で拾う。
 * ファイルを足す/減らすだけで候補が増減し、コードは触らなくてよい。
 */
const BALL_FALL_URLS = Object.values(
  import.meta.glob('./ballFall/*.mp3', { eager: true, query: '?url', import: 'default' })
);

export class Sound {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.muted = false;
    this._voices = 0;
    this._lastImpact = 0;
    this._frameVoices = 0;
    this._noise = null;
    /** 落球音のデコード済みバッファ。読み込み前は空 */
    this._ballFall = [];
    this._ballFallLoading = false;
    this._lastBallFall = -1;

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
      this._loadBallFall();
    }
    if (this.ctx.state === 'suspended') {
      const p = this.ctx.resume();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    }
  }

  /**
   * `<video>` / `<audio>` の音を master に通す。
   *
   * 要素のまま鳴らすと消音 (M / SOUND ボタン) が効かない。master に繋げば
   * 効果音と同じゲインを通るので、切り替えが1箇所で済む。
   *
   * createMediaElementSource は**1つの要素につき1回しか呼べない**。
   * 呼んだ時点でその要素の音は WebAudio 側にしか出なくなる。
   *
   * @returns {GainNode|null} 音量調整用。WebAudio が使えなければ null
   */
  connectElement(el) {
    this.resume();
    if (!this.ctx) return null;
    try {
      const src = this.ctx.createMediaElementSource(el);
      const gain = this.ctx.createGain();
      src.connect(gain).connect(this.master);
      return gain;
    } catch (e) {
      // 同じ要素で2回呼んだ / 実装が無い。音は要素側から出る
      return null;
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
    for (let i = 0; i < n; i++) d[i] = rnd() * 2 - 1;
    return buf;
  }

  /**
   * 落球音を読み込む。resume() で AudioContext ができた直後に1回だけ。
   *
   * 起動時ではなく最初のユーザー操作で取りに行く。合計 453KB あり、
   * 球が落ちるのはメダルを撃って盤面が動き出したあとなので、
   * 初回の描画を待たせてまで先に取る意味がない。
   *
   * 間に合わなければ ballFall() が黙って何もしないだけで、
   * 演出そのものは成立する (合成側の step / lose は鳴る)。
   * file:// で開いた場合も fetch が通らないのでここに落ちる (映像の音と同じ)。
   */
  _loadBallFall() {
    if (this._ballFallLoading || !this.ctx) return;
    this._ballFallLoading = true;

    for (const url of BALL_FALL_URLS) {
      fetch(url)
        .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(r.status)))
        .then((buf) => this.ctx.decodeAudioData(buf))
        .then((audio) => {
          /*
           * ピークを揃えてから配列に入れる。
           *
           * いま入っている14個はピークが 0.16〜0.59 (3.7倍) ばらついていて、
           * そのまま混ぜると「同じ出来事の音違い」ではなく
           * 「録り方がバラバラ」に聞こえる。RMS ではなくピークで揃えるのは、
           * 余韻の長い素材を持ち上げすぎるとノイズまで上がってくるため。
           * 持ち上げは4倍で頭打ち (いまの素材では最大 2.85倍で足りている)。
           */
          // 左右で音量が違う素材があるので、**全チャンネルの最大**を見る。
          // 片チャンネルだけで測ると、その裏で大きいほうがそのまま出てくる
          let peak = 0;
          for (let c = 0; c < audio.numberOfChannels; c++) {
            const d = audio.getChannelData(c);
            for (let i = 0; i < d.length; i++) {
              const v = Math.abs(d[i]);
              if (v > peak) peak = v;
            }
          }
          const gain = peak > 1e-4 ? Math.min(4, 0.45 / peak) : 1;
          this._ballFall.push({ buffer: audio, gain });
        })
        .catch(() => { /* 1つ落ちても他が鳴ればよい */ });
    }
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
    src.playbackRate.value = 0.8 + rnd() * 0.5;

    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 2600 + k * 3400 + rnd() * 900;
    bp.Q.value = 1.6;

    const g = this.ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0008, t + decay);

    src.connect(bp).connect(g).connect(this.master);
    src.start(t);
    src.stop(t + decay + 0.02);

    // --- 余韻: 金属的な倍音を2本 ---
    const base = 2900 + rnd() * 1500;
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
    this._tone(1750 + rnd() * 250, 0.07, 'square', 0.055);
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

  /* ---- スロットの演出 (DESIGN_GIMMICKS.md §3.9) ---- */

  /**
   * 予告音。実機の「通常予告音 / 強予告音」に相当する。
   * heat が上がるほど高く、長く、倍音が増える
   */
  notice(heat) {
    if (heat <= 0) return;
    const base = 330 * Math.pow(1.18, heat);
    this._tone(base, 0.10 + heat * 0.03, 'triangle', 0.20);
    this._tone(base * 1.5, 0.16 + heat * 0.05, 'sine', 0.16, 0.06);
    if (heat >= 3) this._tone(base * 2, 0.30, 'square', 0.12, 0.12);
    if (heat >= 5) this._tone(base * 3, 0.45, 'sawtooth', 0.10, 0.18);
  }

  /** 擬似連。止まりかけたリールが再始動する */
  pseudo(n = 1) {
    this._tone(180, 0.10, 'square', 0.26);
    this._tone(520 + n * 120, 0.42, 'sawtooth', 0.16, 0.05, 1100 + n * 250);
  }

  /** カットイン。画面を横切る帯 */
  cutIn(heat) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this._noise;
    src.playbackRate.value = 1.6;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(900, t);
    bp.frequency.exponentialRampToValueAtTime(5200, t + 0.22);
    bp.Q.value = 2.2;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.45, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
    src.connect(bp).connect(g).connect(this.master);
    src.start(t); src.stop(t + 0.32);
    this._tone(160 + heat * 40, 0.5, 'sawtooth', 0.18, 0, 900);
  }

  /** フリーズ。全部止まる = 当たり濃厚 */
  freeze() {
    this._tone(1760, 0.05, 'sine', 0.30);
    // 無音の間を作りたいので、余韻は短く切って「止まった感じ」を出す
    this._tone(2640, 0.06, 'sine', 0.22, 0.05);
    this._tone(110, 1.0, 'sine', 0.20, 0.16, 70);
  }

  /** 第3リールの滑り。当たり絵柄を一瞬見せてから1つずれる */
  slip() {
    this._tone(600, 0.07, 'square', 0.18, 0, 380);
    this._tone(300, 0.14, 'triangle', 0.14, 0.06, 200);
  }

  /* ---- ギミック (DESIGN_GIMMICKS.md) ---- */

  /** 保留が満杯で、入賞が倍率に化けた */
  oddsUp() {
    this._tone(740, 0.09, 'square', 0.20);
    this._tone(1480, 0.16, 'triangle', 0.16, 0.06);
  }

  /** フィーバーのステップが1つ進んだ。残りが少ないほど高く鳴らす */
  step(n, max) {
    const f = 440 * Math.pow(1.26, Math.min(n, max));
    this._tone(f, 0.16, 'square', 0.24);
    this._tone(f * 1.5, 0.28, 'triangle', 0.16, 0.07);
  }

  /** フィーバー突入 */
  feverStart() {
    const notes = [392, 523.25, 659.25, 783.99, 1046.5];
    notes.forEach((f, i) => this._tone(f, 0.22, 'square', 0.22, i * 0.08));
    this._tone(180, 1.1, 'sawtooth', 0.14, 0, 1400);
  }

  /** フィーバー終了 */
  feverEnd() {
    this._tone(880, 0.45, 'triangle', 0.16, 0, 330);
  }

  /** ジャックポットのタワーを1段積んだ。progress 0..1 で音程が上がる */
  stack(progress) {
    this._tone(320 + progress * 900, 0.07, 'square', 0.14);
  }

  /** タワーを崩しにいく前進 */
  sweep() {
    this._tone(90, 1.4, 'sawtooth', 0.20, 0, 260);
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

  /* ---- 3段クルーン (DESIGN_GIMMICKS.md §3.11) ---- */

  /** 球がリフトで持ち上がる */
  kuruunLift() {
    this._tone(220, 1.2, 'sine', 0.10, 0, 660);
  }

  /**
   * フィールドの抽選ボールが落ちた (DESIGN.md §7.4)。
   *
   * 払い出し口でもサイドポケットでも同じで、**落ちたこと自体**の音。
   * 当たり/ハズレを示すのは後続の step() / lose() のほう。
   *
   * 素材を毎回ランダムに選ぶ。直前と同じものは避ける。
   * 球は3個あって続けて落ちることがあるので、
   * 同じ音が並ぶとそこだけ機械的に聞こえる
   */
  ballFall() {
    if (!this.ready) return;
    const n = this._ballFall.length;
    if (n === 0) return;

    let i = rndInt(n);
    if (n > 1 && i === this._lastBallFall) i = (i + 1 + rndInt(n - 1)) % n;
    this._lastBallFall = i;

    const s = this._ballFall[i];
    const src = this.ctx.createBufferSource();
    src.buffer = s.buffer;
    const g = this.ctx.createGain();
    g.gain.value = s.gain * CFG.audio.ballFallVolume;
    src.connect(g).connect(this.master);
    src.start(this.ctx.currentTime);
  }

  /** 皿に球が入った。段が上がるほど高く */
  kuruunEnter(tier = 1) {
    this._tone(520 * Math.pow(1.26, tier - 1), 0.12, 'triangle', 0.20);
  }

  /** 当たり穴を抜けて次の段へ */
  kuruunPass(tier = 1) {
    const base = 660 * Math.pow(1.25, tier - 1);
    this._tone(base, 0.14, 'triangle', 0.26, 0, base * 1.5);
    this._tone(base * 2, 0.28, 'sine', 0.16, 0.08);
  }

  /** ハズレ穴に飲まれた */
  kuruunMiss() {
    this._tone(380, 0.22, 'sine', 0.16, 0, 190);
  }

  /** 3段抜けた */
  kuruunWin() {
    const notes = [659.25, 783.99, 1046.5, 1318.5, 1567.98];
    notes.forEach((f, i) => {
      this._tone(f, 0.30, 'square', 0.20, i * 0.10);
      this._tone(f * 2, 0.30, 'triangle', 0.10, i * 0.10);
    });
    this._tone(400, 0.8, 'sawtooth', 0.12, 0, 2600);
  }
}
