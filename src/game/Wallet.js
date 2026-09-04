import { CFG } from '../config.js';

/**
 * セーブから「非負整数」として読む。
 *
 * localStorage の中身はプレイヤーが自由に書き換えられる。実測で
 * `restore({ medals: 999999999 })` も `{ earned: -5 }` もそのまま通っていた。
 * 完全にクライアントで動くゲームなので改竄そのものは防げないが、
 * **壊れた値をゲームの内部状態に入れない**ことはできる。
 * 破損したセーブでゲームが変な状態になるのを防ぐ効果のほうが実は大きい。
 *
 * 方針は「捨てずに直す」。厳しく弾くと、こちらのバグや仕様変更で
 * 正直なプレイヤーの記録まで消してしまう。
 */
const uint = (v, fallback = 0, max = CFG.wallet.sanityMax) => {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  const n = Math.floor(v);
  if (n < 0) return fallback;
  return n > max ? max : n;
};

const zeroRun = () => ({ inserted: 0, earned: 0, lost: 0 });
const zeroLifetime = () => ({
  inserted: 0, earned: 0, lost: 0, games: 0,
  slot: { spins: 0, wins: 0, byId: {} },
  // ジャックポットの当選回数と通算獲得枚数 (DESIGN_GIMMICKS.md §3.4)
  jp: { wins: 0, paid: 0 },
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

  /** ジャックポットに当たった */
  recordJackpot(amount) {
    const j = this.lifetime.jp;
    j.wins += 1;
    j.paid += amount;
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
        jp: { ...this.lifetime.jp },
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
    if (!data || typeof data !== 'object' || Array.isArray(data)) return;

    const src = data.lifetime && typeof data.lifetime === 'object' ? data.lifetime : {};
    const srcSlot = src.slot && typeof src.slot === 'object' ? src.slot : {};
    const srcJp = src.jp && typeof src.jp === 'object' ? src.jp : {};

    this.lifetime = {
      inserted: uint(src.inserted),
      earned: uint(src.earned),
      lost: uint(src.lost),
      games: uint(src.games),
      slot: {
        spins: uint(srcSlot.spins),
        wins: uint(srcSlot.wins),
        // byId は絵柄ごとの回数。知らないキーは捨てる。
        // 素通しにすると、セーブ経由で任意のキーを生やされる
        byId: Wallet._byId(srcSlot.byId),
      },
      // 古いセーブには無いので既定で埋める (版は上げない。通算記録を捨てたくない)
      jp: { wins: uint(srcJp.wins), paid: uint(srcJp.paid) },
    };
    // 当たった回数が回した回数を超えることはない
    if (this.lifetime.slot.wins > this.lifetime.slot.spins) {
      this.lifetime.slot.wins = this.lifetime.slot.spins;
    }

    this.best = uint(data.best, CFG.wallet.start);

    if (data.gameOver || !Number.isFinite(data.medals) || data.medals <= 0) {
      this.reset();               // 新しいゲームとして始める (lifetime.games も増える)
      return;
    }
    this.medals = uint(data.medals, CFG.wallet.start);
    const run = data.run && typeof data.run === 'object' ? data.run : {};
    this.run = {
      inserted: uint(run.inserted),
      earned: uint(run.earned),
      lost: uint(run.lost),
    };
    // best は「最高持ち枚数」なので、いまの持ち枚数を下回ることはない。
    // 矛盾していたら捨てずに引き上げる
    if (this.best < this.medals) this.best = this.medals;

    this.gameOver = false;
    this._empty = 0;
    this.onChange(this);
  }

  /** 絵柄ごとの回数。config に無いキーは黙って捨てる */
  static _byId(src) {
    const out = {};
    if (!src || typeof src !== 'object') return out;
    for (const sym of CFG.slot.symbols) {
      const n = uint(src[sym.id]);
      if (n > 0) out[sym.id] = n;
    }
    return out;
  }
}
