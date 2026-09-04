import { CFG } from '../config.js';

const L = CFG.layout;
const CH = CFG.chute;
const B = CH.box;

/**
 * 坂のローカル dz → world z。
 * 坂は X 軸まわりに rx だけ傾いているので、天面の z は cos(rx) 倍に縮む。
 */
const chuteZ = (dz) => B.z + Math.sin(B.rx) * (B.h / 2) + Math.cos(B.rx) * dz;

/** 穴の world z 範囲をあらかじめ畳んでおく (毎フレーム計算しない) */
const SLOTS = CH.slots.map((s) => ({
  ...s, zMin: chuteZ(s.dz0) - 0.35, zMax: chuteZ(s.dz1) + 0.45,
}));

/**
 * 落下判定 (DESIGN.md §7.3 / DESIGN_GIMMICKS.md §3.1)
 *
 * センサーコライダーではなく座標判定を採用している。
 * y < fallY (-2.0) まで落ちたメダルは
 * 「サイドポケット」「チャッカーの穴」「払い出し」のいずれかを必ず通っており、
 * どれかは (x, z) で一意に決まる。アクティブなメダルを線形走査するだけで済む。
 *
 * ■ 3つが z で分かれる理由
 *   サイドポケット … z 3.0〜6.0 の左右。|x| > pocketX で分かる
 *   チャッカー     … 払い出しスロープ (z 6.05〜8.24) の穴。z < splitZ で落ちる
 *   払い出し       … スロープの先端 (z=8.24) から落ちる。必ず z > splitZ
 *
 *   スロープの天面は y = -0.3 〜 -1.5 で、fallY (-2.0) より上にある。
 *   つまり坂を滑っている間は判定されず、穴か先端を抜けて初めて数えられる。
 *   穴を抜けたメダルは z < 7.9 で、先端から落ちたメダルは z > 8.3 で
 *   fallY を跨ぐので、splitZ = 8.05 に十分な余裕がある。
 *
 * 判定後もすぐには消さず、despawnY まで落ちきってから回収する。
 * こうすると「落ちて消えた」ではなく「落ちていった」ように見える。
 */
export class Payout {
  constructor(pool, callbacks = {}) {
    this.pool = pool;
    this.onGain = callbacks.onGain || (() => {});
    this.onLost = callbacks.onLost || (() => {});
    this.onChucker = callbacks.onChucker || (() => {});
    this.credit = 0;
    this.lost = 0;
    this.chucker = 0;
    /** スロット別の入賞回数 (実測用) */
    this.chuckerById = {};
  }

  /** (x, z) がどのチャッカーの穴か。違えば null */
  static slotAt(x, z) {
    if (z >= CH.splitZ) return null;
    for (const s of SLOTS) {
      if (x >= s.x0 && x <= s.x1 && z >= s.zMin && z <= s.zMax) return s;
    }
    return null;
  }

  update() {
    const active = this.pool.active;
    // 回収で swap-remove するので後ろから舐める
    for (let i = active.length - 1; i >= 0; i--) {
      const m = active[i];
      const y = m.currP.y;

      if (!m.counted && y < L.fallY) {
        m.counted = true;
        // サイドポケットは z 3.0〜6.0 の左右にしかない。
        // z も見ないと、払い出しスロープの端 (|x| 最大 5.75) を通ったメダルまで
        // ロスト扱いになってしまう
        if (Math.abs(m.currP.x) > L.pocketX && m.currP.z < L.pocketZEnd) {
          this.lost++;
          this.onLost(m);
        } else {
          const slot = Payout.slotAt(m.currP.x, m.currP.z);
          if (slot) {
            this.chucker++;
            this.chuckerById[slot.id] = (this.chuckerById[slot.id] || 0) + 1;
            this.onChucker(slot, m);
          } else {
            this.credit++;
            this.onGain(m);
          }
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
    this.chucker = 0;
    this.chuckerById = {};
  }
}
