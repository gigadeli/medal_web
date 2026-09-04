import * as THREE from 'three';
import { CFG } from '../config.js';

const L = CFG.layout;

/**
 * 手前テーブル (落とし口の勾配)。DESIGN_GIMMICKS.md §3.3
 *
 * 形は元の tableFront と同じ一枚板。違いは剛体の種類だけで、
 * Fixed ではなく KinematicPositionBased にしてある。
 * フィーバー中に傾きを -0.06 → +0.04 へ倒して、山ごと手前に流すため。
 *
 * ■ 穴は開けないこと
 *   一度ここにチャッカーの穴を開けたが、機械が止まった。
 *   山は力の連鎖で前へ進むので、途中に穴があると連鎖が切れる
 *   (DESIGN.md §2.4 が上段について書いているのと同じ)。
 *   実測で場内が 231 → 410枚まで膨張し、60秒あたりの払い出しが 12枚まで落ちた。
 *   チャッカーは盤面の外 (PayoutChute) に置いてある。
 *
 * ■ 傾きを変えるときは y も一緒に動かすこと
 *   中心で回すと後端が沈み、tableMain (z=3.0) との間に段差ができて
 *   そこからメダルがこぼれる (DESIGN.md §7.6)。
 */
export class TiltTable {
  constructor(scene, world, RAPIER) {
    const base = L.tableFront;
    this.base = base;
    this.rx = base.rx ?? -L.tableFrontTilt;
    this.targetRx = this.rx;
    this.rxSpeed = 1.0;          // rad/s 相当。FeverMode が上書きする

    const bodyDesc = RAPIER.RigidBodyDesc
      .kinematicPositionBased()
      .setTranslation(base.x, this._yFor(this.rx), base.z);
    this.body = world.createRigidBody(bodyDesc);
    this._applyRotation(this.rx);

    const colDesc = RAPIER.ColliderDesc
      .cuboid(base.w / 2, base.h / 2, base.d / 2)
      .setFriction(CFG.table.friction)
      .setRestitution(CFG.table.restitution);
    world.createCollider(colDesc, this.body);

    // --- 見た目 ---
    this.group = new THREE.Group();
    this.group.position.set(base.x, this._yFor(this.rx), base.z);
    this.group.rotation.x = this.rx;
    scene.add(this.group);

    const mat = new THREE.MeshStandardMaterial({
      color: 0x2b3448, metalness: 0.55, roughness: 0.45,
    });
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(base.w, base.h, base.d), mat);
    mesh.receiveShadow = true;
    this.group.add(mesh);

    // サイドポケットの縁マーキング (穴の中には何も置かない)
    const matPocket = new THREE.MeshStandardMaterial({
      color: 0x2a1520, emissive: 0xff4d5e, emissiveIntensity: 1.2, roughness: 0.5,
    });
    for (const sx of [-1, 1]) {
      const edge = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.1, base.d), matPocket);
      edge.position.set(sx * (L.pocketX + 0.06), base.h / 2 - 0.02, 0);
      this.group.add(edge);
    }
  }

  /**
   * 傾けたときの中心 y。
   * 後端の天面が y=0 のまま tableMain と繋がるように箱ごと持ち上げる。
   */
  _yFor(rx) {
    return -0.5 + (this.base.d / 2) * Math.sin(-rx);
  }

  _applyRotation(rx) {
    const h = rx / 2;
    this.body.setNextKinematicRotation({ x: Math.sin(h), y: 0, z: 0, w: Math.cos(h) });
  }

  /**
   * 目標の傾きを指示する。実際の移動は update() が seconds 秒かけて行う。
   * 一気に回すと山に運動エネルギーを注入して吹き飛ぶ (DESIGN_GIMMICKS.md §3.3)
   */
  setTilt(rx, seconds = CFG.fever.transition) {
    this.targetRx = rx;
    this.rxSpeed = Math.abs(rx - this.rx) / Math.max(0.05, seconds);
  }

  /** 物理ステップ側 */
  update(dt) {
    if (Math.abs(this.targetRx - this.rx) > 1e-5) {
      const step = this.rxSpeed * dt;
      const d = this.targetRx - this.rx;
      this.rx += Math.abs(d) <= step ? d : Math.sign(d) * step;
    }
    // キネマティックは毎ステップ「次の位置」を与える (同じ値なら何も起きない)
    this.body.setNextKinematicTranslation({
      x: this.base.x, y: this._yFor(this.rx), z: this.base.z,
    });
    this._applyRotation(this.rx);
  }

  /** 描画側 */
  syncMesh() {
    this.group.position.y = this._yFor(this.rx);
    this.group.rotation.x = this.rx;
  }
}
