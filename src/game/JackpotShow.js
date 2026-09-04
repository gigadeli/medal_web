import { CFG } from '../config.js';

const J = CFG.jackpot;
const T = CFG.jackpot.tower;

/**
 * ジャックポットの演出 (DESIGN_GIMMICKS.md §3.5)
 *
 * バベルのメダルタワーと同じ手順を踏む。
 *
 *   park  … プッシャーを最後方まで下げて止める。台が静まる
 *   build … 上段中央にメダルを積み上げる (本物の剛体。本当に積む)
 *   sweep … 通常より遅く、大きく前進してタワーを崩す
 *   pay   … 積みきれなかったぶんは通常のホッパーで払う
 *
 * ■ 1本柱にしないこと
 *   メダル厚 0.10 で 180枚を1本に積むと 18 unit。天井 (y=16) を突き抜ける。
 *   3×3 の束にして 20層 = 2.0 unit の「塔」にしている。
 *
 * ■ 積む上限は性能の都合で決まっている
 *   §7.6 の実測は 400枚で 16.2ms (60fps 予算の 97%)。
 *   発動時の平衡枚数 180 に towerLimit 180 を足して 360枚 ≒ 13ms。
 *   ここを超えて積んではいけない。
 *
 * ■ 建設中だけソルバ反復を上げる
 *   薄い円盤を20層積むのは solverIterations: 8 では厳しい。
 *   数秒のことなので、この間だけ 14 まで上げて自壊を防ぐ。
 */
export class JackpotShow {
  constructor({ pusher, pool, hopper, world, sound, onPhase }) {
    this.pusher = pusher;
    this.pool = pool;
    this.hopper = hopper;
    this.world = world;
    this.sound = sound;
    this.onPhase = onPhase || (() => {});

    this.phase = 'idle';     // idle | park | build | sweep | done
    this.timer = 0;
    this.amount = 0;
    this.toStack = 0;
    this.stacked = 0;
    this._acc = 0;
    this._savedIterations = CFG.physics.solverIterations;
  }

  get running() { return this.phase !== 'idle'; }

  /** @param {number} amount ジャックポットの払い出し枚数 */
  start(amount) {
    if (this.running) { this.hopper.queue(amount); return; }
    this.amount = amount;
    // プールの空きを超えて積むと途中で spawn が失敗する。積めるぶんだけ積む
    this.toStack = Math.min(J.towerLimit, amount, this.pool.freeCount);
    this.stacked = 0;
    this._acc = 0;
    this.phase = 'park';
    this.timer = J.parkSeconds;
    this.pusher.hold(this.pusher.rearZ, 2.5);
    this.sound.jackpot();
    this.onPhase(this);
  }

  /** タワーの n 枚目を置く座標 */
  _slotFor(n) {
    const per = T.cols * T.rows;
    const layer = Math.floor(n / per);
    const k = n % per;
    const ix = k % T.cols;
    const iz = Math.floor(k / T.cols);
    return {
      x: T.x + (ix - (T.cols - 1) / 2) * T.spacing,
      z: T.z + (iz - (T.rows - 1) / 2) * T.spacing,
      // 層の間隔はメダル厚より少し広く。詰めて置くと生成時に重なって弾け飛ぶ
      y: T.y0 + layer * (CFG.medal.thickness + 0.06),
    };
  }

  /** 物理ステップ側 */
  update(dt) {
    switch (this.phase) {
      case 'park': {
        this.timer -= dt;
        if (this.timer <= 0) {
          this.phase = 'build';
          this._setIterations(T.solverIterations);
          this.onPhase(this);
        }
        break;
      }

      case 'build': {
        this._acc += dt * T.rate;
        while (this._acc >= 1 && this.stacked < this.toStack) {
          this._acc -= 1;
          const p = this._slotFor(this.stacked);
          // flat: 傾けず、回転も与えずに置く。姿勢が乱れると塔にならない
          if (!this.pool.spawn(p.x, p.y, p.z, { flat: true })) break;
          this.stacked++;
          if (this.stacked % 6 === 0) this.sound.stack(this.stacked / this.toStack);
        }
        if (this.stacked >= this.toStack || this.pool.freeCount === 0) {
          this.phase = 'sweep';
          this.timer = J.sweepSeconds;
          this._setIterations(this._savedIterations);
          // 通常の前進端より深く、ゆっくり押し込む
          this.pusher.hold(J.sweepZ, Math.abs(J.sweepZ - this.pusher.z) / J.sweepSeconds);
          this.sound.sweep();
          this.onPhase(this);
        }
        break;
      }

      case 'sweep': {
        this.timer -= dt;
        if (this.timer <= 0) {
          this.pusher.run();
          // 積めなかったぶんは通常のホッパーで払う
          const rest = this.amount - this.stacked;
          if (rest > 0) this.hopper.queue(rest);
          this.phase = 'idle';
          this.onPhase(this);
        }
        break;
      }

      default:
        break;
    }
  }

  _setIterations(n) {
    const ip = this.world.integrationParameters;
    if (ip && 'numSolverIterations' in ip) ip.numSolverIterations = n;
  }

  abort() {
    if (!this.running) return;
    this._setIterations(this._savedIterations);
    this.pusher.run();
    this.phase = 'idle';
    this.onPhase(this);
  }
}
