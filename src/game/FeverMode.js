import { CFG } from '../config.js';
import { rnd } from '../core/Rng.js';

const F = CFG.fever;
const L = CFG.layout;

/**
 * フィーバー (DESIGN_GIMMICKS.md §3.3)
 *
 * 抽選ボールが払い出し口に落ちるたび STEP が1つ進み、3つで突入する。
 * 中身はすべて盤面の物理の変更で、液晶の中では何も起きない。
 *
 * ここが本作の山場になる理由は、DESIGN.md §5 と §7.6 の実測表そのものにある。
 * 払い出しを支配しているのはストロークと落とし口の勾配だと既に測ってあり、
 * フィーバーはその2つを25秒だけ全開にするだけの仕掛けになっている。
 * 「効くと分かっているつまみを、ここでだけ回す」という設計。
 *
 *   ① tableFront の傾きを -0.06 → +0.04 へ (山ごと手前に流れる)
 *   ② strokeHalf 0.95 → 1.25 / period 1.9 → 1.5
 *   ③ サイドポケットにシャッターを上げる
 *   ④ 場が痩せたらホッパーで補給する
 *
 * ①②を一気に切り替えないこと。傾きは TiltTable が、駆動は Pusher が
 * それぞれ時間をかけて寄せるようになっている。
 */
export class FeverMode {
  constructor({ pusher, table, shutters, chute, pool, sound, onChange, onEnter, onExit }) {
    this.pusher = pusher;
    this.table = table;
    this.shutters = shutters;
    this.chute = chute;
    this.pool = pool;
    this.sound = sound;
    this.onChange = onChange || (() => {});
    this.onEnter = onEnter || (() => {});
    this.onExit = onExit || (() => {});

    this.steps = 0;
    this.active = false;
    this.left = 0;
    this.suspended = false;   // JP 演出中は台を明け渡す
    this._refill = 0;
    this._baseRx = L.tableFront.rx ?? -L.tableFrontTilt;
  }

  get stepsMax() { return F.stepsToEnter; }

  /** ボールが払い出し口に落ちた */
  addStep(n = 1) {
    if (this.active || this.suspended) return false;
    this.steps += n;
    this.sound.step(this.steps, F.stepsToEnter);
    if (this.steps >= F.stepsToEnter) {
      this.steps = 0;
      this.enter();
      return true;
    }
    this.onChange(this);
    return false;
  }

  enter() {
    if (this.active) return;
    this.active = true;
    this.left = F.seconds;
    this._refill = 0;

    this.table.setTilt(F.tableRx, F.transition);
    this.pusher.override = { strokeHalf: F.strokeHalf, period: F.period };
    this.pusher.setEdgeColor(0xffb03a);
    if (F.closePockets) this.shutters.setOpen(true);
    // フィーバー中は台の傾きが変わるので、漏斗は畳んで素直に流す
    this.chute.foldFlippers();

    this.sound.feverStart();
    this.onEnter(this);
    this.onChange(this);
  }

  exit() {
    if (!this.active) return;
    this.active = false;
    this.left = 0;
    this.table.setTilt(this._baseRx, F.transition);
    this.pusher.override = null;
    this.pusher.setEdgeColor(0x5cc8ff);
    this.shutters.setOpen(false);
    this.sound.feverEnd();
    this.onExit(this);
    this.onChange(this);
  }

  /** JP 演出が台を使う間だけ止める */
  suspend() {
    this.suspended = true;
    if (this.active) this.exit();
  }

  resume() {
    this.suspended = false;
    this.onChange(this);
  }

  /** 物理ステップ側 */
  update(dt) {
    if (!this.active) return;

    this.left -= dt;
    if (this.left <= 0) { this.exit(); return; }

    // 補給。定量に降らせると出方の良いときに場内が膨らんで 1ステップが伸びるので、
    // 「痩せたら足す」形にしてある
    if (this.pool.activeCount < F.refillBelow) {
      this._refill += dt * F.refillRate;
      while (this._refill >= 1) {
        this._refill -= 1;
        const H = CFG.hopper;
        if (!this.pool.spawn(
          (rnd() - 0.5) * 2 * H.spreadX,
          H.y,
          H.z + (rnd() - 0.5) * 2 * H.spreadZ
        )) break;
      }
    } else {
      this._refill = 0;
    }

    // 秒が変わったときだけ UI に通知する
    const s = Math.ceil(this.left);
    if (s !== this._lastSec) {
      this._lastSec = s;
      this.onChange(this);
    }
  }

  reset() {
    this.steps = 0;
    if (this.active) this.exit();
    this.onChange(this);
  }
}
