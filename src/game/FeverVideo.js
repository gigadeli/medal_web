import feverUrl from '../vid/fever_1.mp4';
import { CFG } from '../config.js';

const V = CFG.fever.video;

/**
 * フィーバー中に液晶へ流す映像 (DESIGN_GIMMICKS.md §3.3)
 *
 * ここが持つのは `<video>` 要素と音の配線だけ。
 * 描くのは SlotDisplay で、**液晶の canvas の背景として drawImage する**。
 *
 * ■ なぜ別の板に VideoTexture を貼らないのか
 *   液晶 (z=6.1) は手前のガラス (z=6.25) の**裏**にある。
 *   ガラスの transmission は透過マテリアルを描き直さないので、
 *   映像を別の板に置いて液晶側を透明にすると、ガラス越しに液晶が消える
 *   (DESIGN_GIMMICKS.md §3.11 で実測済み)。
 *   1枚の不透明な canvas に合成してしまえば、この制約に触れずに済む。
 *
 * ■ 音は WebAudio の master に通す
 *   要素の音をそのまま鳴らすと、M キー / SOUND ボタンの消音が効かない。
 *   createMediaElementSource で master に繋ぎ、音量はゲイン1つで持つ。
 */
export class FeverVideo {
  constructor(sound) {
    this.sound = sound;
    this.playing = false;
    this._primed = false;
    this._gain = null;

    const el = document.createElement('video');
    el.src = feverUrl;
    el.loop = true;              // 25秒より短い素材でも尺が足りる
    el.preload = 'auto';
    el.playsInline = true;
    // iOS の Safari は属性側を見る。付けないと再生が全画面に飛ぶ
    el.setAttribute('playsinline', '');
    el.setAttribute('webkit-playsinline', '');
    // display:none にすると iOS がデコードを始めない。
    // 1px の透明な要素として DOM に置いておく
    el.style.cssText =
      'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none;';
    document.body.appendChild(el);
    this.el = el;

    // iOS はユーザー操作の中で一度 play() を通しておかないと、
    // 後からプログラムで再生できない。最初の入力で仕込む
    this._unlock = () => this.prime();
    window.addEventListener('pointerdown', this._unlock);
    window.addEventListener('keydown', this._unlock);
  }

  /** 最初のユーザー操作で1回だけ。音の配線と、iOS 向けの空回し */
  prime() {
    if (this._primed) return;
    this._primed = true;
    window.removeEventListener('pointerdown', this._unlock);
    window.removeEventListener('keydown', this._unlock);

    // 音量はここでは上げない。仕込みの空回しが鳴ってしまう
    this._gain = this.sound.connectElement(this.el);
    if (this._gain) this._gain.gain.value = 0;
    else this.el.volume = 0;

    const settle = () => {
      this.el.pause();
      this._seekToStart();
    };
    const p = this.el.play();
    if (p && typeof p.then === 'function') p.then(settle).catch(() => {});
    else settle();
  }

  /** フィーバー突入 */
  play() {
    if (this.playing) return;
    this.playing = true;
    this._seekToStart();
    this._setVolume(V.volume);
    const p = this.el.play();
    // 自動再生を拒否されることはある。そのときは静かに諦めて、
    // 液晶はいつもの背景のまま (フィーバー自体は盤面の物理なので成立する)
    if (p && typeof p.catch === 'function') {
      p.catch(() => { this.playing = false; });
    }
  }

  /** フィーバー終了 */
  stop() {
    if (!this.playing) return;
    this.playing = false;
    this._setVolume(0);
    this.el.pause();
    this._seekToStart();
  }

  /**
   * 描ける状態なら `<video>` 要素を返す。まだ絵が来ていなければ null。
   * 12MB の読み込みが間に合わなくても、液晶がいつもの背景になるだけで済む
   */
  get frame() {
    if (!this.playing) return null;
    // HAVE_CURRENT_DATA 未満だと drawImage が何も描かない
    return this.el.readyState >= 2 && this.el.videoWidth > 0 ? this.el : null;
  }

  _seekToStart() {
    // 読み込み前に currentTime を触ると投げる環境がある
    try { this.el.currentTime = 0; } catch { /* 読み込み待ち */ }
  }

  _setVolume(v) {
    if (this._gain) {
      const ctx = this.sound.ctx;
      this._gain.gain.setTargetAtTime(v, ctx ? ctx.currentTime : 0, 0.05);
      return;
    }
    // WebAudio が使えない環境。消音は自前で見るしかない
    this.el.volume = v;
    this.el.muted = this.sound.muted;
  }

  dispose() {
    window.removeEventListener('pointerdown', this._unlock);
    window.removeEventListener('keydown', this._unlock);
    this.el.pause();
    this.el.remove();
  }
}
