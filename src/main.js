import { CFG } from './config.js';
import { Stage } from './core/Renderer.js';
import { Loop } from './core/Loop.js';
import { createPhysics } from './physics/World.js';
import { Cabinet } from './game/Cabinet.js';
import { Pusher } from './game/Pusher.js';
import { MedalPool } from './game/MedalPool.js';
import { Dispenser } from './game/Dispenser.js';
import { Payout } from './game/Payout.js';
import { Hopper } from './game/Hopper.js';
import { LotteryBallSet } from './game/LotteryBall.js';
import { SlotMachine } from './game/SlotMachine.js';
import { SlotDisplay } from './game/SlotDisplay.js';
import { AntiJam } from './game/AntiJam.js';
import { Wallet } from './game/Wallet.js';
import { SaveStore } from './save/SaveStore.js';
import { Sound } from './audio/Sound.js';
import { Debug } from './ui/Debug.js';
import { mountUI } from './ui/mount';

/** 計測値を UI に流す間隔 (秒)。毎フレーム流すと React が 60fps で回ってしまう */
const STATS_INTERVAL = 0.25;
/** 獲得ポップの最短間隔 (秒)。大量払い出しで打ち続けないように */
const GAIN_POP_INTERVAL = 0.12;

/**
 * 起動シーケンス。
 *
 * UI を先にマウントしてローディングを出してから、Rapier の WASM 初期化を待つ。
 * ゲームループは React を知らない。mountUI が返すハンドル経由でストアに書くだけ。
 */
async function main() {
  const sound = new Sound();

  // --- セーブの読み込み (DESIGN.md §11) ---
  const saved = SaveStore.load();
  // 「記録を消す」で振り直すので const ではない
  let userId = (saved && saved.userId) || SaveStore.newUserId();
  const fieldStock = Math.min(
    (saved && Number.isFinite(saved.fieldStock)) ? saved.fieldStock : CFG.save.defaultFieldStock,
    CFG.medal.maxCount
  );
  if (saved && saved.settings) sound.setMuted(!!saved.settings.muted);

  const wallet = new Wallet();
  if (saved) wallet.restore(saved);

  // 場の枚数は物理ができてからでないと数えられないので、あとで差し替える
  let currentFieldStock = () => fieldStock;

  const snapshot = () => ({
    v: CFG.save.version,
    userId,
    savedAt: Date.now(),
    fieldStock: currentFieldStock(),
    settings: { muted: sound.muted },
    ...wallet.serialize(),
  });
  const persist = () => SaveStore.save(snapshot());

  const ui = mountUI(document.getElementById('ui-root'), {
    onRestart: () => wallet.reset(),
    onClearData: () => {
      SaveStore.clear();
      // 識別子も一緒に消す (§11.3)。同じ ID が残ると「消した」ことにならない
      userId = SaveStore.newUserId();
      wallet.reset(true);
      persist();               // 消した直後の状態を書き直す
    },
  });

  // ストアへの反映は UI ができてから配線する (Wallet 側は UI も保存も知らない)
  wallet.onChange = (w) => {
    ui.setGame({
      medals: w.medals, best: w.best,
      inserted: w.run.inserted, earned: w.run.earned, lost: w.run.lost,
      gameOver: w.gameOver,
      saveError: !SaveStore.available || !!SaveStore.lastError,
    });
    persist();
  };
  wallet.onChange(wallet);

  // タブを閉じる / 隠れるときに書き切る。
  // beforeunload はモバイルのアプリ切り替えで発火しないので使わない
  const flush = () => { SaveStore.save(snapshot()); SaveStore.flush(); };
  window.addEventListener('pagehide', flush);
  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });

  try {
    const { RAPIER, world, eventQueue } = await createPhysics();
    const stage = new Stage(document.getElementById('app'));

    const cabinet = new Cabinet(stage.scene, world, RAPIER);
    const pusher = new Pusher(stage.scene, world, RAPIER);
    const pool = new MedalPool(stage.scene, world, RAPIER);
    const balls = new LotteryBallSet(stage.scene, world, RAPIER);

    // 抽選の演出は DOM ではなく筐体前面の液晶として 3D シーンに描く
    const slotDisplay = new SlotDisplay(stage.scene, sound, (index) =>
      ui.setGame({ lastWinIndex: index, lastWinSeq: Date.now() })
    );

    let lastGainPop = -1;
    const payout = new Payout(pool, {
      onGain: () => {
        wallet.earn(1);
        sound.payout();
        if (loop.simTime - lastGainPop >= GAIN_POP_INTERVAL) {
          lastGainPop = loop.simTime;
          ui.popGain(1);
        }
      },
      onLost: () => wallet.recordLost(1),
    });

    const hopper = new Hopper(pool);
    const antiJam = new AntiJam(pool);
    const slot = new SlotMachine({
      hopper,
      sound,
      present: (res) => slotDisplay.play(res),
      onDraw: (res) => wallet.recordSpin(res),
    });

    const dispenser = new Dispenser(
      stage.scene, stage.camera, stage.renderer.domElement, pool,
      {
        canInsert: () => wallet.canInsert(),
        onInsert: () => wallet.spend(1),
      }
    );

    const debug = new Debug({ scene: stage.scene, world, pool, stage, payout, slot, hopper, balls });

    prefill(pool, fieldStock);
    currentFieldStock = () => pool.activeCount;
    ui.setGame({ holdMax: CFG.slot.maxQueue });

    let statsTimer = 0;
    let lastMuted = sound.muted;

    const loop = new Loop(
      // ---- 固定タイムステップ (物理) ----
      (dt, t) => {
        dispenser.update(dt);
        hopper.update(dt);
        pusher.update(t + dt);      // 次ステップ終了時の目標位置

        world.step(eventQueue || undefined);

        // 接触力イベントを毎ステップ吸い出す (溜めると際限なく増える)
        if (eventQueue) {
          eventQueue.drainContactForceEvents((e) => {
            sound.impact(e.totalForceMagnitude());
          });
        }

        pool.captureTransforms();
        pool.wakeNear(pusher.frontZ(t + dt));

        // 抽選ボールが落ちたらスロットを回す (サイドポケットはハズレ)
        const fell = balls.update(dt);
        for (let i = 0; i < fell.payout; i++) slot.request();
        if (fell.pocket > 0) sound.lose();

        payout.update();
        antiJam.update(dt, payout.credit + payout.lost, pusher.frontZ(t + dt));
        wallet.update(dt);
      },
      // ---- 描画 ----
      (alpha, realDt) => {
        debug.beginFrame();
        sound.beginFrame();

        // 補間後の見かけ上の時刻。メダルの lerp と足並みを揃える
        const renderTime = loop.simTime - (1 - alpha) * loop.dt;
        pusher.syncMesh(renderTime);
        dispenser.syncMesh();
        balls.syncMesh(alpha);
        slotDisplay.update(realDt);
        pool.sync(alpha);

        stage.render();

        // 変化が疎い値。ストア側で浅い比較をするので、同じ値なら再レンダリングは起きない。
        // 持ち枚数まわりは Wallet の onChange から流れてくるのでここには無い
        ui.setGame({
          hold: slot.held,
          muted: sound.muted,
        });
        // M キーでの切り替えは Wallet を経由しないので、ここで拾って保存する
        if (sound.muted !== lastMuted) {
          lastMuted = sound.muted;
          persist();
        }

        // 毎フレーム変わる値だけは明示的に間引く
        statsTimer += realDt;
        if (statsTimer >= STATS_INTERVAL) {
          statsTimer = 0;
          ui.setStats({
            fps: loop.fps,
            onField: pool.activeCount,
            stepMs: Math.round(loop.stepMs * 10) / 10,
          });
        }

        debug.endFrame();
      }
    );

    loop.start();

    // 1フレーム描けてからローディングを消す
    requestAnimationFrame(() =>
      requestAnimationFrame(() => ui.setGame({ loading: false }))
    );

    // コンソールから触れるように
    window.game = {
      CFG, world, stage, pool, pusher, balls, payout,
      dispenser, hopper, slot, slotDisplay, sound, loop, cabinet, debug, antiJam, wallet, ui,
    };
  } catch (err) {
    console.error(err);
    ui.fail(err && err.message ? err.message : String(err));
  }
}

/**
 * 初期配置。空のフィールドから始めると押し出すものが無くて面白くないので、
 * 実機と同じように最初から山を作っておく。
 *
 * 重なった状態で生成すると弾け飛び、高所から落とすと着弾時にめり込む。
 * どちらも避けるため「置きたい面のすぐ上」に格子状に並べ、少しだけ散らす。
 *
 * 枚数はセーブから復元する (DESIGN.md §11.1)。座標は保存していないので、
 * 「前回と同じ枚数の山を積み直す」という形になる。
 *
 * @param {number} count 積みたい枚数
 */
function prefill(pool, count = CFG.save.defaultFieldStock) {
  const D = CFG.layout.deckHeight;
  const t = CFG.medal.thickness;
  const MAX_LAYERS = 14;   // これ以上積むと塔になって崩れ方が乱暴になる

  // 格子の間隔はメダル直径(1.0)より広く取り、ばらつきも重ならない範囲に収める。
  // 重なった状態で生成すると剛体が弾け飛ぶ
  const grid = (cols, rows, want, x0, dx, z0, dz, y0) => {
    let placed = 0;
    const layers = Math.min(MAX_LAYERS, Math.ceil(want / (cols * rows)));
    for (let l = 0; l < layers && placed < want; l++) {
      for (let ix = 0; ix < cols && placed < want; ix++) {
        for (let iz = 0; iz < rows && placed < want; iz++) {
          if (!pool.spawn(
            x0 + ix * dx + (Math.random() - 0.5) * 0.6,
            y0 + l * (t + 0.09) + Math.random() * 0.04,
            z0 + iz * dz + (Math.random() - 0.5) * 0.5
          )) return placed;
          placed++;
        }
      }
    }
    return placed;
  };

  const deckWant = Math.round(count * CFG.save.deckRatio);
  // 上段 (プッシャー上面) に山を作る。
  // 背面壁に接するところから隙間なく並べること。山が壁から途切れていると
  // 「後退時に堰き止められる」連鎖が切れて、いつまでも前に進まない
  const onDeck = grid(7, 4, deckWant, -5.4, 1.8, -1.8, 1.2, D + t);
  // 下段にも敷いておく。ここが薄いと押しても縁まで届かず、いつまでも落ちない。
  // 手前は勾配になっているので、めり込まないよう少し高めから落とす
  grid(7, 3, count - onDeck, -5.4, 1.8, 2.8, 1.2, t + 0.3);
}

main();
