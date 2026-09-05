import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { CFG } from '../config.js';
import { QUALITY } from './Device.js';

const DEG = Math.PI / 180;

/**
 * three.js 側の一式 (scene / camera / renderer / light / controls) をまとめて持つ。
 * 物理には一切依存しない。
 *
 * 端末による違いはここに閉じている (影・アンチエイリアス・解像度・画角)。
 * ゲームの規則に関わるものは何も持っていないので、ここを削っても
 * PC とモバイルで台の挙動は変わらない (core/Device.js を参照)。
 */
export class Stage {
  constructor(container) {
    const R = CFG.render;
    this.container = container;
    this.shadows = R.shadows && QUALITY.shadows;

    this.renderer = new THREE.WebGLRenderer({
      antialias: QUALITY.antialias,
      powerPreference: 'high-performance',
    });
    // iPhone の devicePixelRatio は 3。等倍で描くと画素数が9倍になり、
    // これだけで描画が破綻する。上限を掛けたうえで、
    // 追いつかなければ実測でさらに落とす (_adapt)
    this._pixelRatio = Math.min(window.devicePixelRatio || 1, QUALITY.maxPixelRatio);
    this.renderer.setPixelRatio(this._pixelRatio);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = this.shadows;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0a0e18);
    this.scene.fog = new THREE.Fog(0x0a0e18, 45, 90);

    const { w, h } = this._size();
    this.camera = new THREE.PerspectiveCamera(R.fov, w / h, 0.5, 200);
    this.camera.position.set(R.cameraPos.x, R.cameraPos.y, R.cameraPos.z);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(R.cameraTarget.x, R.cameraTarget.y, R.cameraTarget.z);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 10;
    this.controls.maxDistance = 40;
    this.controls.maxPolarAngle = Math.PI * 0.49;   // 床下に回り込ませない
    this.controls.minPolarAngle = Math.PI * 0.10;
    // 左クリックは投入に使うので、視点操作は右ドラッグ / ホイールに割り当てる。
    // タッチも同じ考えで、1本指は発射・2本指で視点。
    // 指1本で視点が回ると「狙って撃つ」たびに画面が動いてしまう
    this.controls.mouseButtons = {
      LEFT: null,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.ROTATE,
    };
    this.controls.touches = { ONE: null, TWO: THREE.TOUCH.DOLLY_ROTATE };
    this.controls.update();

    this._setupLights();
    this._setupEnvironment();

    this._w = 0;
    this._h = 0;
    this._dolly = 1;
    this._portrait = null;
    this._maxPixelRatio = this._pixelRatio;   // 上げ直すときの上限
    this._frames = 0;
    this._probeAt = 0;
    this._good = 0;            // 続けて余裕があった計測の回数
    this._hold = false;        // 重い演出の最中は測らない
    this._warmup = 2;          // 起動直後の数秒は WASM 初期化などで当てにならない
    this._contextLost = false;
    this.resize();

    this._bindEvents();
  }

  _bindEvents() {
    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
    // iOS Safari は回転直後の innerWidth/Height がまだ古い。
    // orientationchange の後にもう一度測り直す
    window.addEventListener('orientationchange', this._onResize);
    // アドレスバーの出入りで表示領域が変わる (iOS Safari)
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', this._onResize);
    }

    // タブを切り替えて戻ったときなどに GPU コンテキストが飛ぶことがある
    // (モバイルでは珍しくない)。放っておくと毎フレーム WebGL エラーを吐き続けるので、
    // 復帰するまで描画を止める。preventDefault しないと復帰イベントが来ない
    const canvas = this.renderer.domElement;
    this._onLost = (e) => { e.preventDefault(); this._contextLost = true; };
    this._onRestored = () => { this._contextLost = false; this.resize(); };
    canvas.addEventListener('webglcontextlost', this._onLost, false);
    canvas.addEventListener('webglcontextrestored', this._onRestored, false);
  }

  _setupLights() {
    // 全体の起こし。メダルの側面が黒く潰れないように
    this.scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x141a26, 1.1));

    // 主光源 (影を落とす)
    const key = new THREE.DirectionalLight(0xfff2d8, 2.4);
    key.position.set(-9, 26, 12);
    key.castShadow = this.shadows;
    key.shadow.mapSize.set(2048, 2048);
    const s = key.shadow.camera;
    s.left = -16; s.right = 16; s.top = 20; s.bottom = -16;
    s.near = 4; s.far = 60;
    key.shadow.bias = -0.0015;
    key.shadow.normalBias = 0.04;
    this.scene.add(key);
    this.keyLight = key;

    // 補助光。手前側のメダルの立体感を出す。
    // 影を切ると全体が平たくなるので、モバイルではここを少し強める
    const fill = new THREE.DirectionalLight(0x9fc0ff, this.shadows ? 0.7 : 0.95);
    fill.position.set(12, 12, -14);
    this.scene.add(fill);

    // 筐体内の演出照明
    const inner = new THREE.PointLight(0xffd28a, 260, 40, 2);
    inner.position.set(0, 9, -4);
    this.scene.add(inner);
  }

  _setupEnvironment() {
    // メダルの金属反射用。RoomEnvironment をそのまま environment に焼き込む。
    // 生成は起動時の一度きりなので、モバイルでも落とさない
    // (これを切るとメダルが金属に見えなくなり、見た目が別物になる)
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    pmrem.compileEquirectangularShader();
    const envScene = new RoomEnvironment();
    this.scene.environment = pmrem.fromScene(envScene, 0.04).texture;
    this.scene.environmentIntensity = 0.55;
    envScene.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
    pmrem.dispose();
  }

  /**
   * 表示領域の実寸。
   *
   * window.innerHeight は使わない。iOS Safari ではアドレスバーの出入りで
   * 値が動き、canvas が表示領域より縦に長くなって下端がはみ出す。
   * #app は position:fixed / inset:0 なので、要素そのものを測るのが確実。
   */
  _size() {
    return {
      w: this.container.clientWidth || window.innerWidth || 0,
      h: this.container.clientHeight || window.innerHeight || 0,
    };
  }

  /**
   * 画角合わせ。
   *
   * 「最低でも fitWidth × fitHeight は映す」を満たすところまで縦の画角を広げる。
   * 16:9 より横長の画面では条件を最初から満たしているので何も起きない
   * (= PC の見え方は今までどおり)。
   *
   * 広げきれない (maxFov で頭打ち) ぶんはカメラを引いて稼ぐ。
   * d を f 倍して tan(fov/2) を 1/f 倍すれば、映る範囲 d*tan は変わらない。
   */
  _fitCamera(w, h) {
    const R = CFG.render;
    const c = this.controls;
    const aspect = w / h;

    // いま掛かっている引きぶんを外した「素の距離」で判定する。
    // そうしないと引くたびに条件が緩んで、じわじわ寄っていく
    const d = this.camera.position.distanceTo(c.target) / this._dolly;

    const base = Math.tan((R.fov * DEG) / 2);
    let tan = Math.max(
      base,
      R.fitWidth / (2 * d * aspect),   // 横が入りきる画角
      R.fitHeight / (2 * d)            // 縦が入りきる画角
    );

    const maxTan = Math.tan((R.maxFov * DEG) / 2);
    let dolly = 1;
    if (tan > maxTan) {
      dolly = tan / maxTan;
      tan = maxTan;
    }

    this.camera.aspect = aspect;
    this.camera.fov = (2 * Math.atan(tan)) / DEG;
    this.camera.updateProjectionMatrix();

    // 縦持ちに切り替わったときだけ注視点を上げる。
    // 毎回書き戻すとプレイヤーが動かした視点を奪ってしまう
    const portrait = h > w;
    if (portrait !== this._portrait) {
      this._portrait = portrait;
      const t = portrait ? R.cameraTargetPortrait : R.cameraTarget;
      c.target.set(t.x, t.y, t.z);
    }

    if (Math.abs(dolly - this._dolly) > 1e-3) {
      const dir = this.camera.position.clone().sub(c.target);
      dir.multiplyScalar(dolly / this._dolly);
      this.camera.position.copy(c.target).add(dir);
      c.minDistance = 10 * dolly;
      c.maxDistance = 40 * dolly;
      this._dolly = dolly;
    }
    c.update();
  }

  /**
   * 重いと分かっている演出の間だけ、解像度の自動調整を止める
   * (フィーバーの映像。DESIGN.md §13.2)。
   *
   * 25秒で終わるもののために解像度を落とすと、**その後ずっと**ぼやけた画面で
   * 遊ぶことになる。一時的な負荷は「そのまま重く描く」ほうが損が小さい。
   */
  setQualityHold(on) {
    const v = !!on;
    if (this._hold === v) return;
    this._hold = v;
    // 明けの1回目は演出をまたいだ計測になるので捨てる
    this._good = 0;
    this._frames = 0;
    this._probeAt = performance.now();
  }

  _setPixelRatio(v) {
    const next = Math.max(QUALITY.minPixelRatio, Math.min(this._maxPixelRatio, v));
    if (Math.abs(next - this._pixelRatio) < 1e-3) return;
    this._pixelRatio = next;
    this.renderer.setPixelRatio(next);
    this.renderer.setSize(this._w, this._h);
  }

  /**
   * 実測で解像度を上下させる (モバイルのみ)。
   *
   * 端末の性能は事前に分からないので、2秒ごとの実測 fps で決める。
   *
   * 下げる 45fps 未満 / 上げる 55fps 超、と閾値を離してあるのは往復を防ぐため。
   * さらに上げるほうは「続けて2回余裕がある」ことを条件にしている。
   * 同じ閾値で上下させると、境目の端末で解像度がぱたぱた切り替わって見苦しい。
   */
  _adapt(now) {
    if (!QUALITY.adaptiveResolution || this._contextLost) return;
    this._frames++;
    const span = now - this._probeAt;
    if (span < 2000) return;
    const fps = (this._frames * 1000) / span;
    this._probeAt = now;
    this._frames = 0;
    if (this._warmup > 0) { this._warmup--; return; }
    // 裏に回っている間は requestAnimationFrame が止まる。
    // 戻ってきた最初の計測は「4秒で3フレーム」のような値になるので捨てる。
    // これを信じると、タブを切り替えただけで解像度が落ちる
    if (span > 4000) return;
    if (this._hold) return;

    if (fps < 45) {
      this._good = 0;
      this._setPixelRatio(this._pixelRatio - 0.25);
    } else if (fps > 55) {
      if (++this._good >= 2) {
        this._good = 0;
        this._setPixelRatio(this._pixelRatio + 0.25);
      }
    } else {
      this._good = 0;
    }
  }

  /**
   * 表示領域を測り直す。毎フレーム呼んでよい (変化が無ければ即座に返る)。
   *
   * イベントだけに頼らない。実測で2つ踏んだ:
   *   ・起動直後の一瞬、要素の実寸が 0 で返ることがある。
   *     これを掴んだまま resize イベントが来ないと、以後ずっと 1x1 のまま
   *     (aspect 1 で描かれ、画角も合わない)
   *   ・iOS Safari のアドレスバーの出入りは resize が飛ばないことがある
   * 毎フレーム clientWidth を読むのは three.js の作法でもある。
   */
  resize() {
    const { w, h } = this._size();
    // 測れていないなら掴まない。次のフレームでやり直す
    if (w < 2 || h < 2) return;
    if (w === this._w && h === this._h) return;
    this._w = w;
    this._h = h;
    this.renderer.setSize(w, h);
    this._fitCamera(w, h);
  }

  render() {
    if (this._contextLost) return;
    this.resize();
    this.controls.update();
    // OrbitControls は update() のたびにカメラ位置を組み直すので、
    // 揺らしたいものはこの後に入れないと打ち消される (台パンのカメラ揺れ)
    if (this.onBeforeRender) this.onBeforeRender();
    this.renderer.render(this.scene, this.camera);
    this._adapt(performance.now());
  }

  dispose() {
    window.removeEventListener('resize', this._onResize);
    window.removeEventListener('orientationchange', this._onResize);
    if (window.visualViewport) {
      window.visualViewport.removeEventListener('resize', this._onResize);
    }
    const canvas = this.renderer.domElement;
    canvas.removeEventListener('webglcontextlost', this._onLost);
    canvas.removeEventListener('webglcontextrestored', this._onRestored);
    this.controls.dispose();
    this.renderer.dispose();
  }
}
