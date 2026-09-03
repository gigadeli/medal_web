import RAPIER from '@dimforge/rapier3d-compat';
import { CFG } from '../config.js';

/**
 * Rapier の初期化。
 * -compat 版は WASM を base64 で同梱しているので Vite 側の追加設定が要らないが、
 * 代わりに await RAPIER.init() が必須。起動フローの先頭で必ず待つこと。
 */
export async function createPhysics() {
  await RAPIER.init();

  const world = new RAPIER.World({ x: 0, y: CFG.physics.gravity, z: 0 });
  world.timestep = CFG.physics.timestep;

  // ソルバ反復数はバージョンによってプロパティ名が異なるため、存在するものだけ設定する
  const ip = world.integrationParameters;
  if (ip) {
    if ('numSolverIterations' in ip) ip.numSolverIterations = CFG.physics.solverIterations;
    if ('numAdditionalFrictionIterations' in ip) ip.numAdditionalFrictionIterations = 4;
    if ('numInternalPgsIterations' in ip) ip.numInternalPgsIterations = 1;
  }

  // 衝突音のための接触力イベント用キュー。
  // COLLISION_EVENTS ではなく CONTACT_FORCE_EVENTS を使うのが要点で、
  // しきい値を超えた接触だけが飛んでくるので「聞こえるべき衝突」だけを拾える。
  const eventQueue = typeof RAPIER.EventQueue === 'function' ? new RAPIER.EventQueue(true) : null;

  return { RAPIER, world, eventQueue };
}

/**
 * 静的な箱 (メッシュ + Fixed コライダー) をまとめて作るヘルパ。
 * layout の定義が「中心座標 + 全体サイズ」なので、コライダーには半分を渡す。
 */
export function createFixedBox(world, RAPIER, box, opts = {}) {
  const bodyDesc = RAPIER.RigidBodyDesc.fixed().setTranslation(box.x, box.y, box.z);
  // box.rx があれば X 軸まわりに傾ける (落とし口の登り勾配に使う)。
  // 負の角度で手前(+Z)側が持ち上がる
  if (box.rx) {
    const h = box.rx / 2;
    bodyDesc.setRotation({ x: Math.sin(h), y: 0, z: 0, w: Math.cos(h) });
  }
  const body = world.createRigidBody(bodyDesc);

  const colDesc = RAPIER.ColliderDesc
    .cuboid(box.w / 2, box.h / 2, box.d / 2)
    .setFriction(opts.friction ?? CFG.table.friction)
    .setRestitution(opts.restitution ?? CFG.table.restitution);

  const collider = world.createCollider(colDesc, body);
  return { body, collider };
}
