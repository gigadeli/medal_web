import * as THREE from 'three';
import { CFG } from '../config.js';
import { rnd } from '../core/Rng.js';

const B = CFG.ball;
const L = CFG.layout;

/**
 * 抽選ボール1個。
 *
 * フィールドを転がる大きな球で、メダルと同じようにプッシャーに押される。
 * 手前の払い出し口に落ちるとスロットが回り、少し待って上段に戻ってくる。
 * サイドポケットに落ちた場合は抽選なし（ハズレ）。
 *
 * メダルのプールとは別管理。Payout の走査対象にも入れていないので、
 * ボールが落ちてもクレジットは増えない。
 *
 * 状態は3つ:
 *   settling  戻ってきた直後。その場に落ち着かせている最中で、落下判定はしない
 *   live      通常。押されて動き、落ちたら抽選
 *   returning 落ちた後。returnDelay 経過で戻る
 */
export class LotteryBall {
  /** @param {number} index 0..count-1。戻る位置を左右に振り分けるのに使う */
  constructor(scene, world, RAPIER, index = 0) {
    this.index = index;

    const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(this._homeX(), B.spawnY, B.spawnZ)
      .setLinearDamping(0.12)
      .setAngularDamping(0.20)
      .setCcdEnabled(true)
      .setCanSleep(false);   // 数が少ないので常時起こしておく。見失うと復帰させにくい
    this.body = world.createRigidBody(bodyDesc);

    const colDesc = RAPIER.ColliderDesc.ball(B.radius)
      .setDensity(B.density)
      .setFriction(B.friction)
      .setRestitution(B.restitution);
    this.collider = world.createCollider(colDesc, this.body);

    const mat = new THREE.MeshStandardMaterial({
      color: 0x123244,
      emissive: B.color,
      emissiveIntensity: 1.15,
      metalness: 0.35,
      roughness: 0.22,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(B.radius, 24, 16), mat);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    scene.add(this.mesh);

    this.prevP = new THREE.Vector3();
    this.currP = new THREE.Vector3();
    this.prevQ = new THREE.Quaternion();
    this.currQ = new THREE.Quaternion();
    this._lastPos = new THREE.Vector3();
    this._stuck = 0;

    this.state = 'live';
    this.timer = 0;
    this.nudges = 0;

    this.respawn();
  }

  /** 戻る位置。3個が同じところに落ちて団子にならないよう左右に振り分ける */
  _homeX() {
    const n = Math.max(1, B.count);
    const slot = n === 1 ? 0 : (this.index / (n - 1)) * 2 - 1;   // -1 .. +1
    return slot * B.spawnXRange * 0.75 + (rnd() - 0.5) * 1.2;
  }

  respawn() {
    this.collider.setEnabled(true);
    // 落ち着かせている間は摩擦を上げ、跳ねないようにする
    this.collider.setFriction(B.settleFriction);
    this.collider.setRestitution(B.settleRestitution);

    const x = this._homeX();
    this.body.setTranslation({ x, y: B.spawnY, z: B.spawnZ }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);   // 回転を与えない。与えると着地して即転がり出す
    this.body.wakeUp();

    this.currP.set(x, B.spawnY, B.spawnZ);
    this.prevP.copy(this.currP);
    this.currQ.identity();
    this.prevQ.identity();
    this._lastPos.copy(this.currP);
    this._stuck = 0;

    this.state = 'settling';
    this.timer = B.settleSeconds;
    this.mesh.visible = true;
  }

  _park() {
    this.collider.setEnabled(false);
    this.body.setTranslation({ x: 0, y: -500 - this.index * 3, z: 0 }, false);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, false);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, false);
    this.mesh.visible = false;
  }

  _capture() {
    this.prevP.copy(this.currP);
    this.prevQ.copy(this.currQ);
    const t = this.body.translation();
    const r = this.body.rotation();
    this.currP.set(t.x, t.y, t.z);
    this.currQ.set(r.x, r.y, r.z, r.w);
  }

  /**
   * 物理ステップ直後に呼ぶ。
   * @returns {'payout'|'pocket'|null} 落ちた先。落ちていなければ null
   */
  update(dt) {
    this._capture();

    if (this.state === 'returning') {
      this.timer -= dt;
      if (this.timer <= 0) this.respawn();
      return null;
    }

    if (this.state === 'settling') {
      // 回転を殺し、横方向の速度だけ減衰させる (落下は妨げない)
      this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
      const v = this.body.linvel();
      this.body.setLinvel({ x: v.x * B.settleDamp, y: v.y, z: v.z * B.settleDamp }, true);

      this.timer -= dt;
      if (this.timer <= 0) {
        this.state = 'live';
        this.collider.setFriction(B.friction);
        this.collider.setRestitution(B.restitution);
        this._lastPos.copy(this.currP);
        this._stuck = 0;
      }
      return null;   // 落ち着かせている間は落下判定をしない
    }

    // --- live ---
    // メダルの山に埋もれて動かなくなることがあるので、止まりすぎたら小突く
    if (this.currP.distanceToSquared(this._lastPos) > 0.09) {
      this._lastPos.copy(this.currP);
      this._stuck = 0;
    } else {
      this._stuck += dt;
      if (this._stuck > B.stuckSeconds) {
        this._stuck = 0;
        this.nudges++;
        this.body.applyImpulse({
          x: (rnd() - 0.5) * B.stuckNudge,
          y: B.stuckNudge * 0.5,
          z: B.stuckNudge,
        }, true);
      }
    }

    if (this.currP.y < L.fallY) {
      // サイドポケットは z 3.0〜6.0 の左右だけ。払い出しスロープの端は違う
      const pocket = Math.abs(this.currP.x) > L.pocketX && this.currP.z < L.pocketZEnd;
      this._park();
      this.state = 'returning';
      this.timer = B.returnDelay;
      return pocket ? 'pocket' : 'payout';
    }
    return null;
  }

  syncMesh(alpha) {
    if (!this.mesh.visible) return;
    this.mesh.position.copy(this.prevP).lerp(this.currP, alpha);
    this.mesh.quaternion.copy(this.prevQ).slerp(this.currQ, alpha);
  }
}

/**
 * ボールをまとめて扱う入れ物。
 * 常に CFG.ball.count 個がフィールド（または戻り待ち）に存在する。
 */
export class LotteryBallSet {
  constructor(scene, world, RAPIER) {
    this.balls = [];
    for (let i = 0; i < CFG.ball.count; i++) {
      this.balls.push(new LotteryBall(scene, world, RAPIER, i));
    }
    // 起動直後に3個が一斉に動き出さないよう、落ち着き終わりを少しずらす
    this.balls.forEach((b, i) => { b.timer += i * 0.35; });
  }

  get nudges() { return this.balls.reduce((a, b) => a + b.nudges, 0); }

  /** @returns {{payout:number, pocket:number}} このステップで落ちた数 */
  update(dt) {
    let payout = 0, pocket = 0;
    for (const b of this.balls) {
      const fell = b.update(dt);
      if (fell === 'payout') payout++;
      else if (fell === 'pocket') pocket++;
    }
    return { payout, pocket };
  }

  syncMesh(alpha) {
    for (const b of this.balls) b.syncMesh(alpha);
  }

  respawnAll() {
    for (const b of this.balls) b.respawn();
  }

  /** lil-gui から摩擦などを変えたとき */
  applyMaterial() {
    for (const b of this.balls) {
      if (b.state === 'live') {
        b.collider.setFriction(CFG.ball.friction);
        b.collider.setRestitution(CFG.ball.restitution);
      }
    }
  }
}
