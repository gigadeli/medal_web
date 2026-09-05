import * as THREE from 'three';
import { CFG } from '../config.js';

const P = CFG.launcher;
const L = CFG.layout;
const G = Math.abs(CFG.physics.gravity);

/**
 * メダルの発射装置 (DESIGN.md §7.2)
 *
 * 手前の発射口から上段デッキへメダルを撃ち上げる。
 * 上から落としていた頃と違い、**投入 x を直接は選べない**。
 * 狙いは一定の速さで左右に首を振り続け、プレイヤーが決めるのは撃つ瞬間だけ。
 *
 * ・クリック / Space で1枚。長押しで連続 (クールダウン 0.16秒)
 * ・首振りは三角波。端で減速する正弦波だと、端に置くのだけが簡単になる
 * ・着地点のリングと軌道のガイドを常に出す。
 *   狙って撃つ台なので、どこに落ちるか分からないままでは「タイミングを狙う」に
 *   ならない。ガイドは実際に飛ぶのと同じ積分で引いている
 *
 * ■ 初速は着地点から逆算している
 *   メダルには線形減衰が掛かり、Rapier の位置積分も単純なオイラー法ではない。
 *   放物線の公式で出した初速だと着地点が 0.4 unit ずれるので、
 *   物理とまったく同じ積分を回して二分探索している。
 */
export class Launcher {
  constructor(scene, domElement, pool, hooks = {}) {
    this.dom = domElement;
    this.pool = pool;
    // 持ち枚数が尽きていれば撃たせない。TILT 中もここで止める
    this.canInsert = hooks.canInsert || (() => true);
    this.onInsert = hooks.onInsert || (() => {});
    // 特殊メダル (DESIGN_GIMMICKS.md §3.7)。null を返せば通常メダル
    this.getSpawnOptions = hooks.getSpawnOptions || (() => null);

    this.yaw = 0;
    this.phase = 0;
    this.cooldown = 0;
    this.pending = false;   // 短いクリックを取りこぼさないためのラッチ
    this.inserted = 0;
    this.holding = false;
    this._recoil = 0;

    // 着地点 (上段デッキの天面) に届く初速と、その軌道。
    // 距離も高さも「首の位置」から測る。メダルが出るのは砲身の先なので、
    // その手出しぶんを積分の初期値に入れておかないと 0.8 unit 先まで飛ぶ (実測)
    const solved = solveShot(L.deckHeight, P.z - P.landZ);
    this.speed = solved.speed;
    this.path = solved.path;          // [{h, y}]。h は水平距離
    this.range = solved.range;

    this._buildMesh(scene);
    this._bind();
  }

  /* ------------------------------------------------------------------ */

  _buildMesh(scene) {
    this.group = new THREE.Group();
    this.group.position.set(P.x, P.y, P.z);
    scene.add(this.group);

    this.matBody = new THREE.MeshStandardMaterial({
      color: 0x8e9ab2, metalness: 0.9, roughness: 0.28,
    });
    this.matGlow = new THREE.MeshStandardMaterial({
      color: 0x1a2436, emissive: 0x5cc8ff, emissiveIntensity: 1.6, roughness: 0.4,
    });

    // 首 (台座)。ここを軸に左右へ振る
    const base = new THREE.Mesh(
      new THREE.CylinderGeometry(0.30, 0.36, 0.26, 16), this.matBody
    );
    base.position.y = -0.16;
    this.group.add(base);

    // 砲身。仰角のぶんだけ倒して付ける
    this.barrel = new THREE.Group();
    this.group.add(this.barrel);

    const tube = new THREE.Mesh(
      new THREE.CylinderGeometry(0.20, 0.24, P.barrel, 14), this.matBody
    );
    // 円柱は Y 軸が長さ方向。仰角ぶん倒して -Z を向かせる
    tube.rotation.x = -(Math.PI / 2 - P.elevation);
    tube.position.set(0, Math.sin(P.elevation) * P.barrel * 0.5, -Math.cos(P.elevation) * P.barrel * 0.5);
    this.barrel.add(tube);

    // 砲口の光るリング。特殊メダルを選ぶと色が変わる
    const muzzle = new THREE.Mesh(
      new THREE.TorusGeometry(0.22, 0.05, 8, 20), this.matGlow
    );
    muzzle.rotation.x = P.elevation;
    muzzle.position.copy(aimVector(0).multiplyScalar(P.barrel));
    this.barrel.add(muzzle);

    // 着地点のリング。
    // **山に埋もれさせない**。デッキの天面に置くので、メダルが積もると
    // 完全に隠れてしまう。狙いを見せるための印なので、深度テストを切って
    // 常に手前に描く (照準としてはこのほうが正しい)
    this.marker = new THREE.Group();
    this.marker.renderOrder = 900;
    scene.add(this.marker);
    this.ringMat = new THREE.MeshBasicMaterial({
      color: 0x5cc8ff, transparent: true, opacity: 0.85,
      depthTest: false, depthWrite: false, toneMapped: false,
    });
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(P.markerR, 0.07, 8, 28), this.ringMat
    );
    ring.rotation.x = Math.PI / 2;
    ring.renderOrder = 900;
    this.marker.add(ring);

    // 軌道のガイド。毎フレーム首振りに合わせて書き換える
    this.guideMat = new THREE.LineBasicMaterial({
      color: 0x5cc8ff, transparent: true, opacity: 0.45,
      depthTest: false, depthWrite: false, toneMapped: false,
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(
      new Float32Array(this.path.length * 3), 3
    ));
    this.guide = new THREE.Line(geo, this.guideMat);
    this.guide.frustumCulled = false;
    this.guide.renderOrder = 899;
    scene.add(this.guide);
  }

  _bind() {
    const dom = this.dom;

    this._onDown = (e) => {
      if (e.button !== 0) return;   // 右/中ボタンは視点操作
      this.holding = true;
      this.pending = true;          // 押した瞬間の1枚は必ず出す
      this.cooldown = 0;
    };
    this._onUp = () => { this.holding = false; };

    this._onKeyDown = (e) => {
      if (e.code === 'Space') {
        if (!this.holding) this.pending = true;
        this.holding = true;
        e.preventDefault();
      }
    };
    this._onKeyUp = (e) => {
      if (e.code === 'Space') this.holding = false;
    };

    dom.addEventListener('pointerdown', this._onDown);
    window.addEventListener('pointerup', this._onUp);
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    dom.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  /* ------------------------------------------------------------------ */

  /** 物理ステップと同じ固定 dt で呼ぶ */
  update(dt) {
    // 首振り。三角波なので、どこを狙うにも同じ「読み」で済む
    this.phase = (this.phase + dt / P.period) % 1;
    this.yaw = P.yawRange * (1 - 4 * Math.abs(((this.phase + 0.25) % 1) - 0.5));

    if (this._recoil > 0) this._recoil = Math.max(0, this._recoil - dt / 0.12);

    this.cooldown -= dt;
    if ((this.pending || this.holding) && this.cooldown <= 0) {
      // 空きの確認を先に済ませる。特殊メダルの手持ちを減らしてから
      // 満杯で弾かれると、1枚が黙って消えることになる
      if (this.canInsert() && this.pool.freeCount > 0) this._fire();
      this.pending = false;
    }
  }

  _fire() {
    const dir = aimVector(this.yaw);
    const from = dir.clone().multiplyScalar(P.barrel).add(this.group.position);
    const opts = Object.assign({}, this.getSpawnOptions(), {
      vel: {
        x: dir.x * this.speed,
        y: dir.y * this.speed,
        z: dir.z * this.speed,
      },
    });

    const medal = this.pool.spawn(from.x, from.y, from.z, opts);
    if (!medal) return;
    this.inserted++;
    this.cooldown = CFG.input.dropCooldown;
    this._recoil = 1;
    this.onInsert(medal);
  }

  /** 特殊メダルを選んでいる間は砲口と着地リングの色を変える */
  setMarkerColor(hex) {
    if (this._markerColor === hex) return;
    this._markerColor = hex;
    this.ringMat.color.setHex(hex);
    this.matGlow.emissive.setHex(hex);
    this.guideMat.color.setHex(hex);
  }

  syncMesh() {
    // 符号に注意。three.js の Y 回転は +角度で -Z を **-X 側**へ回すが、
    // 弾道側 (aimVector) は yaw が正なら +X へ飛ばす。
    // ここを同符号にすると、砲身は左を向いているのにメダルは右へ飛ぶ
    this.group.rotation.y = -this.yaw;
    this.barrel.position.copy(aimVector(0)).multiplyScalar(-this._recoil * P.recoil);

    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    const px = this.group.position.x, py = this.group.position.y, pz = this.group.position.z;

    // 軌道ガイド (首振りに合わせて回すだけ)
    const arr = this.guide.geometry.attributes.position.array;
    for (let i = 0; i < this.path.length; i++) {
      const p = this.path[i];
      arr[i * 3] = px + p.h * sin;
      arr[i * 3 + 1] = py + p.y;
      arr[i * 3 + 2] = pz - p.h * cos;
    }
    this.guide.geometry.attributes.position.needsUpdate = true;
    this.guide.geometry.computeBoundingSphere();

    this.marker.position.set(px + this.range * sin, L.deckHeight + 0.05, pz - this.range * cos);
  }

  dispose() {
    this.dom.removeEventListener('pointerdown', this._onDown);
    window.removeEventListener('pointerup', this._onUp);
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
  }
}

/** 首の角度 yaw における発射方向 (単位ベクトル) */
function aimVector(yaw) {
  const c = Math.cos(P.elevation);
  return new THREE.Vector3(Math.sin(yaw) * c, Math.sin(P.elevation), -Math.cos(yaw) * c);
}

/**
 * 「着地点 (targetY, 水平距離 targetH) に落ちる初速」を数値で求める。
 *
 * 放物線の式では合わない。線形減衰が掛かっているうえ、Rapier は位置を
 * 「更新前後の速度の平均」で進めるので、素直なオイラー法だと1回の飛翔で
 * 0.4 unit ぶん短く見積もる (実測)。物理と同じ刻み・同じ順序で回して二分探索する。
 *
 * @returns {{speed:number, range:number, path:Array<{h:number,y:number}>}}
 *   range は発射口から着地点までの水平距離、path は軌道 (発射口からの相対)
 */
function solveShot(targetY, targetH) {
  // 砲身の先 (首からの相対)
  const h0 = Math.cos(P.elevation) * P.barrel;
  const y0 = Math.sin(P.elevation) * P.barrel;

  const fly = (speed, dt = CFG.physics.timestep) => {
    const damp = CFG.medal.linearDamping;
    let h = h0, y = y0;
    let vh = Math.cos(P.elevation) * speed;
    let vy = Math.sin(P.elevation) * speed;
    const path = [{ h, y }];
    const yEnd = targetY - P.y;
    for (let i = 0; i < 4000; i++) {
      const vh0 = vh, vy0 = vy, hPrev = h, yPrev = y;
      vy -= G * dt;
      const k = 1 / (1 + damp * dt);
      vh *= k; vy *= k;
      // 位置は「更新前後の速度の平均」で進める。Rapier がそう積分している
      h += ((vh0 + vh) / 2) * dt;
      y += ((vy0 + vy) / 2) * dt;
      path.push({ h, y });
      if (vy < 0 && y <= yEnd) {
        // 着地は1ステップの途中で起きる。刻んだままの h を返すと
        // 飛距離が 0.6 unit 単位の階段になり、二分探索が段差に落ちる
        const f = (yPrev - yEnd) / (yPrev - y);
        return { h: hPrev + (h - hPrev) * f, y: yEnd, path };
      }
    }
    return { h, y, path };
  };

  let lo = 5, hi = 200;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (fly(mid).h < targetH) lo = mid; else hi = mid;
  }
  const speed = (lo + hi) / 2;
  const res = fly(speed);

  // ガイドの線は物理より細かい刻みで引く。
  // 飛翔は 0.18秒 = 物理11ステップしかないので、そのまま結ぶとカクカクになる
  const fine = fly(speed, CFG.physics.timestep / 6);
  const path = [];
  const step = Math.max(1, Math.floor(fine.path.length / P.guidePoints));
  for (let i = 0; i < fine.path.length; i += step) path.push(fine.path[i]);
  path.push(fine.path[fine.path.length - 1]);

  return { speed, range: res.h, path };
}
