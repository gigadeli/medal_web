import { CFG } from '../config.js';

/**
 * プレイヤーの持ち枚数と通算成績。
 *
 * 投入で1枚減り、払い出しで1枚増える。サイドポケットに落ちたぶんは
 * 投入時にすでに引かれているので、ここでは何もしない（戻ってこないだけ）。
 *
 * 0枚になった瞬間に終了にはしない。場に残っているメダルがまだ落ちてくる可能性があり、
 * 実際「最後の1枚を入れたあとに山が崩れて10枚返ってくる」ことは普通に起きる。
 * gameOverDelay 秒のあいだ1枚も増えなければ終了とする。
 */
export class Wallet {
  constructor(onChange) {
    this.onChange = onChange || (() => {});
    this.reset();
  }

  /**
   * 新しいゲームを始める。
   * best は通算の記録なので既定では引き継ぐ（wipe=true で完全初期化）。
   */
  reset(wipe = false) {
    this.medals = CFG.wallet.start;
    this.best = wipe ? CFG.wallet.start : Math.max(this.best ?? 0, CFG.wallet.start);
    this.inserted = 0;
    this.earned = 0;
    this.lost = 0;
    this.gameOver = false;
    this._empty = 0;
    this.onChange(this);
  }

  /** 投入できるか（0枚 / ゲームオーバー中は不可） */
  canInsert() {
    return !this.gameOver && this.medals > 0;
  }

  /** 1枚投入した。呼ぶ前に canInsert() を確認すること */
  spend(n = 1) {
    this.medals -= n;
    this.inserted += n;
    this.onChange(this);
  }

  /** 払い出し口に落ちた */
  earn(n = 1) {
    if (this.gameOver) return;          // 終了表示中は増やさない
    this.medals += n;
    this.earned += n;
    this._empty = 0;
    if (this.medals > this.best) this.best = this.medals;
    this.onChange(this);
  }

  /** サイドポケットに落ちた（記録だけ） */
  recordLost(n = 1) {
    this.lost += n;
    this.onChange(this);
  }

  /** 物理ステップと同じ固定 dt で呼ぶ */
  update(dt) {
    if (this.gameOver) return;
    if (this.medals > 0) { this._empty = 0; return; }
    this._empty += dt;
    if (this._empty >= CFG.wallet.gameOverDelay) {
      this.gameOver = true;
      this.onChange(this);
    }
  }
}
