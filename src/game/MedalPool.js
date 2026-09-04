import * as THREE from 'three';
import { CFG } from '../config.js';

const L = CFG.layout;
const M = CFG.medal;

const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _scale = new THREE.Vector3(1, 1, 1);
const _mat4 = new THREE.Matrix4();
const _euler = new THREE.Euler();
const _color = new THREE.Color();

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
    // 色は instanceColor 側で持つので、マテリアルは白にしておく。
    // 特殊メダル (DESIGN_GIMMICKS.md §3.7) はこの1枚のマテリアルのまま色だけ変える
    const mat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
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

    // 通常メダルの色。instanceColor は active 配列の並び順に書くので、
    // 回収で並びが変わる以上、特殊メダルが場に居る間は毎フレーム書き直す必要がある
    this.baseColor = new THREE.Color(M.color);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(M.maxCount * 3), 3
    );
    this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    for (let i = 0; i < M.maxCount; i++) this.mesh.setColorAt(i, this.baseColor);
    this.mesh.instanceColor.needsUpdate = true;
    /** 場に特殊メダルが1枚も居なければ色の書き込みを丸ごと省く */
    this.specialCount = 0;
    this._colorDirty = false;

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
      /** 場に出ているか。特殊メダルの追跡側が寿命を判定するのに使う */
      live: false,
      /** 特殊メダル (DESIGN_GIMMICKS.md §3.7)。null なら通常メダル */
      kind: null,
      color: null,
      fuse: 0,
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
    m.live = false;
    this.clearKind(m);
  }

  /** 特殊メダルを通常メダルに戻す (ボムが爆発したとき / 回収したとき) */
  clearKind(m) {
    if (!m.kind) return;
    m.kind = null;
    m.color = null;
    m.fuse = 0;
    if (this.specialCount > 0) this.specialCount--;
    this._colorDirty = true;
  }

  get activeCount() { return this.active.length; }
  get freeCount() { return this.free.length; }

  /**
   * メダルを1枚投入する。
   * @param {object} [opts] kind: 特殊メダルの種類 / flat: 傾けずに置く (タワー建設用)
   * @returns {object|null} 投入したメダル。満杯なら null
   */
  spawn(x, y = L.spawn.y, z = L.spawn.z, opts = null) {
    // 満杯なら投入を断る。ここで既存のメダルを消すと山が痩せて
    // 「押しても落ちない」状態になるため、絶対に山からは抜かない
    if (this.free.length === 0) return null;
    const m = this.free.pop();

    m.collider.setEnabled(true);
    m.body.setTranslation({ x, y, z }, true);

    // わずかに傾け、ランダムに回しておくと山が単調にならない。
    // タワーを積むときだけは水平に置く (重なった姿勢で生成すると弾け飛ぶ)
    const jitter = opts && opts.flat ? 0 : 0.35;
    _euler.set(
      (Math.random() - 0.5) * jitter,
      Math.random() * Math.PI * 2,
      (Math.random() - 0.5) * jitter
    );
    _quat.setFromEuler(_euler);
    m.body.setRotation({ x: _quat.x, y: _quat.y, z: _quat.z, w: _quat.w }, true);

    m.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    const spin = opts && opts.flat ? 0 : 1;
    m.body.setAngvel({
      x: (Math.random() - 0.5) * 2 * spin,
      y: (Math.random() - 0.5) * 6,
      z: (Math.random() - 0.5) * 2 * spin,
    }, true);
    m.body.wakeUp();
    m.counted = false;
    m.live = true;

    if (opts && opts.kind) {
      m.kind = opts.kind;
      m.color = opts.color;
      m.fuse = opts.fuse || 0;
      this.specialCount++;
      this._colorDirty = true;
    }

    m.currP.set(x, y, z);
    m.prevP.copy(m.currP);
    m.currQ.copy(_quat);
    m.prevQ.copy(_quat);

    this.active.push(m);
    return m;
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
    // 特殊メダルが1枚でも場に居ると、回収のたびに並びが変わるので色を書き直す。
    // 1枚も居なければ全部が既定色のままなので、書き込みごと省略できる
    const paint = this.specialCount > 0 || this._colorDirty;

    for (let i = 0; i < n; i++) {
      const m = this.active[i];
      _pos.copy(m.prevP).lerp(m.currP, alpha);
      _quat.copy(m.prevQ).slerp(m.currQ, alpha);
      _mat4.compose(_pos, _quat, _scale);
      this.mesh.setMatrixAt(i, _mat4);
      if (paint) {
        if (m.color !== null && m.color !== undefined) _color.setHex(m.color);
        else _color.copy(this.baseColor);
        this.mesh.setColorAt(i, _color);
      }
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (paint) {
      this.mesh.instanceColor.needsUpdate = true;
      this._colorDirty = false;
    }
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
