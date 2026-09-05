import { CFG } from '../config.js';
import { rnd } from '../core/Rng.js';

const S = CFG.special;

/** 種類の並び。1/2/3 キーの割り当てもこの順 */
export const KINDS = ['gold', 'bomb', 'ticket'];

/**
 * 特殊メダル (DESIGN_GIMMICKS.md §3.7)
 *
 * 実機には無いが、この実装なら安い、という枠。
 * 剛体もマテリアルも増やさず、InstancedMesh の頂点色を差し替えるだけで作れる。
 *
 *   ゴールド   スロットのリプレイ役で入手。落ちると +5枚
 *   ボム       フィーバー終了時に入手。着弾から少しして周囲を吹き飛ばす
 *   チケット   ロスト50枚ごとに入手。落ちるとチャッカーを通さずスロットが回る
 *
 * 面白いのは効果そのものより「どこで使うか」。とくにボムは AntiJam が
 * 自動でやっていることをプレイヤーの意思で撃つものなので、実質は既存ロジックの再利用。
 */
export class SpecialMedals {
  constructor({ pool, sound, onChange }) {
    this.pool = pool;
    this.sound = sound;
    this.onChange = onChange || (() => {});

    this.stock = { gold: 0, bomb: 0, ticket: 0 };
    /** 次の1枚に載せる種類。null なら通常メダル */
    this.selected = null;
    this.lostAccum = 0;
    /** 起爆待ちのボム。数が少ないので配列で足りる */
    this._fuses = [];

    this._onKey = (e) => {
      const i = ['Digit1', 'Digit2', 'Digit3'].indexOf(e.code);
      if (i >= 0) { this.select(KINDS[i]); e.preventDefault(); }
      if (e.code === 'Digit0' || e.code === 'Escape') this.select(null);
    };
    if (S.enabled) window.addEventListener('keydown', this._onKey);
  }

  /** 同じ種類をもう一度押したら解除。持っていなければ選べない */
  select(kind) {
    if (kind && (!S.enabled || this.stock[kind] <= 0)) return;
    this.selected = this.selected === kind ? null : kind;
    this.onChange(this);
  }

  grant(kind, n = 1) {
    if (!S.enabled || !(kind in this.stock)) return;
    const next = Math.min(S.max, this.stock[kind] + n);
    if (next === this.stock[kind]) return;
    this.stock[kind] = next;
    this.sound.grant();
    this.onChange(this);
  }

  /** ロストが溜まったらチケットを配る。救済であり、JP と同じ「損を戻す」線 */
  onLost(n = 1) {
    if (!S.enabled) return;
    this.lostAccum += n;
    while (this.lostAccum >= S.lostPerTicket) {
      this.lostAccum -= S.lostPerTicket;
      this.grant('ticket');
    }
  }

  /**
   * Launcher が発射の直前に呼ぶ。
   * @returns {object|null} MedalPool.spawn に渡すオプション
   */
  takeSpawnOptions() {
    const kind = this.selected;
    if (!kind || this.stock[kind] <= 0) return null;
    this.stock[kind]--;
    const def = S.kinds[kind];
    if (this.stock[kind] <= 0) this.selected = null;
    this.onChange(this);
    return {
      kind,
      color: def.color,
      fuse: kind === 'bomb' ? def.delay : 0,
    };
  }

  /** 投入されたメダルがボムなら起爆待ちに積む */
  track(medal) {
    if (medal && medal.kind === 'bomb') this._fuses.push(medal);
  }

  /**
   * 落下したメダルの後始末。
   * @returns {{credit:number, spin:boolean}} 追加のクレジットと、スロットを回すか
   */
  resolveDrop(medal) {
    const kind = medal.kind;
    if (!kind) return { credit: 0, spin: false };
    if (kind === 'gold') return { credit: S.kinds.gold.pay - 1, spin: false };
    if (kind === 'ticket') return { credit: 0, spin: true };
    return { credit: 0, spin: false };
  }

  /** 物理ステップ側。ボムの導火線を進める */
  update(dt) {
    for (let i = this._fuses.length - 1; i >= 0; i--) {
      const m = this._fuses[i];
      // 場から消えた (落ちて回収された) ものは追わない
      if (!m.live || m.kind !== 'bomb') { this._fuses.splice(i, 1); continue; }
      m.fuse -= dt;
      if (m.fuse > 0) continue;
      this._explode(m);
      this._fuses.splice(i, 1);
    }
  }

  _explode(m) {
    const def = S.kinds.bomb;
    const r2 = def.radius * def.radius;
    const c = m.currP;
    let n = 0;
    for (const o of this.pool.active) {
      if (o === m) continue;
      const dx = o.currP.x - c.x, dy = o.currP.y - c.y, dz = o.currP.z - c.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > r2) continue;
      // 近いほど強く、前と上に押す。AntiJam の全体版と同じ発想
      const k = def.impulse * (1 - Math.sqrt(d2) / def.radius);
      o.body.wakeUp();
      o.body.applyImpulse({ x: dx * 0.25 * k, y: k * 0.6, z: k * (0.6 + rnd() * 0.5) }, true);
      n++;
    }
    // ボム自身は通常メダルに戻す (色も戻る)。消すと持ち枚数が合わなくなる
    this.pool.clearKind(m);
    this.sound.explode();
    return n;
  }

  serialize() {
    return { stock: { ...this.stock }, lostAccum: this.lostAccum };
  }

  restore(data) {
    if (!data || typeof data !== 'object') return;
    const stock = data.stock && typeof data.stock === 'object' ? data.stock : {};
    for (const k of KINDS) {
      const v = stock[k];
      if (typeof v !== 'number' || !Number.isFinite(v)) continue;
      this.stock[k] = Math.max(0, Math.min(S.max, Math.floor(v)));
    }
    // lostAccum は必ず [0, lostPerTicket) に収めること。
    // ここを素通しにすると、セーブに巨大な値を入れられたとき
    // 次の onLost() の while ループが数千万回まわってゲームが固まる
    // (改竄というより、セーブ経由でフリーズさせられる穴だった)
    const acc = data.lostAccum;
    this.lostAccum = (typeof acc === 'number' && Number.isFinite(acc) && acc > 0)
      ? Math.min(Math.floor(acc), S.lostPerTicket - 1)
      : 0;
    this.onChange(this);
  }

  reset(wipe = false) {
    if (wipe) {
      this.stock = { gold: 0, bomb: 0, ticket: 0 };
      this.lostAccum = 0;
    }
    this.selected = null;
    this._fuses.length = 0;
    this.onChange(this);
  }

  dispose() {
    window.removeEventListener('keydown', this._onKey);
  }
}
