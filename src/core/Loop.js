import { CFG } from '../config.js';

/**
 * 固定タイムステップ + 描画補間のメインループ (DESIGN.md §6.2)
 *
 * 物理は必ず固定ステップで回す。可変 dt は積層シーンで即座に破綻する。
 * 描画は余り時間 alpha で前フレームと補間するので、
 * 物理 60Hz / 描画 144Hz のような環境でも滑らかに見える。
 */
export class Loop {
  /**
   * @param {(dt:number, time:number)=>void} onFixed  物理ステップ (固定 dt)
   * @param {(alpha:number, dt:number)=>void} onRender 描画 (alpha = 0..1)
   */
  constructor(onFixed, onRender) {
    this.onFixed = onFixed;
    this.onRender = onRender;
    this.dt = CFG.physics.timestep;
    this.accumulator = 0;
    this.simTime = 0;
    this.running = false;
    this._last = 0;
    this._raf = 0;

    // 計測用
    this.fps = 0;
    this.stepMs = 0;
    this._frames = 0;
    this._fpsTimer = 0;

    this._tick = this._tick.bind(this);
  }

  start() {
    if (this.running) return;
    this.running = true;
    this._last = performance.now();
    this._raf = requestAnimationFrame(this._tick);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this._raf);
  }

  _tick(now) {
    this._raf = requestAnimationFrame(this._tick);

    let real = (now - this._last) / 1000;
    this._last = now;
    // タブ復帰などのスパイクで暴走しないようクランプ
    if (real > 0.25) real = 0.25;

    this.accumulator += real;

    const t0 = performance.now();
    let steps = 0;
    while (this.accumulator >= this.dt && steps < CFG.physics.maxSubSteps) {
      this.onFixed(this.dt, this.simTime);
      this.simTime += this.dt;
      this.accumulator -= this.dt;
      steps++;
    }
    // 上限に達したら余剰を捨てる (遅れを溜め込まない)
    if (steps === CFG.physics.maxSubSteps) this.accumulator = 0;
    if (steps > 0) this.stepMs = this.stepMs * 0.9 + ((performance.now() - t0) / steps) * 0.1;

    const alpha = this.accumulator / this.dt;
    this.onRender(alpha, real);

    // FPS (1秒平均)
    this._frames++;
    this._fpsTimer += real;
    if (this._fpsTimer >= 1) {
      this.fps = Math.round(this._frames / this._fpsTimer);
      this._frames = 0;
      this._fpsTimer = 0;
    }
  }
}
