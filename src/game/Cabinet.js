import * as THREE from 'three';
import { CFG } from '../config.js';
import { createFixedBox } from '../physics/World.js';

const L = CFG.layout;

/**
 * 筐体の静的部分。
 * メッシュと Fixed コライダーを必ず対で作ることで、見た目と当たり判定のズレを防ぐ。
 *
 * 落下経路 (手前の払い出し口 / 左右のサイドポケット) には
 * 見た目だけの板も置かないこと。メダルがすり抜けて見えて興ざめになる。
 */
export class Cabinet {
  constructor(scene, world, RAPIER) {
    this.scene = scene;
    this.world = world;
    this.RAPIER = RAPIER;
    this.group = new THREE.Group();
    scene.add(this.group);

    this._materials();
    this._buildPlayfield();
    this._buildEnclosure();
    this._buildDecor();
  }

  _materials() {
    this.matTable = new THREE.MeshStandardMaterial({
      color: 0x2b3448, metalness: 0.55, roughness: 0.45,
    });
    this.matDeck = new THREE.MeshStandardMaterial({
      color: 0x323d55, metalness: 0.6, roughness: 0.4,
    });
    this.matWall = new THREE.MeshStandardMaterial({
      color: 0x161d2b, metalness: 0.35, roughness: 0.7,
    });
    this.matFrame = new THREE.MeshStandardMaterial({
      color: 0x9aa6bd, metalness: 0.9, roughness: 0.25,
    });
    this.matGlow = new THREE.MeshStandardMaterial({
      color: 0x1a2436, emissive: 0xffb03a, emissiveIntensity: 1.4, roughness: 0.5,
    });
    this.matGlowRed = new THREE.MeshStandardMaterial({
      color: 0x2a1520, emissive: 0xff4d5e, emissiveIntensity: 1.2, roughness: 0.5,
    });
  }

  /** メッシュ + コライダーを作る。visualOnly なら見た目だけ。 */
  _box(box, material, opts = {}) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(box.w, box.h, box.d), material);
    mesh.position.set(box.x, box.y, box.z);
    if (box.rx) mesh.rotation.x = box.rx;
    mesh.castShadow = !!opts.castShadow;
    mesh.receiveShadow = opts.receiveShadow !== false;
    this.group.add(mesh);

    if (!opts.visualOnly) {
      createFixedBox(this.world, this.RAPIER, box, opts);
    }
    return mesh;
  }

  _buildPlayfield() {
    // --- 下段テーブル (奥の一枚板だけ。手前左右の隙間がサイドポケットになる) ---
    this._box(L.tableMain, this.matTable, { friction: CFG.table.friction });

    // 手前のテーブル (勾配 + チャッカーの穴) は TiltTable が持つ。
    // フィーバー中に傾きが変わるので Fixed ではいられない (DESIGN_GIMMICKS.md §3.3)
  }

  _buildEnclosure() {
    this._box(L.wallBack, this.matWall, { friction: 0.2 });
    this._box(L.wallLeft, this.matWall, { friction: 0.2 });
    this._box(L.wallRight, this.matWall, { friction: 0.2 });

    /*
     * 手前の見えない壁。下端 y=1.5 より下は開口で、そこが払い出し口。
     *
     * ここには以前ガラス (MeshPhysicalMaterial の transmission) が貼ってあった。
     * transmission は「裏側の景色をもう一度描いたもの」を合成する仕組みで、
     * つまり **シーンを毎フレーム2回描く**。この1枚のために描画時間が倍近くになる。
     * 見た目ごと外して、コライダーだけを残してある。
     *
     * 壁自体は外せない。山や UFO から手前へ弾かれたメダルが筐体の外へ抜ける。
     *
     * ガラスを外したことで、透過の落とし穴も無くなった:
     * transmission のパスには transparent: true のものが入らないので、
     * 以前はガラスの裏に置いた半透明の物が丸ごと消えていた (§3.11 の実測)。
     * 役物側は不透明のままにしてあるが、それは見た目としてそう決めただけで、
     * もう制約ではない。
     */
    const front = this._box(L.frontGuard, this.matWall, { friction: 0.1, restitution: 0.05 });
    front.visible = false;

    // 不可視の天井。弾かれたメダルの脱走を防ぐ
    const ceil = this._box(L.ceiling, this.matWall, { friction: 0.1 });
    ceil.visible = false;
  }

  _buildDecor() {
    // ガラス周りのフレーム
    const fz = 6.45;
    // 下枠はテーブル面(y=0)より下に置くこと。上に置くと落下口まわりが隠れて
    // 「押し出されて落ちる」いちばん見たい瞬間が見えなくなる
    // 下枠は払い出しスロープ (z 6.05〜8.24, y -0.3〜-1.5) を避けて、
    // その先端の下に置く。掛けるとメダルが枠を突き抜けて見える
    const frames = [
      { x: 0, y: 12.2, z: fz, w: 15.4, h: 0.5, d: 0.5 },
      { x: 0, y: -1.95, z: 8.6, w: 13.0, h: 0.5, d: 0.5 },
      { x: -7.4, y: 6.0, z: fz, w: 0.5, h: 13.0, d: 0.5 },
      { x: 7.4, y: 6.0, z: fz, w: 0.5, h: 13.0, d: 0.5 },
    ];
    for (const f of frames) this._box(f, this.matFrame, { visualOnly: true, castShadow: true });

    // 受け皿の光る縁。スロープの先端の真下
    this._box(
      { x: 0, y: -1.62, z: 8.55, w: 11.5, h: 0.16, d: 0.5 },
      this.matGlow, { visualOnly: true }
    );

    // 背面パネルの発光ライン。背面壁の内面 (z=-3.0) のすぐ手前。
    // 液晶を背面に移したので、その**下だけ**に1本。
    // 液晶はベゼル込みで y 2.64〜7.97 を占めていて、上は画角の外に出る
    this._box(
      { x: 0, y: 2.30, z: -2.97, w: 12.4, h: 0.1, d: 0.1 },
      this.matGlow, { visualOnly: true }
    );

    // 筐体のベース。落下経路 (z > 2.6) には掛からないよう奥側だけに置く。
    // 下段を奥へ広げたぶん奥行きも 7 → 8 (z: -5.5 .. 2.5)
    const base = new THREE.Mesh(
      new THREE.BoxGeometry(17, 1.4, 8),
      new THREE.MeshStandardMaterial({ color: 0x0d1220, metalness: 0.4, roughness: 0.85 })
    );
    base.position.set(0, -1.9, -1.5);
    base.receiveShadow = true;
    this.group.add(base);
  }
}
