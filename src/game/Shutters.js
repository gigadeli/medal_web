import * as THREE from 'three';
import { CFG } from '../config.js';

const L = CFG.layout;

/** 収納位置 (テーブルのはるか下)。ここに居る間は盤面に一切干渉しない */
const DOWN_Y = -3.6;
/** 展開位置。天面がテーブル面 (y=0) と面一になる高さ */
const UP_Y = -0.5;

/**
 * サイドポケットのシャッター (DESIGN_GIMMICKS.md §3.3 ③)
 *
 * フィーバー中だけせり上がって、左右のサイドポケット
 * (x: ±5.5〜7.0, z: 3.0〜6.0) を塞ぐ。実測のロスト率は 26〜31% あるので、
 * 塞ぐと体感ではっきり分かる。
 *
 * 天面をテーブルより高くしないこと。段差ができると、そこで山が引っ掛かって
 * かえって流れが止まる (DESIGN.md §7.7 で手前の壁が機械を止めたのと同じ理屈)。
 */
export class Shutters {
  constructor(scene, world, RAPIER) {
    const zCenter = L.tableFront.z;
    const depth = L.tableFront.d;
    const width = 7.0 - L.pocketX;              // 1.5
    const cx = (7.0 + L.pocketX) / 2;           // 6.25

    this.open = 0;          // 0 = 収納 / 1 = 展開
    this.target = 0;
    this.speed = 2.5;       // 1/s。0.4秒で開ききる

    const mat = new THREE.MeshStandardMaterial({
      color: 0x2a3550, metalness: 0.7, roughness: 0.35,
      emissive: 0x5cc8ff, emissiveIntensity: 0.0,
    });
    this.mat = mat;

    this.parts = [];
    for (const sx of [-1, 1]) {
      const bodyDesc = RAPIER.RigidBodyDesc
        .kinematicPositionBased()
        .setTranslation(sx * cx, DOWN_Y, zCenter);
      const body = world.createRigidBody(bodyDesc);

      const col = RAPIER.ColliderDesc
        .cuboid(width / 2, L.tableFront.h / 2, depth / 2)
        .setFriction(CFG.table.friction)
        .setRestitution(CFG.table.restitution);
      world.createCollider(col, body);

      const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, L.tableFront.h, depth), mat);
      mesh.position.set(sx * cx, DOWN_Y, zCenter);
      mesh.receiveShadow = true;
      mesh.castShadow = true;
      scene.add(mesh);

      this.parts.push({ body, mesh, x: sx * cx, z: zCenter });
    }
  }

  setOpen(v) { this.target = v ? 1 : 0; }

  /** 物理ステップ側 */
  update(dt) {
    if (this.open !== this.target) {
      const d = this.target - this.open;
      const step = this.speed * dt;
      this.open += Math.abs(d) <= step ? d : Math.sign(d) * step;
    }
    const y = DOWN_Y + (UP_Y - DOWN_Y) * this.open;
    for (const p of this.parts) {
      p.body.setNextKinematicTranslation({ x: p.x, y, z: p.z });
      p.y = y;
    }
    this.mat.emissiveIntensity = this.open * 0.8;
  }

  /** 描画側 */
  syncMesh() {
    for (const p of this.parts) p.mesh.position.y = p.y ?? DOWN_Y;
  }
}
