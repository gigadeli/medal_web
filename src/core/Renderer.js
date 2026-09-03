import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { CFG } from '../config.js';

/**
 * three.js 側の一式 (scene / camera / renderer / light / controls) をまとめて持つ。
 * 物理には一切依存しない。
 */
export class Stage {
  constructor(container) {
    const R = CFG.render;

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = R.shadows;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0a0e18);
    this.scene.fog = new THREE.Fog(0x0a0e18, 45, 90);

    this.camera = new THREE.PerspectiveCamera(
      R.fov, window.innerWidth / window.innerHeight, 0.5, 200
    );
    this.camera.position.set(R.cameraPos.x, R.cameraPos.y, R.cameraPos.z);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(R.cameraTarget.x, R.cameraTarget.y, R.cameraTarget.z);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 10;
    this.controls.maxDistance = 40;
    this.controls.maxPolarAngle = Math.PI * 0.49;   // 床下に回り込ませない
    this.controls.minPolarAngle = Math.PI * 0.10;
    // 左クリックは投入に使うので、視点操作は右ドラッグ / ホイールに割り当てる
    this.controls.mouseButtons = {
      LEFT: null,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.ROTATE,
    };
    this.controls.touches = { ONE: null, TWO: THREE.TOUCH.DOLLY_ROTATE };
    this.controls.update();

    this._setupLights();
    this._setupEnvironment();

    this._onResize = this.resize.bind(this);
    window.addEventListener('resize', this._onResize);
  }

  _setupLights() {
    // 全体の起こし。メダルの側面が黒く潰れないように
    this.scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x141a26, 1.1));

    // 主光源 (影を落とす)
    const key = new THREE.DirectionalLight(0xfff2d8, 2.4);
    key.position.set(-9, 26, 12);
    key.castShadow = CFG.render.shadows;
    key.shadow.mapSize.set(2048, 2048);
    const s = key.shadow.camera;
    s.left = -16; s.right = 16; s.top = 20; s.bottom = -16;
    s.near = 4; s.far = 60;
    key.shadow.bias = -0.0015;
    key.shadow.normalBias = 0.04;
    this.scene.add(key);
    this.keyLight = key;

    // 補助光。手前側のメダルの立体感を出す
    const fill = new THREE.DirectionalLight(0x9fc0ff, 0.7);
    fill.position.set(12, 12, -14);
    this.scene.add(fill);

    // 筐体内の演出照明
    const inner = new THREE.PointLight(0xffd28a, 260, 40, 2);
    inner.position.set(0, 9, -4);
    this.scene.add(inner);
  }

  _setupEnvironment() {
    // メダルの金属反射用。RoomEnvironment をそのまま environment に焼き込む
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    pmrem.compileEquirectangularShader();
    const envScene = new RoomEnvironment();
    this.scene.environment = pmrem.fromScene(envScene, 0.04).texture;
    this.scene.environmentIntensity = 0.55;
    envScene.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
    pmrem.dispose();
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  render() {
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    window.removeEventListener('resize', this._onResize);
    this.controls.dispose();
    this.renderer.dispose();
  }
}
