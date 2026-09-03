import { CFG } from '../config.js';

/**
 * 詰まり解除。
 *
 * メダルの山は粒状体なので、条件が揃うと「アーチ」を組んで自力では崩れなくなる。
 * 場内が満杯に近いときにこれが起きると、プッシャーが押しても1枚も落ちないまま
 * 永久に止まる (投入も満杯で弾かれるため、プレイヤー側から復帰できない)。
 *
 * 一定時間まったく場外に出なくなったら、前縁付近のメダルにごく弱い前向きの力を加えて崩す。
 * 実機の筐体が常に微妙に振動しているのに相当する。CFG.antiJam.enabled で無効化できる。
 */
export class AntiJam {
  constructor(pool) {
    this.pool = pool;
    this.timer = 0;
    this.lastOut = -1;
    this.count = 0;      // 発動回数 (デバッグ用)
  }

  /**
   * @param {number} dt
   * @param {number} outCount 場外に出た累計枚数 (credit + lost)
   * @param {number} frontZ プッシャー前面の z
   */
  update(dt, outCount, frontZ) {
    const A = CFG.antiJam;
    if (!A.enabled) return false;

    if (outCount !== this.lastOut) {
      this.lastOut = outCount;
      this.timer = 0;
      return false;
    }
    if (this.pool.activeCount < A.minMedals) { this.timer = 0; return false; }

    this.timer += dt;
    if (this.timer < A.seconds) return false;
    this.timer = 0;

    let n = 0;
    for (const m of this.pool.active) {
      // 下段の、プッシャーより前にいるものだけ
      if (m.currP.y < 0.8 && m.currP.z > frontZ - 0.5) {
        m.body.wakeUp();
        m.body.applyImpulse({
          x: (Math.random() - 0.5) * A.impulse * 0.4,
          y: 0,
          z: A.impulse * (0.7 + Math.random() * 0.6),
        }, true);
        n++;
      }
    }
    if (n > 0) this.count++;
    return n > 0;
  }
}
