import { CFG } from '../config.js';

const zeroRun = () => ({ inserted: 0, earned: 0, lost: 0 });
const zeroLifetime = () => ({
  inserted: 0, earned: 0, lost: 0, games: 0,
  slot: { spins: 0, wins: 0, byId: {} },
});

/**
 * プレイヤーの持ち枚数と成績。
 *
 * 投入で1枚減り、払い出しで1枚増える。サイドポケットに落ちたぶんは
 * 投入時にすでに引かれているので、ここでは記録だけ残す。
 *
 * 成績は2階建て (DESIGN.md §11.2):
 *   run      … 今回のゲームぶん。リスタートで 0 に戻る
 *   lifetime … 通算。リスタートでは消えない。保存の対象はこちら
 *
 * 0枚になった瞬間には終了しない。場に残っているメダルがまだ落ちてくる可能性があり、
 * 「最後の1枚を入れたあとに山が崩れて10枚返ってくる」ことは普通に起きる。
 * gameOverDelay 秒のあいだ1枚も増えなければ終了とする。
 */
export class Wallet {
  constructor(onChange) {
    this.onChange = onChange || (() => {});
    this.medals = CFG.wallet.start;
    this.best = CFG.wallet.start;
    this.run = zeroRun();
    this.lifetime = zeroLifetime();
    this.gameOver = false;
    this._empty = 0;
    this.reset();
  }

  /**
   * 新しいゲームを始める。lifetime と best は通算の記録なので引き継ぐ。
   * @param {boolean} wipe すべて初期化する（記録を消す）
   */
  reset(wipe = false) {
    this.medals = CFG.wallet.start;
    this.run = zeroRun();
    this.gameOver = false;
    this._empty = 0;
    if (wipe) {
      this.best = CFG.wallet.start;
      this.lifetime = zeroLifetime();
    } else {
      this.best = Math.max(this.best ?? 0, CFG.wallet.start);
    }
    this.lifetime.games += 1;
    this.onChange(this);
  }

  canInsert() {
    return !this.gameOver && this.medals > 0;
  }

  /** 1枚投入した。呼ぶ前に canInsert() を確認すること */
  spend(n = 1) {
    this.medals -= n;
    this.run.inserted += n;
    this.lifetime.inserted += n;
    this.onChange(this);
  }

  /** 払い出し口に落ちた */
  earn(n = 1) {
    if (this.gameOver) return;          // 終了表示中は増やさない
    this.medals += n;
    this.run.earned += n;
    this.lifetime.earned += n;
    this._empty = 0;
    if (this.medals > this.best) this.best = this.medals;
    this.onChange(this);
  }

  /** サイドポケットに落ちた（記録だけ） */
  recordLost(n = 1) {
    this.run.lost += n;
    this.lifetime.lost += n;
    this.onChange(this);
  }

  /** スロットを1回まわした */
  recordSpin(res) {
    const s = this.lifetime.slot;
    s.spins += 1;
    if (res.win) s.wins += 1;
    const id = res.symbol && res.symbol.id;
    if (id) s.byId[id] = (s.byId[id] || 0) + 1;
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

  /* ---------------- セーブ ---------------- */

  serialize() {
    return {
      medals: this.medals,
      best: this.best,
      run: { ...this.run },
      lifetime: {
        ...this.lifetime,
        slot: { ...this.lifetime.slot, byId: { ...this.lifetime.slot.byId } },
      },
      gameOver: this.gameOver,
    };
  }

  /**
   * セーブから復元する。
   * 終了状態は復元しない。開いた瞬間に終了画面が出るのは体験が悪いので、
   * 通算と最高記録だけ引き継いで、持ち枚数と今回ぶんは新規にする (§11.5)。
   */
  restore(data) {
    if (!data) return;
    this.best = Number.isFinite(data.best) ? data.best : CFG.wallet.start;
    this.lifetime = { ...zeroLifetime(), ...(data.lifetime || {}) };
    this.lifetime.slot = { spins: 0, wins: 0, byId: {}, ...(data.lifetime?.slot || {}) };

    if (data.gameOver || !Number.isFinite(data.medals) || data.medals <= 0) {
      this.reset();               // 新しいゲームとして始める (lifetime.games も増える)
      return;
    }
    this.medals = data.medals;
    this.run = { ...zeroRun(), ...(data.run || {}) };
    this.gameOver = false;
    this._empty = 0;
    this.onChange(this);
  }
}
