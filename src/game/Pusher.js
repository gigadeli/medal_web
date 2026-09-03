import * as THREE from 'three';
import { CFG } from '../config.js';

const L = CFG.layout;

/**
 * プッシャー (DESIGN.md §7.1)
 *
 * 動的剛体にするとメダルの山に押し返されて止まってしまうため、
 * KinematicPositionBased (無限質量) にして位置を毎ステップ直接与える。
 *
 * 重要: setTranslation() ではなく setNextKinematicTranslation() を使うこと。
 *       前者は瞬間移動になり接触が正しく解かれず、メダルが吹き飛ぶ。
 */
export class Pusher {
  constructor(scene, world, RAPIER) {
    const box = L.pusher;
    this.baseX = box.x;
    this.baseY = box.y;
    this.baseZ = box.z;

    const bodyDesc = RAPIER.RigidBodyDesc
      .kinematicPositionBased()
      .setTranslation(box.x, box.y, box.z);
    this.body = world.createRigidBody(bodyDesc);

    const colDesc = RAPIER.ColliderDesc
      .cuboid(box.w / 2, box.h / 2, box.d / 2)
      .setFriction(CFG.pusher.friction)
      .setRestitution(CFG.pusher.restitution);
    this.collider = world.createCollider(colDesc, this.body);

    // --- 上段の左右に立てる壁 ---
    // プッシャー本体と同じ剛体に付けるので、往復に追従する。
    // 手前は塞がない。塞ぐと上段のメダルが下段に降りてこなくなり機械が止まる (§7.7)
    const wall = CFG.layout.pusherSideWall;
    this.sideWallColliders = [];
    if (wall && wall.h > 0) {
      for (const sx of [-1, 1]) {
        const wallDesc = RAPIER.ColliderDesc
          .cuboid(wall.t / 2, wall.h / 2, box.d / 2)
          .setTranslation(sx * wall.inset, box.h / 2 + wall.h / 2, 0)
          .setFriction(CFG.pusher.friction)
          .setRestitution(CFG.pusher.restitution);
        this.sideWallColliders.push(world.createCollider(wallDesc, this.body));
      }
    }

    // --- 見た目 ---
    this.group = new THREE.Group();
    this.group.position.set(box.x, box.y, box.z);
    scene.add(this.group);

    const bodyMat = new THREE.MeshStandardMaterial({
      color: 0x3c4a66, metalness: 0.72, roughness: 0.34,
    });
    // 壁に食い込ませている分は見せたくないので、見た目だけ少し細くする
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(13.98, box.h, box.d), bodyMat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.group.add(mesh);

    // 左右の壁 (見た目)
    if (wall && wall.h > 0) {
      const wallMat = new THREE.MeshStandardMaterial({
        color: 0x4a5876, metalness: 0.85, roughness: 0.28,
      });
      for (const sx of [-1, 1]) {
        const wallMesh = new THREE.Mesh(
          new THREE.BoxGeometry(wall.t, wall.h, box.d), wallMat
        );
        wallMesh.position.set(sx * wall.inset, box.h / 2 + wall.h / 2, 0);
        wallMesh.castShadow = true;
        wallMesh.receiveShadow = true;
        this.group.add(wallMesh);
      }
    }

    // 前面の光るライン (押している面がどこか一目で分かるように)
    const edge = new THREE.Mesh(
      new THREE.BoxGeometry(13.98, 0.16, 0.12),
      new THREE.MeshStandardMaterial({
        color: 0x1a2436, emissive: 0x5cc8ff, emissiveIntensity: 1.6, roughness: 0.4,
      })
    );
    edge.position.set(0, box.h / 2 - 0.1, box.d / 2 + 0.02);
    this.group.add(edge);
  }

  /** 時刻 t におけるプッシャーの z 座標 (正弦波) */
  zAt(t) {
    const p = CFG.pusher;
    return this.baseZ + p.strokeHalf * Math.sin((2 * Math.PI * t) / p.period);
  }

  /** 前面 (メダルを押す面) の z 座標 */
  frontZ(t) {
    return this.zAt(t) + L.pusher.d / 2;
  }

  /** 物理ステップ側。次ステップの目標位置を与える */
  update(t) {
    this.body.setNextKinematicTranslation({
      x: this.baseX,
      y: this.baseY,
      z: this.zAt(t),
    });
  }

  /** 描画側。補間済みの時刻で位置を再計算する (解析的に求まるので誤差ゼロ) */
  syncMesh(renderTime) {
    this.group.position.z = this.zAt(renderTime);
  }
}
