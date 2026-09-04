import { CFG } from '../config.js';

/**
 * スロットの抽選。
 *
 * 絵柄は8種類で、weight による重み付き抽選で「どの絵柄で止まるか」を先に決める。
 * ブランク以外が出れば3列揃い（アタリ）で、その絵柄の pay 枚数をホッパーに渡す。
 * 青7だけは枚数を持たず、ジャックポット当選として上位へ渡す。
 *
 * 演出（リールの回転と停止）は present() に委ねてあり、ここは結果だけを決める。
 *
 * ─────────────────────────────────────────────────────────────
 * 保留オッズ (DESIGN_GIMMICKS.md §3.2)
 *
 * 以前は保留が満杯のときの入賞を捨てていた。チャッカーが入って回転数が
 * 3倍以上になる以上、捨てる量も3倍になる。そこで実機3機種と同じく、
 * 溢れたぶんは倍率に化けるようにした。
 *
 *   保留に空きがある  → 保留 +1
 *   保留が満杯        → オッズを1段上げる (×1 → ×2 → ×3 → ×5)
 *   オッズも最大      → ここで初めて捨てる
 *
 * これで「回さずに溜める」という選択が生まれる。判断が発生すればゲームになる。
 * ─────────────────────────────────────────────────────────────
 */
export class SlotMachine {
  constructor({ hopper, present, sound, onDraw, onJackpot }) {
    this.hopper = hopper;
    this.present = present;      // (result) => Promise
    this.sound = sound;
    this.onDraw = onDraw || (() => {});   // 通算成績の記録用
    this.onJackpot = onJackpot || (() => {});

    this.queue = 0;
    this.busy = false;
    this.oddsIndex = 0;
    this._overflow = 0;
    this.force = null;           // デバッグ用。次の1回だけこの絵柄で止める
    this.stats = { spins: 0, wins: 0, paid: 0, byId: {} };

    this._total = CFG.slot.symbols.reduce((a, s) => a + s.weight, 0);
  }

  /** 演出待ちを含めた保留数 */
  get held() { return this.queue + (this.busy ? 1 : 0); }

  /** 現在の倍率 */
  get odds() { return CFG.slot.odds[this.oddsIndex]; }
  get oddsMax() { return CFG.slot.odds.length; }

  /**
   * チャッカーにメダルが入った / 特殊メダルが落ちた。
   * @returns {'queued'|'odds'|'full'}
   */
  request() {
    if (this.held < CFG.slot.maxQueue) {
      this.queue++;
      this.sound.chucker();
      this._pump();
      return 'queued';
    }
    // 溢れたぶんをそのまま倍率にすると、チャッカーが演出より速いときに
    // 倍率が最大に張り付く。実測で 34回/分 × 演出 24回/分 のとき平均 ×2.78 まで上がり、
    // 総払い戻しが 150% を超えた。oddsStep 回ぶん溜めて初めて1段上げる
    this._overflow++;
    if (this._overflow < CFG.slot.oddsStep) return 'full';
    this._overflow = 0;

    if (this.oddsIndex < CFG.slot.odds.length - 1) {
      this.oddsIndex++;
      this.sound.oddsUp();
      return 'odds';
    }
    return 'full';
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
    const odds = this.odds;
    const jp = !!symbol.jp;
    // 倍率は枚数にだけ掛ける。ジャックポットは累積額そのものなので掛けない
    const amount = symbol.pay * odds;
    const win = jp || amount > 0;

    this.stats.spins++;
    if (win) {
      this.stats.wins++;
      this.stats.paid += amount;
    }
    this.stats.byId[symbol.id] = (this.stats.byId[symbol.id] || 0) + 1;

    const result = { index, symbol, amount, win, jp, odds };
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
        // 当たったら倍率は使い切り。溜め直しになる
        if (res.win) { this.oddsIndex = 0; this._overflow = 0; }
        if (res.jp) this.onJackpot(res);
        else if (res.amount > 0) this.hopper.queue(res.amount);
      }
    } finally {
      this.busy = false;
    }
  }

  reset() {
    this.queue = 0;
    this.oddsIndex = 0;
    this._overflow = 0;
  }
}
