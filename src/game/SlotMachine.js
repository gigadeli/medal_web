import { CFG } from '../config.js';

/**
 * スロットの抽選。
 *
 * 絵柄は8種類で、weight による重み付き抽選で「どの絵柄で止まるか」を先に決める。
 * ブランク以外が出れば3列揃い（アタリ）で、その絵柄の pay 枚数をホッパーに渡す。
 *
 * 演出（リールの回転と停止）は present() に委ねてあり、ここは結果だけを決める。
 */
export class SlotMachine {
  constructor({ hopper, present, sound, onDraw }) {
    this.hopper = hopper;
    this.present = present;      // (result) => Promise
    this.sound = sound;
    this.onDraw = onDraw || (() => {});   // 通算成績の記録用

    this.queue = 0;
    this.busy = false;
    this.force = null;           // デバッグ用。次の1回だけこの絵柄で止める
    this.stats = { spins: 0, wins: 0, paid: 0, byId: {} };

    this._total = CFG.slot.symbols.reduce((a, s) => a + s.weight, 0);
  }

  /** 演出待ちを含めた保留数 */
  get held() { return this.queue + (this.busy ? 1 : 0); }

  /** ボールが払い出し口に落ちた */
  request() {
    if (this.held >= CFG.slot.maxQueue) return false;
    this.queue++;
    this.sound.chucker();
    this._pump();
    return true;
  }

  /** 重み付き抽選。参考記事と同じく合計1000の目盛から1つ引く */
  draw() {
    let index;
    if (this.force !== null) {
      index = this.force;
      this.force = null;
    } else {
      let r = Math.random() * this._total;
      index = CFG.slot.symbols.length - 1;
      for (let i = 0; i < CFG.slot.symbols.length; i++) {
        r -= CFG.slot.symbols[i].weight;
        if (r <= 0) { index = i; break; }
      }
    }
    const symbol = CFG.slot.symbols[index];
    const win = symbol.pay > 0;

    this.stats.spins++;
    if (win) {
      this.stats.wins++;
      this.stats.paid += symbol.pay;
    }
    this.stats.byId[symbol.id] = (this.stats.byId[symbol.id] || 0) + 1;

    const result = { index, symbol, amount: symbol.pay, win };
    this.onDraw(result);
    return result;
  }

  async _pump() {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.queue > 0) {
        this.queue--;
        const res = this.draw();
        await this.present(res);
        if (res.amount > 0) this.hopper.queue(res.amount);
      }
    } finally {
      this.busy = false;
    }
  }
}
