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
 *
 * ─────────────────────────────────────────────────────────────
 * 位相は「絶対時刻から計算」ではなく「積分」で持つ (DESIGN_GIMMICKS.md §3.3)
 *
 *   旧: z = baseZ + strokeHalf * sin(2π t / period)
 *
 * これだと period を実行中に変えた瞬間に位相が飛び、プッシャーが瞬間移動する。
 * フィーバーで period を 1.9 → 1.5 に変える以上、この形は使えない。
 *
 *   新: phase += 2π dt / period    (period が変わっても位相は連続)
 *
 * 振幅 (strokeHalf) のほうは位相が連続なら途中で変えても飛ばないが、
 * それでも段差が出るので tau 秒かけて滑らかに寄せている。
 * ─────────────────────────────────────────────────────────────
 */
export class Pusher {
  constructor(scene, world, RAPIER) {
    const box = L.pusher;
    this.baseX = box.x;
    this.baseY = box.y;
    this.baseZ = box.z;

    // --- 駆動の状態 ---
    this.phase = -Math.PI / 2;        // 後退端から始める
    this.z = this.baseZ - CFG.pusher.strokeHalf;
    this.prevZ = this.z;
    this.strokeHalf = CFG.pusher.strokeHalf;
    this.period = CFG.pusher.period;
    /** フィーバー中などに駆動を上書きする。null なら CFG の値へ戻る */
    this.override = null;
    /** 'run' = 往復 / 'hold' = 指定位置へゆっくり動いて止まる (JP 演出) */
    this.mode = 'run';
    this._holdZ = this.z;
    this._holdSpeed = 1.0;

    const bodyDesc = RAPIER.RigidBodyDesc
      .kinematicPositionBased()
      .setTranslation(box.x, box.y, this.z);
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
    this.group.position.set(box.x, box.y, this.z);
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
    this.edgeMat = new THREE.MeshStandardMaterial({
      color: 0x1a2436, emissive: 0x5cc8ff, emissiveIntensity: 1.6, roughness: 0.4,
    });
    const edge = new THREE.Mesh(new THREE.BoxGeometry(13.98, 0.16, 0.12), this.edgeMat);
    edge.position.set(0, box.h / 2 - 0.1, box.d / 2 + 0.02);
    this.group.add(edge);
  }

  /* ------------------------------------------------------------------ */
  /* 駆動の切り替え                                                       */
  /* ------------------------------------------------------------------ */

  /** 指定位置までゆっくり動いて止まる (JP 演出の「引っ込む」「押しに行く」) */
  hold(targetZ, speed = 1.0) {
    this.mode = 'hold';
    this._holdZ = targetZ;
    this._holdSpeed = speed;
  }

  /** 往復に戻す。いまの z から位相を復元するので継ぎ目が出ない */
  run() {
    if (this.mode === 'run') return;
    this.mode = 'run';
    const s = Math.max(0.001, this.strokeHalf);
    this.phase = Math.asin(THREE.MathUtils.clamp((this.z - this.baseZ) / s, -1, 1));
  }

  /** 後退端 (背面壁のいちばん奥) の z */
  get rearZ() { return this.baseZ - this.strokeHalf; }

  /** 前面 (メダルを押す面) の z。物理側の最新値 */
  frontZ() { return this.z + L.pusher.d / 2; }

  /* ------------------------------------------------------------------ */
  /* 更新                                                                */
  /* ------------------------------------------------------------------ */

  /**
   * 物理ステップ側。次ステップの目標位置を与える。
   * @param {number} dt 固定タイムステップ
   */
  update(dt) {
    this.prevZ = this.z;

    // 駆動パラメータを目標値へ滑らかに寄せる。
    // 一気に差し替えると振幅が段差になってメダルを弾く
    const tgtStroke = this.override ? this.override.strokeHalf : CFG.pusher.strokeHalf;
    const tgtPeriod = this.override ? this.override.period : CFG.pusher.period;
    const k = Math.min(1, dt / 0.25);
    this.strokeHalf += (tgtStroke - this.strokeHalf) * k;
    this.period += (tgtPeriod - this.period) * k;

    if (this.mode === 'hold') {
      const step = this._holdSpeed * dt;
      const d = this._holdZ - this.z;
      this.z += Math.abs(d) <= step ? d : Math.sign(d) * step;
    } else {
      this.phase += (2 * Math.PI * dt) / Math.max(0.05, this.period);
      if (this.phase > Math.PI * 2) this.phase -= Math.PI * 2;
      this.z = this.baseZ + this.strokeHalf * Math.sin(this.phase);
    }

    this.body.setNextKinematicTranslation({ x: this.baseX, y: this.baseY, z: this.z });
  }

  /** 描画側。物理の prev/curr を alpha で補間する (メダルと足並みを揃える) */
  syncMesh(alpha) {
    this.group.position.z = this.prevZ + (this.z - this.prevZ) * alpha;
  }

  /** 前面ラインの色。フィーバー中だけ変える */
  setEdgeColor(hex) {
    this.edgeMat.emissive.setHex(hex);
  }
}
