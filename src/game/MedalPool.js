import * as THREE from 'three';
import { CFG } from '../config.js';

const L = CFG.layout;
const M = CFG.medal;

const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _scale = new THREE.Vector3(1, 1, 1);
const _mat4 = new THREE.Matrix4();
const _euler = new THREE.Euler();

/**
 * メダルの剛体プール + InstancedMesh (DESIGN.md §6.3 / §6.4)
 *
 * ・起動時に上限数ぶんの剛体を作り、使わないものは地中に沈めてコライダーを無効化しておく。
 *   剛体の生成/破棄はコストが高く GC も誘発するため、実行中は作らない・壊さない。
 * ・描画は InstancedMesh 1個 = 1ドローコール。Mesh を250個置いてはいけない。
 */
export class MedalPool {
  constructor(scene, world, RAPIER) {
    this.world = world;
    this.RAPIER = RAPIER;

    const geo = new THREE.CylinderGeometry(M.radius, M.radius, M.thickness, M.segments);
    const mat = new THREE.MeshStandardMaterial({
      color: M.color,
      metalness: M.metalness,
      roughness: M.roughness,
      envMapIntensity: 1.2,
    });

    this.mesh = new THREE.InstancedMesh(geo, mat, M.maxCount);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false; // 個々の位置がバラバラなので全体で判定させない
    this.mesh.count = 0;
    scene.add(this.mesh);

    this.items = [];
    this.active = [];
    this.free = [];

    for (let i = 0; i < M.maxCount; i++) {
      this.items.push(this._createOne(i));
    }
    // 逆順に積んでおくと pop() で若い index から使われる
    for (let i = M.maxCount - 1; i >= 0; i--) this.free.push(this.items[i]);
  }

  _createOne(index) {
    const { RAPIER, world } = this;

    const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(0, -500 - index * 0.01, 0)
      .setLinearDamping(M.linearDamping)
      .setAngularDamping(M.angularDamping)
      .setCcdEnabled(CFG.physics.ccd)
      .setCanSleep(true);
    // soft-CCD: 薄くて速い物体のめり込みを安全に抑える。
    // 通常CCDより安価なので、あるバージョンなら併用する
    if (typeof bodyDesc.setSoftCcdPrediction === 'function') {
      bodyDesc.setSoftCcdPrediction(M.thickness * 4);
    }
    const body = world.createRigidBody(bodyDesc);

    // Rapier の cylinder は Y 軸が高さ方向。three.js の CylinderGeometry と一致する
    const colDesc = RAPIER.ColliderDesc
      .cylinder(M.thickness / 2, M.radius)
      .setDensity(M.density)
      .setFriction(M.friction)
      .setRestitution(M.restitution);
    // 衝突音用。しきい値を超えた接触だけイベントが飛ぶ
    if (RAPIER.ActiveEvents && typeof colDesc.setActiveEvents === 'function') {
      colDesc.setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS);
      if (typeof colDesc.setContactForceEventThreshold === 'function') {
        colDesc.setContactForceEventThreshold(CFG.audio.impactThreshold);
      }
    }

    const collider = world.createCollider(colDesc, body);

    const m = {
      index,
      body,
      collider,
      // 描画補間用
      prevP: new THREE.Vector3(),
      currP: new THREE.Vector3(),
      prevQ: new THREE.Quaternion(),
      currQ: new THREE.Quaternion(),
      counted: false,
      parkX: (index % 20) * 3 - 30,
      parkZ: Math.floor(index / 20) * 3,
    };
    this._park(m);
    return m;
  }

  _park(m) {
    m.collider.setEnabled(false);
    m.body.setTranslation({ x: m.parkX, y: -500, z: m.parkZ }, false);
    m.body.setLinvel({ x: 0, y: 0, z: 0 }, false);
    m.body.setAngvel({ x: 0, y: 0, z: 0 }, false);
    m.body.sleep();
    m.counted = false;
  }

  get activeCount() { return this.active.length; }
  get freeCount() { return this.free.length; }

  /**
   * メダルを1枚投入する。空きが無ければ最も古いものを再利用する。
   * @returns {boolean} 実際に投入できたか
   */
  spawn(x, y = L.spawn.y, z = L.spawn.z) {
    // 満杯なら投入を断る。ここで既存のメダルを消すと山が痩せて
    // 「押しても落ちない」状態になるため、絶対に山からは抜かない
    if (this.free.length === 0) return false;
    const m = this.free.pop();

    m.collider.setEnabled(true);
    m.body.setTranslation({ x, y, z }, true);

    // わずかに傾け、ランダムに回しておくと山が単調にならない
    _euler.set(
      (Math.random() - 0.5) * 0.35,
      Math.random() * Math.PI * 2,
      (Math.random() - 0.5) * 0.35
    );
    _quat.setFromEuler(_euler);
    m.body.setRotation({ x: _quat.x, y: _quat.y, z: _quat.z, w: _quat.w }, true);

    m.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    m.body.setAngvel({
      x: (Math.random() - 0.5) * 2,
      y: (Math.random() - 0.5) * 6,
      z: (Math.random() - 0.5) * 2,
    }, true);
    m.body.wakeUp();
    m.counted = false;

    m.currP.set(x, y, z);
    m.prevP.copy(m.currP);
    m.currQ.copy(_quat);
    m.prevQ.copy(_quat);

    this.active.push(m);
    return true;
  }

  /** active 配列の index 番目を回収する (swap-remove) */
  recycleAt(i) {
    const m = this.active[i];
    this._park(m);
    const last = this.active.pop();
    if (i < this.active.length) this.active[i] = last;
    this.free.push(m);
    return m;
  }

  /** 物理ステップ直後に呼ぶ。prev ← curr、curr ← 剛体の最新値 */
  captureTransforms() {
    for (let i = 0; i < this.active.length; i++) {
      const m = this.active[i];
      m.prevP.copy(m.currP);
      m.prevQ.copy(m.currQ);
      const t = m.body.translation();
      const r = m.body.rotation();
      m.currP.set(t.x, t.y, t.z);
      m.currQ.set(r.x, r.y, r.z, r.w);
    }
  }

  /**
   * プッシャー前面の近くで眠っているメダルを起こす保険。
   * Rapier は動くキネマティックと接触した剛体を自動で起こすが、
   * 接触が始まる直前は眠ったままのことがある。
   */
  wakeNear(frontZ) {
    for (let i = 0; i < this.active.length; i++) {
      const m = this.active[i];
      if (m.body.isSleeping() && Math.abs(m.currP.z - frontZ) < 2.5) m.body.wakeUp();
    }
  }

  /** 描画。prev と curr を alpha で補間して InstancedMesh に流し込む */
  sync(alpha) {
    const n = this.active.length;
    for (let i = 0; i < n; i++) {
      const m = this.active[i];
      _pos.copy(m.prevP).lerp(m.currP, alpha);
      _quat.copy(m.prevQ).slerp(m.currQ, alpha);
      _mat4.compose(_pos, _quat, _scale);
      this.mesh.setMatrixAt(i, _mat4);
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  /** デバッグ用: 全部片付ける */
  clear() {
    while (this.active.length) this.recycleAt(this.active.length - 1);
  }

  /** 摩擦などを実行中に変更する (lil-gui から) */
  applyMaterial() {
    for (const m of this.items) {
      m.collider.setFriction(M.friction);
      m.collider.setRestitution(M.restitution);
      m.body.setLinearDamping(M.linearDamping);
      m.body.setAngularDamping(M.angularDamping);
    }
  }
}
