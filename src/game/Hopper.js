import { CFG } from '../config.js';

/**
 * ホッパー: 当たり分のメダルをまとめて降らせる装置。
 *
 * 一度に全部出すと物理が破綻するので、毎秒 rate 枚ずつ小出しにする。
 * プールが満杯のときは出さずに待つ (キューは保持される)。
 */
export class Hopper {
  constructor(pool) {
    this.pool = pool;
    this.pending = 0;
    this._acc = 0;
    this.released = 0;
    this._stall = 0;   // fieldLimit で出せなかった時間
  }

  queue(n) { this.pending += Math.max(0, Math.floor(n)); }

  get busy() { return this.pending > 0; }

  update(dt) {
    if (this.pending <= 0) { this._acc = 0; return; }
    const H = CFG.hopper;
    // 残数に応じて吐出レートを上げる
    const rate = Math.min(H.maxRate, H.rate + this.pending * H.accel);
    this._acc += dt * rate;

    // fieldLimit で長く出せずにいると、場が流れないまま永久に残ってしまう。
    // その場合は上限を少しだけ緩める。落ちてくるメダルが山を叩くこと自体が詰まり解消になる。
    //
    // 【実測】ここで上限を「無視」してはいけない。
    // ジャックポットの残り 340枚を吐かせたら場内が 581枚 (プール上限 585) まで埋まり、
    // 1ステップが 28ms 相当まで伸びて 60fps を維持できなくなった。
    // 逃げ道は要るが、逃げ道にも上限が要る。
    const blocked = this.pool.activeCount >= H.fieldLimit;
    this._stall = blocked ? this._stall + dt : 0;
    const limit = this._stall > H.stallRelease
      ? H.fieldLimit + H.stallOverflow
      : H.fieldLimit;

    while (this._acc >= 1 && this.pending > 0) {
      // 場内を詰まらせない。空くまで待つ
      if (this.pool.activeCount >= limit) break;
      const x = (Math.random() - 0.5) * 2 * H.spreadX;
      const z = H.z + (Math.random() - 0.5) * 2 * H.spreadZ;
      if (!this.pool.spawn(x, H.y, z)) break;   // 満杯。次のフレームに回す
      this.pending--;
      this.released++;
      this._acc -= 1;
    }
    if (this._acc > 1) this._acc = 1;
  }
}
