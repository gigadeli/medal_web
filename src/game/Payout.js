import { CFG } from '../config.js';

const L = CFG.layout;

/**
 * 落下判定 (DESIGN.md §7.3)
 *
 * センサーコライダーではなく座標判定を採用している。
 * テーブル下面が y=-1 なので、y < fallY まで落ちたメダルは
 * 「手前の払い出し口」か「左右のサイドポケット」のどちらかを必ず通っている。
 * どちらかは x で一意に決まるため、アクティブなメダルを線形走査するだけで済む。
 * (250個の走査は 1フレームあたり無視できるコスト)
 *
 * 判定後もすぐには消さず、despawnY まで落ちきってから回収する。
 * こうすると「落ちて消えた」ではなく「落ちていった」ように見える。
 */
export class Payout {
  constructor(pool, callbacks = {}) {
    this.pool = pool;
    this.onGain = callbacks.onGain || (() => {});
    this.onLost = callbacks.onLost || (() => {});
    this.credit = 0;
    this.lost = 0;
  }

  update() {
    const active = this.pool.active;
    // 回収で swap-remove するので後ろから舐める
    for (let i = active.length - 1; i >= 0; i--) {
      const m = active[i];
      const y = m.currP.y;

      if (!m.counted && y < L.fallY) {
        m.counted = true;
        if (Math.abs(m.currP.x) > L.pocketX) {
          this.lost++;
          this.onLost(m);
        } else {
          this.credit++;
          this.onGain(m);
        }
      }

      if (y < L.despawnY) {
        this.pool.recycleAt(i);
      }
    }
  }

  reset() {
    this.credit = 0;
    this.lost = 0;
  }
}
