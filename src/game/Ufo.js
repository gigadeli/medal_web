import * as THREE from 'three';
import { CFG } from '../config.js';
import { rnd } from '../core/Rng.js';

const U = CFG.ufo;
const M = CFG.medal;

/**
 * UFO ボーナス (DESIGN_GIMMICKS.md §3.12)
 *
 * 低確率で盤面の上空に現れ、**発射したメダルを直接当て続ける**と固定 100枚。
 * 撃ち落とせないまま滞空時間が尽きたら、そのまま去る。
 *
 * ─────────────────────────────────────────────────────────────
 * ■ 浮かべる場所は「弾道の上」から逆算している
 *
 *   盤面の適当な高さに置くと、首振りの端では手前で落ちる・中央では奥へ抜ける、
 *   という**そもそも当たらない場所**ができる。当たらない的を出しても
 *   プレイヤーには「当て方が分からない」としか映らない。
 *
 *   弾道は首の位置を軸に回転対称なので、「首からの水平距離」を固定して
 *   その円弧の上を漂わせれば、どの角度に居ても弾道の上に居ることになる。
 *   読むのは向きだけ、飛距離は読まなくていい (Launcher.arcPoint)。
 *
 * ■ 当たり判定は物理と別に持っている
 *   コライダーは「跳ね返らせるため」に置いてあり、命中の数え方は別。
 *   接触イベント (CONTACT_FORCE_EVENTS) はしきい値を超えた接触しか飛んで来ず、
 *   しきい値は衝突音のために決めた値なので、そこに命中判定を相乗りさせると
 *   「音が鳴るくらい強く当たった時だけ当たり」になってしまう。
 *   円柱に半径ぶんの余裕を足した領域への**侵入**を自前で数える。
 *
 * ■ 落ちてきたメダルは当たりにしない
 *   ホッパーの落下位置とは離してあるが、跳ねたメダルが上を通ることはある。
 *   撃ち出したメダルは頂点でも水平 30 unit/s 前後で飛んでいるので、
 *   水平速度で足切りすれば「撃って当てた」ものだけが残る (U.minHitSpeed)。
 * ─────────────────────────────────────────────────────────────
 *
 * 状態:
 *   idle   居ない
 *   enter  現れている最中 (まだ当たらない)
 *   hover  滞空中。ここだけが命中を数える
 *   win    撃ち落とした。払い出しは入った瞬間に済ませてある
 *   leave  去っている最中
 */
export class Ufo {
  constructor(scene, world, RAPIER, {
    launcher, pool, hopper, sound, canAppear, onChange,
  } = {}) {
    this.launcher = launcher;
    this.pool = pool;
    this.hopper = hopper;
    this.sound = sound;
    this.canAppear = canAppear || (() => true);
    this.onChange = onChange || (() => {});

    this.state = 'idle';
    this.timer = 0;
    this.damage = 0;         // 当てた数。U.hits で撃ち落とし
    this.since = U.minIntervalSeconds;   // 前回去ってからの経過。起動直後は撃てる
    this._t = 0;             // 漂いの位相
    this._decay = 0;
    this._aimed = false;

    /** 実測用 */
    this.stats = { appears: 0, wins: 0, hits: 0 };

    // 首からの水平距離。ここを固定するのが設計の要点 (クラス頭のコメント)
    this.arcH = launcher ? launcher.range * U.arcFrac : 4.0;

    this._pos = new THREE.Vector3();
    this.prevP = new THREE.Vector3();
    this.currP = new THREE.Vector3();

    // 命中は「領域に入った瞬間」だけ数える。乗ったまま毎ステップ数えないよう、
    // いま中に居るメダルを覚えておく (2つを入れ替えて使い回し、毎ステップの確保を避ける)
    this._inside = new Set();
    this._next = new Set();

    this._build(scene);
    this._buildBody(world, RAPIER);
  }

  get active() { return this.state !== 'idle'; }
  /** 残り (撃ち落とすまでにあと何発) */
  get left() { return Math.max(0, U.hits - this.damage); }

  /* ------------------------------------------------------------------ */
  /* 組み立て                                                            */
  /* ------------------------------------------------------------------ */

  _build(scene) {
    this.group = new THREE.Group();
    this.group.visible = false;
    scene.add(this.group);

    const R = U.radius;

    // 不透明のまま組む。手前のガラスは外してあるので透過を使っても消えないが、
    // 半透明の光の輪やビームは盤面の山と重なると輪郭が溶けて、
    // 「あと何発か」を見せるランプが読めなくなる
    this.matHull = new THREE.MeshStandardMaterial({
      color: 0x9aa8c4, metalness: 0.92, roughness: 0.24,
    });
    this.matDome = new THREE.MeshStandardMaterial({
      color: 0x123a4a, emissive: 0x5cc8ff, emissiveIntensity: 1.8, roughness: 0.2,
    });
    this.matLampOn = new THREE.MeshStandardMaterial({
      color: 0x3a2a10, emissive: 0xffc45a, emissiveIntensity: 2.6, roughness: 0.4,
    });
    this.matLampOff = new THREE.MeshStandardMaterial({
      color: 0x141c28, emissive: 0x1b2b40, emissiveIntensity: 0.3, roughness: 0.6,
    });
    // 底の発光板。首がこちらを向いている間だけ色が変わる = 「いま撃てば当たる」の合図
    this.matBase = new THREE.MeshStandardMaterial({
      color: 0x1a2436, emissive: 0x2b6ea8, emissiveIntensity: 1.2, roughness: 0.5,
    });

    // ゆっくり自転する部分。ランプもここに付けて一緒に回す
    this.hull = new THREE.Group();
    this.group.add(this.hull);

    // 円盤。断面を回して作る (r, y)。y=0 がいちばん出っ張った縁
    const prof = [
      [0.00, -0.10], [0.30 * R, -0.16], [0.58 * R, -0.20],
      [0.85 * R, -0.13], [R, 0.00], [0.80 * R, 0.10],
      [0.48 * R, 0.16], [0.26 * R, 0.18], [0.00, 0.18],
    ].map(([r, y]) => new THREE.Vector2(r, y * (U.height / 0.44)));
    const hull = new THREE.Mesh(new THREE.LatheGeometry(prof, 40), this.matHull);
    hull.castShadow = false;   // 盤面の上に浮いているので、落とすと山が汚れる
    hull.receiveShadow = false;
    this.hull.add(hull);

    // 上のドーム
    const dome = new THREE.Mesh(
      new THREE.SphereGeometry(R * 0.36, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2),
      this.matDome
    );
    dome.position.y = U.height * 0.36;
    this.hull.add(dome);

    // 底の板
    const base = new THREE.Mesh(new THREE.CircleGeometry(R * 0.46, 24), this.matBase);
    base.rotation.x = Math.PI / 2;
    base.position.y = -U.height * 0.52;
    this.hull.add(base);

    // 残りの表示はリムのランプ。**必要な直撃数と同じ数**だけ並べる。
    // 台を見れば「あと何発か」が分かる、が実機の約束 (Kuruun の段ランプと同じ)
    this.lamps = [];
    for (let i = 0; i < U.hits; i++) {
      const a = (i / U.hits) * Math.PI * 2;
      const lamp = new THREE.Mesh(
        new THREE.SphereGeometry(R * 0.075, 10, 8), this.matLampOn
      );
      lamp.position.set(Math.cos(a) * R * 0.93, 0, Math.sin(a) * R * 0.93);
      this.hull.add(lamp);
      this.lamps.push(lamp);
    }

    // 役物だけを照らす明かり。台の中の照明はガラスの手前で浮いている物まで届かない
    this.light = new THREE.PointLight(0x9fd8ff, 90, 10, 2);
    this.light.position.set(0, 0.4, 0.9);
    this.group.add(this.light);

    // 銘板。何をすると何枚出るのかが台に書いていないと意味が伝わらない。
    // 自転させない (回る文字は読めない)
    this.group.add(this._plate());
  }

  _plate() {
    const cv = document.createElement('canvas');
    cv.width = 512; cv.height = 128;
    const g = cv.getContext('2d');
    g.fillStyle = '#0b1220';
    g.fillRect(0, 0, 512, 128);
    g.strokeStyle = '#3d5a86';
    g.lineWidth = 4;
    g.strokeRect(2, 2, 508, 124);
    g.fillStyle = '#cfe0ff';
    g.font = 'bold 40px "Segoe UI", system-ui, sans-serif';
    g.textBaseline = 'middle';
    g.fillText('UFO を撃て', 24, 64);
    g.fillStyle = '#ffc45a';
    g.font = 'bold 62px "Segoe UI", system-ui, sans-serif';
    g.textAlign = 'right';
    g.fillText(String(U.pay), 476, 58);
    g.fillStyle = '#8fa6c8';
    g.font = '20px "Segoe UI", system-ui, sans-serif';
    g.fillText('MEDALS', 476, 100);

    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    const plate = new THREE.Mesh(
      new THREE.PlaneGeometry(1.9, 0.48),
      new THREE.MeshBasicMaterial({ map: tex, toneMapped: false })
    );
    plate.position.set(0, -U.height * 0.52 - 0.42, 0.1);
    plate.rotation.x = -0.30;
    return plate;
  }

  _buildBody(world, RAPIER) {
    // キネマティック。メダルに押されず、メダルだけを跳ね返す
    const bodyDesc = RAPIER.RigidBodyDesc.kinematicPositionBased()
      .setTranslation(0, -500, 0);
    this.body = world.createRigidBody(bodyDesc);

    // 円盤なので円柱で近似する。狙って当てるのは横からなので、
    // 大事なのは側面の半径のほう
    const colDesc = RAPIER.ColliderDesc
      .cylinder(U.height / 2, U.radius)
      .setFriction(U.friction)
      .setRestitution(U.restitution);
    this.collider = world.createCollider(colDesc, this.body);
    this.collider.setEnabled(false);
  }

  /* ------------------------------------------------------------------ */
  /* 出現                                                                */
  /* ------------------------------------------------------------------ */

  /**
   * メダルを1枚投入した。出現抽選を1回引く。
   * 時間で引かない理由は config の ufo を参照
   */
  rollOnInsert() {
    if (!U.enabled || this.state !== 'idle') return false;
    if (this.since < U.minIntervalSeconds) return false;
    if (!this.canAppear()) return false;
    if (rnd() >= U.chancePerInsert) return false;
    this.spawn();
    return true;
  }

  /** 出現させる (抽選の当選 / デバッグから直接) */
  spawn() {
    if (!U.enabled || this.state !== 'idle') return;

    this.state = 'enter';
    this.timer = U.enterSeconds;
    this.damage = 0;
    this._decay = 0;
    // 位相は毎回振り直す。同じ位相から始めると、出るたびに同じ動きになる
    this._t = rnd() * U.driftPeriod;
    this.stats.appears++;

    this._writePos();
    this.prevP.copy(this.currP);
    this._lamps();
    this.group.visible = true;
    this.group.scale.setScalar(0.02);
    if (this.sound) this.sound.ufoAppear();
    this.onChange(this);
  }

  /* ------------------------------------------------------------------ */
  /* 進行                                                                */
  /* ------------------------------------------------------------------ */

  /** 漂う位置を書き込む。弾道の円弧の上を左右に往復し、上下に少し揺れる */
  _writePos() {
    const yaw = Math.sin((this._t / U.driftPeriod) * Math.PI * 2)
      * U.driftYaw * CFG.launcher.yawRange;
    this.yaw = yaw;
    if (this.launcher) {
      this.launcher.arcPoint(this.arcH, yaw, this._pos);
    } else {
      this._pos.set(0, 5.0, 2.1);
    }
    this._pos.y += Math.sin((this._t / U.bobPeriod) * Math.PI * 2) * U.bob;
    // 去るときは上へ抜ける
    if (this.state === 'leave') {
      this._pos.y += (1 - this.timer / U.leaveSeconds) * 3.0;
    }
    this.prevP.copy(this.currP);
    this.currP.copy(this._pos);
  }

  /**
   * 物理ステップの**前**に呼ぶ (キネマティックな部品と同じ扱い)。
   *
   * 命中の走査に使うメダルの位置は1ステップ前のものになるが、
   * 16ms ぶんのずれは判定の余裕 (U.hitMargin) の中に収まる。
   * 逆にすると、動かす前の UFO の位置で判定することになって同じだけずれる。
   */
  update(dt) {
    if (!U.enabled) return;

    if (this.state === 'idle') {
      this.since += dt;
      return;
    }

    this._t += dt;
    this.timer -= dt;

    switch (this.state) {
      case 'enter':
        this._writePos();
        this.group.scale.setScalar(Math.max(0.02, 1 - this.timer / U.enterSeconds));
        if (this.timer <= 0) {
          this.group.scale.setScalar(1);
          this.state = 'hover';
          this.timer = U.lifeSeconds;
          // ここで初めて当たるようになる。出現の途中で当たると
          // 「見えた瞬間にもう終わっていた」ことが起きる
          this.collider.setEnabled(true);
          this._inside.clear();
          this.onChange(this);
        }
        break;

      case 'hover':
        this._writePos();
        this._scan(dt);
        if (this.timer <= 0) this._leave(false);
        break;

      case 'win':
        this._writePos();
        if (this.timer <= 0) this._leave(true);
        break;

      case 'leave':
        this._writePos();
        this.group.scale.setScalar(Math.max(0.02, this.timer / U.leaveSeconds));
        if (this.timer <= 0) this._finish();
        break;

      default:
        break;
    }

    // キネマティックは「次の位置」を渡す。world.step() より前に呼ぶこと
    this.body.setNextKinematicTranslation({
      x: this.currP.x, y: this.currP.y, z: this.currP.z,
    });
  }

  /** 命中の走査。領域に入った瞬間だけ1発と数える */
  _scan(dt) {
    const active = this.pool ? this.pool.active : null;
    const rHit = U.radius + M.radius + U.hitMargin;
    const yHit = U.height / 2 + M.radius + U.hitMargin;
    const rHit2 = rHit * rHit;
    const minV2 = U.minHitSpeed * U.minHitSpeed;

    const next = this._next;
    next.clear();

    if (active) {
      for (let i = 0; i < active.length; i++) {
        const m = active[i];
        const dy = m.currP.y - this.currP.y;
        if (dy > yHit || dy < -yHit) continue;
        const dx = m.currP.x - this.currP.x;
        const dz = m.currP.z - this.currP.z;
        if (dx * dx + dz * dz > rHit2) continue;
        // 落ちてきただけのメダルを当たりにしない (クラス頭のコメント)
        const v = m.body.linvel();
        if (v.x * v.x + v.z * v.z < minV2) continue;
        next.add(m.index);
      }
    }

    let hit = 0;
    for (const index of next) {
      if (!this._inside.has(index)) hit++;
    }
    // 2つを入れ替えて使い回す (毎ステップ Set を作らない)
    const prev = this._inside;
    this._inside = next;
    this._next = prev;

    if (hit > 0) {
      this._decay = 0;
      this.stats.hits += hit;
      this.damage = Math.min(U.hits, this.damage + hit);
      this._lamps();
      if (this.sound) this.sound.ufoHit(this.damage, U.hits);
      this.onChange(this);
      if (this.damage >= U.hits) this._win();
      return;
    }

    // 「当て続ける」ようにするための減衰。手が止まればダメージが戻る
    if (this.damage > 0 && U.decaySeconds > 0) {
      this._decay += dt;
      if (this._decay >= U.decaySeconds) {
        this._decay = 0;
        this.damage--;
        this._lamps();
        this.onChange(this);
      }
    }
  }

  _win() {
    this.state = 'win';
    this.timer = U.winSeconds;
    this.stats.wins++;
    // 当たった瞬間に的では無くなる。ここから先のメダルは素通りさせる
    this.collider.setEnabled(false);
    this._inside.clear();
    // 払い出しは他の当たりと同じくホッパー経由。場に落ちて、押し出されて
    // 初めてクレジットになる (§4.2「吐いた枚数は払い戻しではない」)
    if (this.hopper) this.hopper.queue(U.pay);
    if (this.sound) this.sound.ufoWin();
    this.onChange(this);
  }

  _leave(won) {
    this.state = 'leave';
    this.timer = U.leaveSeconds;
    this.collider.setEnabled(false);
    this._inside.clear();
    if (!won && this.sound) this.sound.ufoLeave();
    this.onChange(this);
  }

  _finish() {
    this.state = 'idle';
    this.since = 0;
    this.damage = 0;
    this.group.visible = false;
    this.body.setTranslation({ x: 0, y: -500, z: 0 }, false);
    this.onChange(this);
  }

  _lamps() {
    for (let i = 0; i < this.lamps.length; i++) {
      this.lamps[i].material = i < this.left ? this.matLampOn : this.matLampOff;
    }
  }

  /* ------------------------------------------------------------------ */

  /** 描画。物理ステップの間を補間する (フィールドの剛体と同じ扱い) */
  syncMesh(alpha, realDt = 0) {
    if (!this.group.visible) return;
    this.group.position.copy(this.prevP).lerp(this.currP, alpha);
    this.hull.rotation.y += realDt * 1.1;

    // 首がこちらを向いている間だけ底が色を変える。
    // 「いま撃てば当たる」が台の上で分かるようにするための合図で、
    // 判定そのものは弾道側 (Launcher.arcPoint) が保証している
    const aimed = this.state === 'hover' && this.launcher
      && Math.abs(this.launcher.yaw - this.yaw) < this._aimHalfAngle();
    if (aimed !== this._aimed) {
      this._aimed = aimed;
      this.matBase.emissive.setHex(aimed ? 0xffc45a : 0x2b6ea8);
      this.matBase.emissiveIntensity = aimed ? 2.6 : 1.2;
    }
  }

  /** 当たる角度の半幅。半径ぶんの見込み角 */
  _aimHalfAngle() {
    return Math.asin(Math.min(1, (U.radius + M.radius) / Math.max(0.1, this.arcH)));
  }

  /** 実測用 */
  report() {
    const s = this.stats;
    return {
      出現: s.appears,
      撃墜: s.wins,
      '撃墜率%': s.appears ? ((s.wins / s.appears) * 100).toFixed(1) : '-',
      命中: s.hits,
      '1回あたりの命中': s.appears ? (s.hits / s.appears).toFixed(1) : '-',
    };
  }
}
