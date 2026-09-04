import * as THREE from 'three';
import GUI from 'lil-gui';
import Stats from 'stats.js';
import { CFG } from '../config.js';

/**
 * デバッグ支援。D キーで表示/非表示。
 *
 * 物理は「数値を触って目で確かめる」以外に詰め方がないので、
 * lil-gui からの実機調整は事実上必須。
 */
export class Debug {
  constructor({ scene, world, pool, stage, payout, slot, hopper, balls,
                pusher, table, fever, jackpot, jpShow, special, bump, chute }) {
    this.world = world;
    this.pool = pool;
    this.stage = stage;
    this.payout = payout;
    this.slot = slot;
    this.hopper = hopper;
    this.balls = balls;
    this.pusher = pusher;
    this.table = table;
    this.fever = fever;
    this.jackpot = jackpot;
    this.jpShow = jpShow;
    this.special = special;
    this.bump = bump;
    this.chute = chute;
    this.enabled = false;

    // --- Rapier のコライダー可視化 ---
    const geo = new THREE.BufferGeometry();
    const mat = new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false });
    this.lines = new THREE.LineSegments(geo, mat);
    this.lines.frustumCulled = false;
    this.lines.visible = false;
    this.lines.renderOrder = 999;
    scene.add(this.lines);

    // --- stats.js ---
    this.stats = new Stats();
    this.stats.dom.style.cssText = 'position:fixed;top:120px;right:16px;z-index:40;display:none;';
    document.body.appendChild(this.stats.dom);

    this._buildGui();

    window.addEventListener('keydown', (e) => {
      if (e.code === 'KeyD') this.toggle();
    });
  }

  _buildGui() {
    const gui = new GUI({ title: 'DEBUG (D)' });
    gui.domElement.style.cssText += 'position:fixed;top:16px;right:16px;z-index:40;';
    gui.hide();
    this.gui = gui;

    const fPusher = gui.addFolder('プッシャー');
    fPusher.add(CFG.pusher, 'period', 0.6, 6.0, 0.1).name('周期 (秒/往復)');
    fPusher.add(CFG.pusher, 'strokeHalf', 0.2, 2.0, 0.05).name('片振幅');

    const fMedal = gui.addFolder('メダル');
    const apply = () => this.pool.applyMaterial();
    fMedal.add(CFG.medal, 'friction', 0.0, 1.0, 0.01).name('摩擦').onChange(apply);
    fMedal.add(CFG.medal, 'restitution', 0.0, 0.5, 0.01).name('反発').onChange(apply);
    fMedal.add(CFG.medal, 'linearDamping', 0.0, 2.0, 0.05).name('線形減衰').onChange(apply);
    fMedal.add(CFG.medal, 'angularDamping', 0.0, 2.0, 0.05).name('角減衰').onChange(apply);

    const fPhys = gui.addFolder('物理');
    fPhys.add(CFG.physics, 'gravity', -800, -50, 1).name('重力').onChange((v) => {
      this.world.gravity = { x: 0, y: v, z: 0 };
    });
    fPhys.add(CFG.physics, 'solverIterations', 1, 16, 1).name('ソルバ反復').onChange((v) => {
      const ip = this.world.integrationParameters;
      if (ip && 'numSolverIterations' in ip) ip.numSolverIterations = v;
    });
    fPhys.add(this, 'showColliders').name('コライダー表示');

    const fSlot = gui.addFolder('スロット / ボール');
    fSlot.add(this, 'spin').name('スロットを1回まわす');
    const names = {};
    CFG.slot.symbols.forEach((sym, i) => { names[`${sym.name} (${sym.pay})`] = i; });
    fSlot.add(this, 'forceSymbol', names).name('強制する絵柄');
    fSlot.add(this, 'spinForced').name('この絵柄でまわす');
    fSlot.add(this, 'returnBalls').name('ボールを全部戻す');

    const fBall = gui.addFolder('ボールの物理');
    fBall.add(CFG.ball, 'friction', 0, 1, 0.01).name('摩擦').onChange(() => this.applyBall());
    fBall.add(CFG.ball, 'restitution', 0, 0.8, 0.01).name('反発').onChange(() => this.applyBall());
    fBall.add(CFG.ball, 'settleSeconds', 0, 4, 0.1).name('戻り後の静止時間 (秒)');

    // --- ギミック (DESIGN_GIMMICKS.md) ---
    const fGim = gui.addFolder('ギミック');
    fGim.add(this, 'enterFever').name('フィーバー突入');
    fGim.add(this, 'exitFever').name('フィーバー終了');
    fGim.add(CFG.fever, 'seconds', 5, 90, 1).name('フィーバー時間 (秒)');
    fGim.add(CFG.fever, 'strokeHalf', 0.5, 2.0, 0.05).name('F中の片振幅');
    fGim.add(CFG.fever, 'period', 0.6, 3.0, 0.05).name('F中の周期');
    fGim.add(CFG.fever, 'tableRx', -0.10, 0.12, 0.005).name('F中の傾き');
    fGim.add(CFG.fever, 'stepsToEnter', 1, 8, 1).name('突入に必要なSTEP');
    fGim.add(this, 'fireJackpot').name('ジャックポットを撃つ');
    fGim.add(this, 'fillJackpot').name('JPを上限まで溜める');
    fGim.add(CFG.jackpot, 'towerLimit', 20, 400, 10).name('タワーの上限枚数');
    fGim.add(this, 'grantAll').name('特殊メダルを配る');
    fGim.add(this, 'openFlippers').name('フリッパーを開く');
    fGim.add(this, 'chuckerReport').name('チャッカーの入賞数をログ');

    const fTool = gui.addFolder('ツール');
    fTool.add(this, 'burst50').name('メダル50枚 投入');
    fTool.add(this, 'clearMedals').name('メダル全消去');
    fTool.add(this, 'resetCredit').name('クレジットリセット');
    fTool.add(CFG.render, 'shadows').name('影').onChange((v) => {
      this.stage.renderer.shadowMap.enabled = v;
      this.stage.keyLight.castShadow = v;
      this.stage.scene.traverse((o) => { if (o.isMesh) o.material.needsUpdate = true; });
    });
  }

  showColliders = false;

  forceSymbol = 0;

  spin = () => this.slot && this.slot.request();

  spinForced = () => {
    if (!this.slot) return;
    this.slot.force = Number(this.forceSymbol);
    this.slot.request();
  };

  returnBalls = () => this.balls && this.balls.respawnAll();

  enterFever = () => this.fever && this.fever.enter();
  exitFever = () => this.fever && this.fever.exit();

  fireJackpot = () => {
    if (!this.jackpot || !this.jpShow) return;
    this.jpShow.start(this.jackpot.claim());
  };

  fillJackpot = () => {
    if (!this.jackpot) return;
    this.jackpot.amount = CFG.jackpot.max;
    this.jackpot.onChange(this.jackpot);
  };

  grantAll = () => {
    if (!this.special) return;
    for (const k of ['gold', 'bomb', 'ticket']) this.special.grant(k, CFG.special.max);
  };

  openFlippers = () => this.chute && this.chute.triggerFlippers();

  /**
   * チャッカーの実測用。
   * DESIGN_GIMMICKS.md §8-1「入賞率は切り欠きの幅にほぼ比例するか」を確かめる。
   * 幅の比と入賞数の比がずれるなら、山の流れが一様でないということ
   */
  chuckerReport = () => {
    if (!this.payout) return;
    const total = this.payout.credit + this.payout.chucker;
    const rows = CFG.chute.slots.map((s) => {
      const n = this.payout.chuckerById[s.id] || 0;
      const w = s.x1 - s.x0;
      return {
        id: s.id,
        幅: w.toFixed(2),
        奥行: (s.dz1 - s.dz0).toFixed(2),
        入賞: n,
        '実測%': total ? ((n / total) * 100).toFixed(1) : '0.0',
        '幅比%': ((w / CFG.chute.box.w) * 100).toFixed(1),
      };
    });
    console.table(rows);
    console.log(`払い出し ${this.payout.credit} / チャッカー ${this.payout.chucker} / ロスト ${this.payout.lost}`);
  };

  applyBall = () => this.balls && this.balls.applyMaterial();

  /** しきい値を変えたら既存のコライダーにも反映する */
  applyImpactThreshold = () => {
    for (const m of this.pool.items) {
      if (typeof m.collider.setContactForceEventThreshold === 'function') {
        m.collider.setContactForceEventThreshold(CFG.audio.impactThreshold);
      }
    }
  };

  burst50 = () => {
    for (let i = 0; i < 50; i++) {
      this.pool.spawn((Math.random() - 0.5) * 14);
    }
  };

  clearMedals = () => this.pool.clear();
  resetCredit = () => this.payout.reset();

  toggle() {
    this.enabled = !this.enabled;
    this.stats.dom.style.display = this.enabled ? '' : 'none';
    if (this.enabled) this.gui.show(); else this.gui.hide();
    this.lines.visible = this.enabled && this.showColliders;
  }

  beginFrame() { if (this.enabled) this.stats.begin(); }

  endFrame() {
    if (!this.enabled) return;
    this.stats.end();

    this.lines.visible = this.showColliders;
    if (this.showColliders) {
      const buffers = this.world.debugRender();
      this.lines.geometry.setAttribute('position', new THREE.BufferAttribute(buffers.vertices, 3));
      this.lines.geometry.setAttribute('color', new THREE.BufferAttribute(buffers.colors, 4));
    }
  }
}
