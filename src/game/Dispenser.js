import * as THREE from 'three';
import { CFG } from '../config.js';

const L = CFG.layout;

/**
 * 投入口 (DESIGN.md §7.2)
 *
 * ・マウス位置を上段デッキの高さの平面に投影して投入 x を決める
 * ・クリック / Space で1枚。長押しで連続 (クールダウンあり)
 * ・視点操作は右ドラッグに割り当ててあるので、左クリックはゲーム専用
 */
export class Dispenser {
  constructor(scene, camera, domElement, pool, hooks = {}) {
    this.camera = camera;
    this.dom = domElement;
    this.pool = pool;
    // 持ち枚数が尽きていれば投入させない。TILT 中もここで止める
    this.canInsert = hooks.canInsert || (() => true);
    this.onInsert = hooks.onInsert || (() => {});
    // 特殊メダル (DESIGN_GIMMICKS.md §3.7)。null を返せば通常メダル
    this.getSpawnOptions = hooks.getSpawnOptions || (() => null);

    this.x = 0;
    this.cooldown = 0;
    this.pending = false;   // 短いクリックを取りこぼさないためのラッチ
    this.inserted = 0;
    this.holding = false;
    this.keyLeft = false;
    this.keyRight = false;

    this._ray = new THREE.Raycaster();
    this._ndc = new THREE.Vector2();
    this._plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -L.deckHeight);
    this._hit = new THREE.Vector3();

    this._buildMarker(scene);
    this._bind();
  }

  _buildMarker(scene) {
    this.marker = new THREE.Group();
    scene.add(this.marker);

    // 投入口のリング
    this.ringMat = new THREE.MeshStandardMaterial({
      color: 0x1a2436, emissive: 0x5cc8ff, emissiveIntensity: 1.5, roughness: 0.4,
    });
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.85, 0.09, 8, 32), this.ringMat);
    ring.rotation.x = Math.PI / 2;
    this.marker.add(ring);

    // 落下位置を示すガイド線
    const h = L.spawn.y - L.deckHeight;
    this.guideMat = new THREE.MeshBasicMaterial({
      color: 0x5cc8ff, transparent: true, opacity: 0.22,
    });
    const guide = new THREE.Mesh(
      new THREE.CylinderGeometry(0.035, 0.035, h, 6),
      this.guideMat
    );
    guide.position.y = -h / 2;
    this.marker.add(guide);

    this.marker.position.set(0, L.spawn.y, L.spawn.z);
  }

  _bind() {
    const dom = this.dom;

    this._onMove = (e) => {
      const rect = dom.getBoundingClientRect();
      this._ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      this._ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      this._ray.setFromCamera(this._ndc, this.camera);
      if (this._ray.ray.intersectPlane(this._plane, this._hit)) {
        this.x = THREE.MathUtils.clamp(this._hit.x, -L.spawn.xLimit, L.spawn.xLimit);
      }
    };

    this._onDown = (e) => {
      if (e.button !== 0) return;   // 右/中ボタンは視点操作
      this.holding = true;
      this.pending = true;          // 押した瞬間の1枚は必ず出す
      this.cooldown = 0;
    };
    this._onUp = () => { this.holding = false; };

    this._onKeyDown = (e) => {
      if (e.code === 'ArrowLeft') this.keyLeft = true;
      if (e.code === 'ArrowRight') this.keyRight = true;
      if (e.code === 'Space') {
        if (!this.holding) this.pending = true;
        this.holding = true;
        e.preventDefault();
      }
    };
    this._onKeyUp = (e) => {
      if (e.code === 'ArrowLeft') this.keyLeft = false;
      if (e.code === 'ArrowRight') this.keyRight = false;
      if (e.code === 'Space') this.holding = false;
    };

    dom.addEventListener('pointermove', this._onMove);
    dom.addEventListener('pointerdown', this._onDown);
    window.addEventListener('pointerup', this._onUp);
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    dom.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  /** 物理ステップと同じ固定 dt で呼ぶ */
  update(dt) {
    if (this.keyLeft) this.x -= CFG.input.moveSpeed * dt;
    if (this.keyRight) this.x += CFG.input.moveSpeed * dt;
    this.x = THREE.MathUtils.clamp(this.x, -L.spawn.xLimit, L.spawn.xLimit);

    this.cooldown -= dt;
    if ((this.pending || this.holding) && this.cooldown <= 0) {
      // 空きの確認を先に済ませる。特殊メダルの手持ちを減らしてから
      // 満杯で弾かれると、1枚が黙って消えることになる
      if (this.canInsert() && this.pool.freeCount > 0) {
        const opts = this.getSpawnOptions();
        const medal = this.pool.spawn(this.x, L.spawn.y, L.spawn.z, opts);
        if (medal) {
          this.inserted++;
          this.cooldown = CFG.input.dropCooldown;
          this.onInsert(medal);
        }
      }
      this.pending = false;
    }
  }

  /** 特殊メダルを選んでいる間はマーカーの色を変える */
  setMarkerColor(hex) {
    if (this._markerColor === hex) return;
    this._markerColor = hex;
    this.ringMat.emissive.setHex(hex);
    this.guideMat.color.setHex(hex);
  }

  syncMesh() {
    this.marker.position.x = this.x;
  }

  dispose() {
    this.dom.removeEventListener('pointermove', this._onMove);
    this.dom.removeEventListener('pointerdown', this._onDown);
    window.removeEventListener('pointerup', this._onUp);
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
  }
}
