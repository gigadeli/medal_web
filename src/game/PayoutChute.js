import * as THREE from 'three';
import { CFG } from '../config.js';

const CH = CFG.chute;
const F = CFG.flipper;
const B = CH.box;

/** 坂の法線まわり = 坂のローカル Y。フリッパーはこの軸で開く */
const AXIS_Y = new THREE.Vector3(0, 1, 0);
const _spin = new THREE.Quaternion();

/**
 * 払い出しスロープ + チャッカー + フリッパー (DESIGN_GIMMICKS.md §3.1 / §3.6)
 *
 * 前縁 (z=6.0) を越えて落ちてきたメダルを受ける、手前に下る坂。
 * その上に開けた穴がチャッカーで、入ったメダルは飲まれる代わりに抽選が回る。
 *
 * ■ ここが盤面の外であることが本質
 *   最初はチャッカーを手前テーブルの前縁に開けたが、これは機械を止めた。
 *   山は力の連鎖で前へ進むので、途中に穴があると連鎖が切れて払い出しが停止する
 *   (DESIGN.md §2.4 が上段について書いているのと同じ現象。実測で
 *    場内 231 → 410枚、60秒あたりの払い出しが 12枚まで落ちた)。
 *
 *   坂の上は「もう払い出されたメダルが1枚ずつ滑り落ちてくる」場所で、
 *   山の力学とは無関係。だから穴も板も好きに置ける。
 *   実機がチェッカーを払い出し口の傾斜に置いているのは、おそらく同じ理由。
 *
 * ■ 断面 (side view)
 *
 *     テーブル前縁 z=6.0
 *          │
 *          ↓  ┌──────────────┐  ← 坂 (28.7°)
 *             │   ▓▓  ●  ▓▓  │     ● START / ▓ CHANCE
 *             └──────────────┘
 *                            ↓ 先端 z=8.24 から受け皿へ = クレジット
 */
export class PayoutChute {
  constructor(scene, world, RAPIER) {
    this.world = world;
    this.RAPIER = RAPIER;

    // 坂の姿勢。全部この剛体にぶら下げるので、板も穴も一緒の平面に乗る
    const h = B.rx / 2;
    this.quat = new THREE.Quaternion(Math.sin(h), 0, 0, Math.cos(h));

    const bodyDesc = RAPIER.RigidBodyDesc.fixed()
      .setTranslation(B.x, B.y, B.z)
      .setRotation({ x: Math.sin(h), y: 0, z: 0, w: Math.cos(h) });
    this.body = world.createRigidBody(bodyDesc);

    this.group = new THREE.Group();
    this.group.position.set(B.x, B.y, B.z);
    this.group.quaternion.copy(this.quat);
    scene.add(this.group);

    this.mat = new THREE.MeshStandardMaterial({
      color: 0x232c3e, metalness: 0.7, roughness: 0.38,
    });
    this.matStart = new THREE.MeshStandardMaterial({
      color: 0x1a2436, emissive: 0x5cc8ff, emissiveIntensity: 1.9, roughness: 0.4,
    });
    this.matChance = new THREE.MeshStandardMaterial({
      color: 0x2a1520, emissive: 0xffb03a, emissiveIntensity: 1.5, roughness: 0.4,
    });

    this._build();
    this._buildFlippers(scene, world, RAPIER);
  }

  /** 坂のローカル座標 (中心が原点、傾ける前) で箱を1つ足す */
  _piece(cx, cz, w, d, o = {}) {
    if (w <= 0.001 || d <= 0.001) return;
    const h = o.h ?? B.h;
    const dy = o.dy ?? 0;

    if (!o.visualOnly) {
      const col = this.RAPIER.ColliderDesc
        .cuboid(w / 2, h / 2, d / 2)
        .setTranslation(cx, dy, cz)
        // 坂の摩擦は低めに。転がり落ちる速さがそのまま「払い出しの気持ちよさ」になる
        .setFriction(0.16)
        .setRestitution(0.02);
      this.world.createCollider(col, this.body);
    }
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), o.material ?? this.mat);
    mesh.position.set(cx, dy, cz);
    mesh.receiveShadow = true;
    this.group.add(mesh);
  }

  /**
   * 坂を組む。
   * 穴の前後の縁で横帯に切り、帯ごとに「その帯を横切っている穴」を抜いた残りを並べる。
   * こうしておくと穴をどこに足しても埋めの箱を手で足さずに済む。
   */
  _build() {
    const halfW = B.w / 2, halfD = B.d / 2;
    const top = B.h / 2;
    const cuts = CH.slots.map((s) => ({ ...s, z0: s.dz0, z1: s.dz1 }));

    const edges = new Set([-halfD, halfD]);
    for (const c of cuts) { edges.add(c.z0); edges.add(c.z1); }
    const zs = [...edges].sort((a, b) => a - b);

    for (let i = 0; i < zs.length - 1; i++) {
      const za = zs[i], zb = zs[i + 1];
      if (zb - za < 0.001) continue;
      const zc = (za + zb) / 2;
      const active = cuts.filter((c) => c.z0 <= zc && c.z1 >= zc).sort((a, b) => a.x0 - b.x0);
      let cursor = -halfW;
      for (const c of active) {
        this._piece((cursor + c.x0) / 2, zc, c.x0 - cursor, zb - za);
        cursor = Math.max(cursor, c.x1);
      }
      this._piece((cursor + halfW) / 2, zc, halfW - cursor, zb - za);
    }

    // 左右の縁。滑り落ちる途中で横へこぼれると、判定の外に出てしまう
    for (const sx of [-1, 1]) {
      this._piece(sx * (halfW + 0.12), 0, 0.24, B.d, { dy: top + 0.15, h: 0.5 });
    }

    // 穴の縁を光らせる (見た目だけ)
    for (const c of cuts) {
      const material = c.kind === 'start' ? this.matStart : this.matChance;
      const cx = (c.x0 + c.x1) / 2, w = c.x1 - c.x0, hw = w / 2;
      const cz = (c.z0 + c.z1) / 2, d = c.z1 - c.z0;
      for (const sx of [-1, 1]) {
        this._piece(cx + sx * (hw + 0.05), cz, 0.09, d,
          { material, visualOnly: true, dy: top - 0.02, h: 0.09 });
      }
      for (const sz of [-1, 1]) {
        this._piece(cx, cz + sz * (d / 2 + 0.05), w + 0.19, 0.09,
          { material, visualOnly: true, dy: top - 0.02, h: 0.09 });
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* フリッパー                                                          */
  /* ------------------------------------------------------------------ */

  _buildFlippers(scene, world, RAPIER) {
    this.flipperOpen = 0;
    this.flipperTarget = 0;
    this.flipperTimer = 0;
    this.flippers = [];
    if (!F.enabled) return;

    this.flipperMat = new THREE.MeshStandardMaterial({
      color: 0x27324a, metalness: 0.85, roughness: 0.28,
      emissive: 0x5cc8ff, emissiveIntensity: 0.2,
    });

    for (const sx of [-1, 1]) {
      // 坂のローカル座標 → world。板は坂の傾きに乗せたうえで、
      // 坂の法線まわり (ローカル Y) に回して漏斗を作る
      const local = new THREE.Vector3(sx * F.x, F.dy, F.dz);
      const pos = local.clone().applyQuaternion(this.quat).add(new THREE.Vector3(B.x, B.y, B.z));

      const bodyDesc = RAPIER.RigidBodyDesc
        .kinematicPositionBased()
        .setTranslation(pos.x, pos.y, pos.z)
        .setRotation({ x: this.quat.x, y: this.quat.y, z: this.quat.z, w: this.quat.w });
      const body = world.createRigidBody(bodyDesc);

      const col = RAPIER.ColliderDesc
        .cuboid(F.thickness / 2, F.height / 2, F.length / 2)
        .setFriction(0.12)
        .setRestitution(0.05);
      world.createCollider(col, body);

      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(F.thickness, F.height, F.length), this.flipperMat
      );
      mesh.position.copy(pos);
      mesh.quaternion.copy(this.quat);
      mesh.castShadow = true;
      scene.add(mesh);

      // 右の板 (sx=+1) を ry 負に回すと、手前側が内へ寄って漏斗になる
      this.flippers.push({ body, mesh, pos, sign: -sx, quat: new THREE.Quaternion() });
    }
    this._applyFlippers();
  }

  _applyFlippers() {
    for (const p of this.flippers) {
      _spin.setFromAxisAngle(AXIS_Y, p.sign * F.angle * this.flipperOpen);
      p.quat.copy(this.quat).multiply(_spin);
      p.body.setNextKinematicRotation({ x: p.quat.x, y: p.quat.y, z: p.quat.z, w: p.quat.w });
    }
    if (this.flipperMat) this.flipperMat.emissiveIntensity = 0.2 + this.flipperOpen * 1.4;
  }

  get flippersOpen() { return this.flipperOpen > 0.5; }

  /** チャンスチャッカー入賞。開いている最中ならタイマーを延長する */
  triggerFlippers() {
    if (!F.enabled) return;
    this.flipperTimer = F.seconds;
    this.flipperTarget = 1;
  }

  foldFlippers() {
    this.flipperTimer = 0;
    this.flipperTarget = 0;
  }

  /** 物理ステップ側 */
  update(dt) {
    if (!F.enabled) return;
    if (this.flipperTimer > 0) {
      this.flipperTimer -= dt;
      if (this.flipperTimer <= 0) { this.flipperTimer = 0; this.flipperTarget = 0; }
    }
    if (this.flipperOpen !== this.flipperTarget) {
      const d = this.flipperTarget - this.flipperOpen;
      const step = (F.speed / Math.max(0.01, F.angle)) * dt;
      this.flipperOpen += Math.abs(d) <= step ? d : Math.sign(d) * step;
      this._applyFlippers();
    }
  }

  /** 描画側 */
  syncMesh() {
    for (const p of this.flippers) p.mesh.quaternion.copy(p.quat);
  }
}
