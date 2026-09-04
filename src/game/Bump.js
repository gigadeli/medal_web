import { CFG } from '../config.js';

const B = CFG.bump;

/**
 * 台パン (DESIGN_GIMMICKS.md §3.8)
 *
 * B キーで筐体を叩く。場内の全メダルに弱い上向き＋前向きのインパルスを与える。
 * 実質 AntiJam を手動で撃てるようにしただけで、新規のロジックはほとんど無い。
 *
 * 実機でやってはいけない行為だが、「詰まってイライラする瞬間にプレイヤーが
 * 取れる行動がある」というだけで体験が変わる。現状の
 * 「決められることが何もない」(§0.1) に対する、いちばん安い回答。
 *
 * ただの得にはしない。クールダウン中に叩き続けると TILT になり、
 * 一定時間まったく投入できなくなる。
 */
export class Bump {
  constructor({ pool, sound, stage, onChange }) {
    this.pool = pool;
    this.sound = sound;
    this.stage = stage;
    this.onChange = onChange || (() => {});

    this.cooldown = 0;
    this.tilt = 0;         // > 0 の間は投入できない
    this.abuse = 0;        // クールダウン中に叩いた回数
    this.count = 0;
    this.shake = 0;

    this._onKey = (e) => {
      if (e.code === 'KeyB' && !e.repeat) this.hit();
    };
    window.addEventListener('keydown', this._onKey);
  }

  get ready() { return this.cooldown <= 0 && this.tilt <= 0; }

  hit() {
    if (this.tilt > 0) return false;

    if (this.cooldown > 0) {
      // 効かないうえに、続けると TILT になる
      this.abuse++;
      this.sound.tick();
      if (this.abuse > B.tiltUses) {
        this.tilt = B.tiltSeconds;
        this.abuse = 0;
        this.sound.tiltAlarm();
        this.onChange(this);
      }
      return false;
    }

    this.cooldown = B.cooldown;
    this.abuse = 0;
    this.count++;
    this.shake = B.shake;

    for (const m of this.pool.active) {
      m.body.wakeUp();
      m.body.applyImpulse({
        x: (Math.random() - 0.5) * B.impulse * 0.5,
        y: B.impulse * (0.5 + Math.random() * 0.5),
        z: B.impulse * (0.4 + Math.random() * 0.5),
      }, true);
    }
    this.sound.bump();
    this.onChange(this);
    return true;
  }

  /** 物理ステップ側 */
  update(dt) {
    if (this.cooldown > 0) {
      const before = Math.ceil(this.cooldown);
      this.cooldown -= dt;
      if (this.cooldown <= 0) { this.cooldown = 0; this.abuse = 0; }
      if (Math.ceil(this.cooldown) !== before) this.onChange(this);
    }
    if (this.tilt > 0) {
      const before = Math.ceil(this.tilt);
      this.tilt -= dt;
      if (this.tilt <= 0) { this.tilt = 0; this.cooldown = 0; }
      if (Math.ceil(this.tilt) !== before) this.onChange(this);
    }
  }

  /** 描画側。カメラを少しだけ揺らす */
  syncCamera(dt) {
    if (this.shake <= 0) return;
    this.shake = Math.max(0, this.shake - dt * 1.4);
    const k = this.shake;
    this.stage.camera.position.x += (Math.random() - 0.5) * k;
    this.stage.camera.position.y += (Math.random() - 0.5) * k;
  }

  dispose() {
    window.removeEventListener('keydown', this._onKey);
  }
}
