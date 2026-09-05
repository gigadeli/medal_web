import * as THREE from 'three';
import { CFG } from '../config.js';
import { rnd } from '../core/Rng.js';

const K = CFG.kuruun;
const D = K.dish;
const H = K.hole;
const E = K.entry;
const BALL = K.ball;

/** 重力の大きさ。CFG.physics.gravity は下向き(負)で持っている */
const G = Math.abs(CFG.physics.gravity);

/**
 * 転がる球の慣性。滑らずに転がる球は位置エネルギーの 2/7 が回転に行くので、
 * 斜面に沿う加速度は滑る物体の 5/7 になる。
 */
const ROLL = 5 / 7;

/** 段の皿の谷の高さ (world)。tier は 1..3 で 1 が最上段 */
const tierY = (tier) => K.y0 + (3 - tier) * K.tierGap;

/** 皿の断面。中心からの距離 r における床の高さ (皿ローカル、谷が 0) */
function profileY(r) {
  const d = r - D.troughR;
  const w = D.R - D.troughR;
  return D.bowlH * (d * d) / (w * w);
}

/** 断面の傾き dy/dr。外向きが正 */
function profileSlope(r) {
  const w = D.R - D.troughR;
  return 2 * D.bowlH * (r - D.troughR) / (w * w);
}

/** 皿の全高 (谷の底から壁の上端まで) */
const DISH_TOP = D.bowlH + D.wallH;

/** 球の中心が回れる最大半径 */
const R_MAX = D.R - D.wallLean - BALL.radius;

/** リフトの管を通す x (皿の外周のすぐ外) */
const LIFT_X = D.R + 0.62;

/**
 * 穴の中心 (皿ローカルの xz)。谷の上に count 個を等間隔に並べる。index 0 が当たり。
 *
 * 並びの向きは**投入角からの相対**で決める。絶対角で置くと段ごとに
 * 「投入口と当たり穴の位置関係」が変わり、当選率まで段ごとに変わってしまう
 * (実測: 10.4% / 23.1% / 25.0%)。投入角がそれぞれ違うので、
 * 相対で置いても3枚の皿の見た目はちゃんと違う向きになる。
 */
function holesOf(tier) {
  const out = [];
  const phase = E.angle[tier - 1] + H.offset;
  for (let i = 0; i < H.count; i++) {
    const a = phase + (i / H.count) * Math.PI * 2;
    out.push({
      x: Math.cos(a) * D.troughR,
      z: Math.sin(a) * D.troughR,
      a,
      win: i === 0,
      r: i === 0 ? H.win : H.lose,
    });
  }
  return out;
}

/**
 * 皿1枚のメッシュを作る。
 *
 * 極座標の格子 (半径方向のリング x 円周方向の分割) を張り、
 * **四角形の中心が穴の中に入るものだけ捨てる**ことで穴を開ける。
 * 穴の位置は holesOf() が唯一の出どころなので、見た目と判定がズレようがない。
 */
function buildDishMesh(tier) {
  const holes = holesOf(tier);
  const seg = D.segments;
  const wallSteps = 3;

  // 半径方向のリング: 椀 (中心の起点 → 外周) → 壁 (上端を内側へ寄せる)
  const rs = [];
  for (let i = 0; i <= D.rings; i++) rs.push(D.rInner + (D.R - D.rInner) * (i / D.rings));
  const bowlRings = rs.length;
  for (let i = 1; i <= wallSteps; i++) rs.push(D.R - D.wallLean * (i / wallSteps));

  const ys = rs.map((r, i) => (
    i < bowlRings ? profileY(r) : D.bowlH + D.wallH * ((i - bowlRings + 1) / wallSteps)
  ));

  const verts = new Float32Array(rs.length * seg * 3);
  for (let i = 0; i < rs.length; i++) {
    for (let j = 0; j < seg; j++) {
      const a = (j / seg) * Math.PI * 2;
      const k = (i * seg + j) * 3;
      verts[k] = rs[i] * Math.cos(a);
      verts[k + 1] = ys[i];
      verts[k + 2] = rs[i] * Math.sin(a);
    }
  }

  const idx = [];
  const half = Math.PI / seg;   // 四角形の中心までの角度
  for (let i = 0; i < rs.length - 1; i++) {
    const rm = (rs[i] + rs[i + 1]) / 2;
    for (let j = 0; j < seg; j++) {
      if (i < bowlRings - 1) {
        const am = (j / seg) * Math.PI * 2 + half;
        const cx = rm * Math.cos(am), cz = rm * Math.sin(am);
        let inHole = false;
        for (const h of holes) {
          if ((cx - h.x) * (cx - h.x) + (cz - h.z) * (cz - h.z) < h.r * h.r) {
            inHole = true;
            break;
          }
        }
        if (inHole) continue;
      }
      const jn = (j + 1) % seg;
      const a0 = i * seg + j, b0 = (i + 1) * seg + j;
      const c0 = (i + 1) * seg + jn, d0 = i * seg + jn;
      // 法線が上を向く向きに張る (半径方向 x 円周方向 は下を向く)
      idx.push(a0, d0, b0, b0, d0, c0);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
  geo.setIndex(new THREE.BufferAttribute(new Uint32Array(idx), 1));
  geo.computeVertexNormals();
  return { geo, holes };
}

/**
 * 3段クルーン (DESIGN_GIMMICKS.md §3.11)
 *
 * 抽選ボールが払い出し口に落ちるたびに、その球を筐体前面の役物へ持ち上げ、
 * 3枚の皿を順に通す。皿の底には穴が4つあり、そのうち1つ (金の縁) が当たり。
 * 3枚とも当たり穴を引ければ固定 300枚。
 *
 * ─────────────────────────────────────────────────────────────
 * ■ 皿の上だけ Rapier を使っていない
 *
 * 最初は皿を三角形メッシュのコライダーにして、Rapier の剛体を転がしていた。
 * 実測でどうにもならなかったので、皿の上だけ自前で積分している。
 *
 *   分割を細かく (稜線 0.1) + フラグ無し
 *     稜線に当たるたびに減速する。0.35秒で 9.7 → 0.7 unit/s。1周もしない
 *   分割を細かく + TriMeshFlags.FIX_INTERNAL_EDGES
 *     減速は消えるが、1ステップの移動量が「速度 x dt」の3〜6割しかなくなる。
 *     速度だけが増え続けて位置が付いてこない (静止状態から落としても再現)
 *   分割を粗く (稜線 0.35)
 *     稜線で弾かれて皿の外まで飛ぶ (半径 3.6 の位置まで到達)
 *
 * 同じ球を平らな三角形2枚の上で転がすと完璧に転がるので、
 * 「細かく曲がった面の上の小さな球」が Rapier の接触の想定から外れている。
 * 単位系が 1 unit = 25mm で、Rapier が既定で想定する寸法よりかなり小さいのも
 * 効いていると思われる (lengthUnit は台全体の挙動に効くので触れない)。
 *
 * 皿は回転体で、断面 y = f(r) が式で書ける。**式が閉じている面の上を転がすだけ**
 * なら自前のほうが正確で、詰まりも吹っ飛びも起きない。抽選そのものは
 * 相変わらず「初速のばらつき → 何周も回る → どの穴に落ちるか」で決まっていて、
 * 結果を先に引いてから演出を合わせるようなことはしていない。
 *
 * ■ 段の間の移動もキネマティック
 *   当たり穴を抜けてから次の皿の外周に置くまでは、経路 (CatmullRom) の上を運ぶ。
 *   同じ経路で透明なチューブを描いてあるので、見た目は「管を通って落ちる」になる。
 * ─────────────────────────────────────────────────────────────
 */
export class Kuruun {
  constructor(scene, { hopper, sound, onWin, onChange } = {}) {
    this.hopper = hopper;
    this.sound = sound;
    this.onWin = onWin || (() => {});
    this.onChange = onChange || (() => {});

    this.group = new THREE.Group();
    scene.add(this.group);

    this.dishes = [];
    this.state = 'idle';
    this.tier = 0;
    this.pending = 0;
    this.timer = 0;
    this.spinTime = 0;
    this._from = null;
    this._path = null;
    this._pathT = 0;
    this._pathDur = 1;
    this._fade = false;
    this._nextTier = 1;

    // 皿の上の状態 (皿ローカル)。p は球の中心の xz、v は水平速度、
    // sink は穴に掛かって支えを失ったぶんの沈み
    this._p = new THREE.Vector2();
    this._v = new THREE.Vector2();
    this._sink = 0;
    this._vy = 0;

    /** 実測用。段ごとの「入った回数 / 抜けた回数」 */
    this.stats = { runs: 0, wins: 0, visits: [0, 0, 0], passes: [0, 0, 0] };

    this._materials();
    this._buildDishes();
    this._buildFrame();
    this._buildBall();
    this._buildTubes();
  }

  get running() { return this.state !== 'idle'; }

  /* ------------------------------------------------------------------ */
  /* 組み立て                                                            */
  /* ------------------------------------------------------------------ */

  _materials() {
    this.matDish = new THREE.MeshStandardMaterial({
      color: 0x46587f, metalness: 0.55, roughness: 0.42, side: THREE.DoubleSide,
    });
    this.matWinRim = new THREE.MeshStandardMaterial({
      color: 0x4a3410, emissive: 0xffb43a, emissiveIntensity: 2.4, roughness: 0.35,
    });
    this.matLoseRim = new THREE.MeshStandardMaterial({
      color: 0x101a2a, emissive: 0x4f74a8, emissiveIntensity: 1.0, roughness: 0.6,
    });
    this.matStrut = new THREE.MeshStandardMaterial({
      color: 0x8e9ab2, metalness: 0.9, roughness: 0.28,
    });
    this.matTube = new THREE.MeshPhysicalMaterial({
      color: 0xa8c8ff, metalness: 0, roughness: 0.12,
      transmission: 0.85, thickness: 0.3, ior: 1.4,
      transparent: true, opacity: 0.22, side: THREE.DoubleSide,
    });
    this.matLampOff = new THREE.MeshStandardMaterial({
      color: 0x1a2333, emissive: 0x24405e, emissiveIntensity: 0.4, roughness: 0.5,
    });
    this.matLampOn = new THREE.MeshStandardMaterial({
      color: 0x3a2a10, emissive: 0xffc45a, emissiveIntensity: 2.2, roughness: 0.4,
    });
  }

  _buildDishes() {
    for (let tier = 1; tier <= 3; tier++) {
      const y = tierY(tier);
      const { geo, holes } = buildDishMesh(tier);

      const mesh = new THREE.Mesh(geo, this.matDish);
      mesh.position.set(K.x, y, K.z);
      // 影は落とさない。盤面の手前に浮いているので、落とすと台の上が汚れる
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      this.group.add(mesh);

      // 穴の縁のリング。当たり穴だけ金色に光らせる。
      // どれが当たりかは台を見れば分かる、が実機の約束
      for (const h of holes) {
        const rim = new THREE.Mesh(
          new THREE.TorusGeometry(h.r, h.win ? 0.055 : 0.032, 8, 36),
          h.win ? this.matWinRim : this.matLoseRim
        );
        rim.rotation.x = Math.PI / 2;
        rim.position.set(K.x + h.x, y, K.z + h.z);
        this.group.add(rim);
      }

      // 中心の頂点に開いている小穴 (rInner) を塞ぐ蓋
      const cap = new THREE.Mesh(
        new THREE.CircleGeometry(D.rInner * 1.6, 16), this.matDish
      );
      cap.rotation.x = -Math.PI / 2;
      cap.position.set(K.x, y + profileY(0), K.z);
      this.group.add(cap);

      this.dishes.push({ tier, y, mesh, holes });
    }
  }

  _buildFrame() {
    const top = tierY(1) + DISH_TOP + 0.5;
    const bottom = K.y0 - 1.0;

    // 皿を吊る支柱。皿の外周のすぐ外に立てる
    for (const sx of [-(D.R + 0.24), D.R + 0.24]) {
      const strut = new THREE.Mesh(
        new THREE.CylinderGeometry(0.08, 0.08, top - bottom, 12), this.matStrut
      );
      strut.position.set(K.x + sx, (top + bottom) / 2, K.z);
      this.group.add(strut);
    }

    // 段ランプ。いま球がどの段にいるか
    this.lamps = [];
    for (let tier = 1; tier <= 3; tier++) {
      const lamp = new THREE.Mesh(
        new THREE.SphereGeometry(0.11, 12, 10), this.matLampOff
      );
      lamp.position.set(K.x + D.R + 0.24, tierY(tier) + 0.34, K.z + 0.34);
      this.group.add(lamp);
      this.lamps.push(lamp);
    }

    // 役物だけを照らす明かり。筐体の外に浮いているので、
    // 台の中の照明 (Renderer の inner) がここまで届かない
    const lamp = new THREE.PointLight(0xbfd8ff, 110, 14, 2);
    lamp.position.set(K.x + 0.4, (tierY(1) + K.y0) / 2, K.z + 2.6);
    this.group.add(lamp);

    // 銘板。何をすると何枚出るのかが台に書いていないと意味が伝わらない
    const cv = document.createElement('canvas');
    cv.width = 512; cv.height = 128;
    const g = cv.getContext('2d');
    g.fillStyle = '#0b1220';
    g.fillRect(0, 0, 512, 128);
    g.strokeStyle = '#3d5a86';
    g.lineWidth = 4;
    g.strokeRect(2, 2, 508, 124);
    g.fillStyle = '#cfe0ff';
    g.font = 'bold 44px "Segoe UI", system-ui, sans-serif';
    g.textBaseline = 'middle';
    g.fillText('3段クルーン', 24, 64);
    g.fillStyle = '#ffc45a';
    g.font = 'bold 62px "Segoe UI", system-ui, sans-serif';
    g.textAlign = 'right';
    g.fillText(String(K.pay), 476, 58);
    g.fillStyle = '#8fa6c8';
    g.font = '20px "Segoe UI", system-ui, sans-serif';
    g.fillText('MEDALS', 476, 100);

    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    const plate = new THREE.Mesh(
      new THREE.PlaneGeometry(2.66, 0.66),
      new THREE.MeshBasicMaterial({ map: tex, toneMapped: false })
    );
    // 銘板は左下の ITEM パネルに隠れないよう、少し右に寄せて置く
    plate.position.set(K.x + 1.35, K.y0 - 0.62, K.z + 0.15);
    plate.rotation.x = -0.22;
    this.group.add(plate);
  }

  _buildBall() {
    this.ballMat = new THREE.MeshStandardMaterial({
      // 皿より小さいものを追いかけてもらうので、球はしっかり光らせる
      color: 0x0f2a38,
      emissive: BALL.color,
      emissiveIntensity: 2.4,
      metalness: 0.25,
      roughness: 0.15,
      transparent: true,
      opacity: 1,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(BALL.radius, 20, 14), this.ballMat);
    this.mesh.visible = false;
    this.group.add(this.mesh);

    // 描画は物理ステップの間を補間する (フィールドの剛体と同じ扱い)
    this.prevP = new THREE.Vector3();
    this.currP = new THREE.Vector3();
    this.prevQ = new THREE.Quaternion();
    this.currQ = new THREE.Quaternion();
    this._spinQ = new THREE.Quaternion();
    this._axis = new THREE.Vector3();
  }

  /** 皿の外周に球の中心を置く位置 (world) */
  _entryPoint(tier, angle) {
    const r = D.R - E.inset - BALL.radius;
    const a = angle !== undefined ? angle : E.angle[tier - 1];
    return new THREE.Vector3(
      K.x + r * Math.cos(a),
      tierY(tier) + profileY(r) + BALL.radius,
      K.z + r * Math.sin(a)
    );
  }

  /** 段 tier に入る経路の制御点。壁の上端を越えてから内側に落とす */
  _entryPath(tier, from) {
    const a = E.angle[tier - 1];
    const over = tierY(tier) + DISH_TOP + 0.42;
    const rOver = D.R - 0.32;
    return [
      from,
      new THREE.Vector3(K.x + rOver * Math.cos(a) * 1.2, over, K.z + rOver * Math.sin(a) * 1.2),
      new THREE.Vector3(K.x + rOver * Math.cos(a), over - 0.20, K.z + rOver * Math.sin(a)),
      this._entryPoint(tier),
    ];
  }

  /** リフトの管。筐体の左前の柱に沿って立ち上げる */
  _liftPoints() {
    return [
      new THREE.Vector3(K.x - LIFT_X, -1.40, K.z),
      new THREE.Vector3(K.x - LIFT_X, 2.60, K.z),
      new THREE.Vector3(K.x - LIFT_X, tierY(1) + DISH_TOP + 0.55, K.z),
    ];
  }

  /** 段 tier の当たり穴の world 座標 */
  _winHole(tier) {
    const h = holesOf(tier)[0];
    return new THREE.Vector3(K.x + h.x, tierY(tier), K.z + h.z);
  }

  /**
   * 当たり穴から次の皿までの経路。
   * 使える高さは「段の間隔 - 皿の全高」しか無く、そのぶんを
   * 一度も上がらずに降りきる必要がある。寄り道を入れると管が上下してしまう
   */
  _transferPoints(tier) {
    const from = this._winHole(tier);
    from.y -= 0.22;
    return this._entryPath(tier + 1, from);
  }

  _buildTubes() {
    const tube = (points, radius = 0.26) => {
      const curve = new THREE.CatmullRomCurve3(points, false, 'centripetal');
      const mesh = new THREE.Mesh(
        new THREE.TubeGeometry(curve, 56, radius, 10, false), this.matTube
      );
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      this.group.add(mesh);
    };

    const lift = this._liftPoints();
    tube([...lift, ...this._entryPath(1, lift[lift.length - 1].clone()).slice(1)]);
    for (let tier = 1; tier <= 2; tier++) tube(this._transferPoints(tier));
  }

  /* ------------------------------------------------------------------ */
  /* 進行                                                                */
  /* ------------------------------------------------------------------ */

  /**
   * 抽選ボールが払い出し口に落ちた。
   * @param {{x:number,y:number,z:number}} [from] 落ちた位置。ここからリフトが拾う
   */
  request(from) {
    if (!K.enabled) return;
    if (this.pending >= K.maxQueue) return;   // 待たせている間に次の球が落ちてくる
    this.pending++;
    this._from = from ? { x: from.x, y: from.y, z: from.z } : null;
  }

  _startLift() {
    const lift = this._liftPoints();
    const head = this._from
      ? new THREE.Vector3(this._from.x, Math.max(this._from.y, -2.2), this._from.z)
      : lift[0].clone();
    const pts = [head, ...lift, ...this._entryPath(1, lift[lift.length - 1].clone()).slice(1)];

    this.stats.runs++;
    this._nextTier = 1;
    this._setPath(pts, K.liftSeconds, 'lift');
    this.ballMat.opacity = 1;
    this.mesh.visible = true;
    if (this.sound) this.sound.kuruunLift();
  }

  _setPath(points, seconds, state) {
    this._path = new THREE.CatmullRomCurve3(points, false, 'centripetal');
    this._pathT = 0;
    this._pathDur = Math.max(0.05, seconds);
    this._fade = false;
    this.state = state;
    this.currP.copy(points[0]);
    this.prevP.copy(points[0]);
  }

  /** 経路の上を運ぶ。終端に着いたら true */
  _advance(dt) {
    this._pathT = Math.min(1, this._pathT + dt / this._pathDur);
    this.currP.copy(this._path.getPoint(this._pathT));
    if (this._fade) this.ballMat.opacity = Math.max(0, 1 - this._pathT);
    return this._pathT >= 1;
  }

  /** 皿の上に球を放つ。ここのばらつきが唯一の乱数 */
  _release(tier) {
    const a = E.angle[tier - 1] + (rnd() - 0.5) * E.angleJitter;
    const speed = E.speed * (1 + (rnd() - 0.5) * 2 * E.jitter);
    const r = D.R - E.inset - BALL.radius;

    this.tier = tier;
    this._p.set(r * Math.cos(a), r * Math.sin(a));
    // 接線方向 (上から見て反時計回り)
    this._v.set(-Math.sin(a) * speed, Math.cos(a) * speed);
    this._sink = 0;
    this._vy = 0;

    this.state = 'spin';
    this.spinTime = 0;
    this.stats.visits[tier - 1]++;
    this._writeBallPos();
    this.prevP.copy(this.currP);
    this._lamps();
    this.onChange(this);
    if (this.sound) this.sound.kuruunEnter(tier);
  }

  /** 皿ローカルの状態から球の world 位置を作る */
  _writeBallPos() {
    const r = this._p.length();
    this.currP.set(
      K.x + this._p.x,
      tierY(this.tier) + profileY(r) + BALL.radius + this._sink,
      K.z + this._p.y
    );
  }

  /**
   * 皿の上の1ステップ。
   *
   *   ・重力の接線成分で加速する (転がりぶん 5/7)
   *   ・転がり抵抗で減速する
   *   ・外周の壁では半径方向の速度を反転させる
   *   ・穴の上に来たら支えを失って沈む。球の半径ぶん沈んだら「入った」。
   *     沈みきる前に向こう岸へ届けば穴を飛び越える (速い球ほど飛び越える)
   */
  _spin(dt) {
    const p = this._p, v = this._v;
    let r = p.length() || 1e-6;

    // --- 斜面 ---
    const acc = -ROLL * G * profileSlope(r);
    v.x += (acc * p.x / r) * dt;
    v.y += (acc * p.y / r) * dt;

    // --- 転がり抵抗 ---
    v.multiplyScalar(Math.max(0, 1 - D.damp * dt));

    // --- 谷で力尽きたら、筐体の微振動ぶんだけ谷に沿って押す ---
    //     (AntiJam と同じ考え方。実機も完全には静止しない)
    const speed = v.length();
    if (speed < D.minSpeed) {
      const s = (D.minSpeed - speed) / D.minSpeed;
      v.x += (-p.y / r) * D.minSpeed * s * dt * 4;
      v.y += (p.x / r) * D.minSpeed * s * dt * 4;
    }

    p.x += v.x * dt;
    p.y += v.y * dt;
    r = p.length() || 1e-6;

    // --- 外周の壁 ---
    if (r > R_MAX) {
      const nx = p.x / r, nz = p.y / r;
      const vr = v.x * nx + v.y * nz;
      if (vr > 0) {
        v.x -= (1 + D.wallBounce) * vr * nx;
        v.y -= (1 + D.wallBounce) * vr * nz;
      }
      p.x = nx * R_MAX;
      p.y = nz * R_MAX;
    }

    // --- 穴 ---
    const holes = this.dishes[this.tier - 1].holes;
    let over = null;
    for (const h of holes) {
      const dx = p.x - h.x, dz = p.y - h.z;
      // 支えを失うのは、球の中心が穴の縁より grip ぶん内側に入ってから
      const lim = h.r - BALL.radius * H.grip;
      if (dx * dx + dz * dz < lim * lim) { over = h; break; }
    }

    if (over) {
      this._vy -= G * dt;
      this._sink += this._vy * dt;
      if (-this._sink >= BALL.radius) {
        if (over.win) this._pass();
        else this._drop(false);
        return;
      }
    } else if (this._sink < 0) {
      // 向こう岸の縁に当たって戻された。勢いを少し失う
      this._sink = 0;
      this._vy = 0;
      v.multiplyScalar(0.85);
    }

    this._writeBallPos();
    this._roll(dt);

    this.spinTime += dt;
    if (this.spinTime > K.forceTimeout) {
      // 保険。いちばん近い穴に落とす
      let best = holes[0], bestD = Infinity;
      for (const h of holes) {
        const d = Math.hypot(p.x - h.x, p.y - h.z);
        if (d < bestD) { bestD = d; best = h; }
      }
      if (best.win) this._pass();
      else this._drop(false);
    }
  }

  /** 見た目の回転。滑らない転がり ω = (上向き × v) / 半径 */
  _roll(dt) {
    const speed = this._v.length();
    if (speed < 1e-4) return;
    this._axis.set(this._v.y, 0, -this._v.x).normalize();
    this._spinQ.setFromAxisAngle(this._axis, (speed / BALL.radius) * dt);
    this.currQ.premultiply(this._spinQ);
  }

  /** 当たり穴を抜けた */
  _pass() {
    this.stats.passes[this.tier - 1]++;
    if (this.tier >= 3) {
      this.stats.wins++;
      this._drop(true);
      return;
    }
    this._nextTier = this.tier + 1;
    this._setPath(this._transferPoints(this.tier), K.transferSeconds, 'transfer');
    if (this.sound) this.sound.kuruunPass(this.tier);
  }

  /** 穴に飲まれて終わり。win なら払い出す */
  _drop(win) {
    const from = this.currP.clone();
    const to = from.clone();
    to.y -= 1.0;
    this._setPath([from, to], win ? K.winSeconds : K.missSeconds, 'drop');
    this._fade = true;

    if (win) {
      // 払い出しは他の当たりと同じくホッパー経由。場に落ちて、押し出されて
      // 初めてクレジットになる (§4.2「吐いた枚数は払い戻しではない」)
      if (this.hopper) this.hopper.queue(K.pay);
      this.onWin(K.pay);
      if (this.sound) this.sound.kuruunWin();
    } else if (this.sound) {
      this.sound.kuruunMiss();
    }
  }

  _finish() {
    this.mesh.visible = false;
    this.tier = 0;
    this.state = 'idle';
    this.timer = K.restSeconds;
    this._lamps();
    this.onChange(this);
  }

  _lamps() {
    for (let i = 0; i < this.lamps.length; i++) {
      this.lamps[i].material = (i + 1 <= this.tier) ? this.matLampOn : this.matLampOff;
    }
  }

  /** 物理ステップと同じ固定タイムステップで呼ぶ */
  update(dt) {
    if (!K.enabled) return;

    this.prevP.copy(this.currP);
    this.prevQ.copy(this.currQ);

    switch (this.state) {
      case 'idle':
        if (this.timer > 0) this.timer -= dt;
        else if (this.pending > 0) { this.pending--; this._startLift(); }
        break;

      case 'lift':
      case 'transfer':
        if (this._advance(dt)) this._release(this._nextTier);
        break;

      case 'spin':
        this._spin(dt);
        break;

      case 'drop':
        if (this._advance(dt)) this._finish();
        break;

      default:
        break;
    }
  }

  syncMesh(alpha) {
    if (!this.mesh.visible) return;
    this.mesh.position.copy(this.prevP).lerp(this.currP, alpha);
    this.mesh.quaternion.copy(this.prevQ).slerp(this.currQ, alpha);
  }

  /** 実測用。段ごとの通過率 */
  report() {
    const rows = this.dishes.map((d, i) => ({
      段: i + 1,
      入った: this.stats.visits[i],
      抜けた: this.stats.passes[i],
      '通過率%': this.stats.visits[i]
        ? ((this.stats.passes[i] / this.stats.visits[i]) * 100).toFixed(1) : '-',
    }));
    return { runs: this.stats.runs, wins: this.stats.wins, rows };
  }
}
