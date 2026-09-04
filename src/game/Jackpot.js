import { CFG } from '../config.js';

const J = CFG.jackpot;

/**
 * プログレッシブ・ジャックポットのメーター (DESIGN_GIMMICKS.md §3.4)
 *
 * 数分スケールで単調に増える数字を1つ画面に置く、というだけの装置。
 * 演出も払い出しも持たない (JackpotShow と Hopper の仕事)。
 *
 * ■ 燃料をサイドポケットのロストにしたのが要点
 *   実測でロストは 26〜31% もあるのに、いまはただ持ち枚数が減るだけで
 *   プレイヤーには何も返っていない。ここを主要な燃料にすると、
 *   いちばん腹が立つ現象がいちばん期待を煽る現象に変わる。
 */
export class Jackpot {
  constructor(onChange) {
    this.amount = J.initial;
    this.wins = 0;
    this.onChange = onChange || (() => {});
  }

  _add(n) {
    if (n <= 0) return;
    const next = Math.min(J.max, this.amount + n);
    if (next === this.amount) return;
    this.amount = next;
    this.onChange(this);
  }

  /** 表示用。小数は見せない */
  get display() { return Math.floor(this.amount); }

  onInsert(n = 1) { this._add(J.perInsert * n); }
  onLost(n = 1) { this._add(J.perLost * n); }
  onChance(n = 1) { this._add(J.perChance * n); }

  /**
   * 当選。溜まっていた額を返して初期値に戻す。
   * @returns {number} 払い出す枚数
   */
  claim() {
    const won = Math.floor(this.amount);
    this.amount = J.initial;
    this.wins++;
    this.onChange(this);
    return won;
  }

  serialize() {
    return { amount: this.amount, wins: this.wins };
  }

  /**
   * セーブから復元する。
   * ここを復元しないと、開くたびに初期値へ戻って積み立ての意味が消える (§3.4)
   */
  restore(data) {
    if (!data) return;
    if (Number.isFinite(data.amount)) {
      this.amount = Math.min(J.max, Math.max(J.initial, data.amount));
    }
    if (Number.isFinite(data.wins)) this.wins = data.wins;
    this.onChange(this);
  }

  reset(wipe = false) {
    this.amount = J.initial;
    if (wipe) this.wins = 0;
    this.onChange(this);
  }
}
