/**
 * しきい値 (DESIGN_SERVER.md §8)
 *
 * ゲームのルールに由来する数字は **`src/config.js` を直接 import** する。
 * サーバに定数を書き写すと、config を触ったときに片方だけ古くなる。
 * `config.js` は依存も DOM 参照も持たない純粋なデータなので Worker から読める。
 */
import { CFG } from '../../config.js';

/* ---------------- ゲームに由来するもの ---------------- */

/** 壊れた/改竄された値の絶対上限。`Wallet` と同じ値 (9,999,999) */
export const SANITY_MAX: number = CFG.wallet.sanityMax;

/** 開始時の持ち枚数。best_medals の上界を出すのに使う */
export const WALLET_START: number = CFG.wallet.start;

/**
 * 払い出しの物理的な天井 (枚/秒)。
 * ホッパーがこれ以上の速さで吐くことはないので、
 * 「実際にプレイして得られる最大」の上界になる
 */
export const HOPPER_MAX_RATE: number = CFG.hopper.maxRate;

/** ジャックポット1回あたりの最大額 */
export const JP_MAX: number = CFG.jackpot.max;

/* ---------------- サーバ側で決めるもの ---------------- */

/**
 * ★ レート許容量の分母の頭打ち (§8.3)
 *
 * ここが初稿の最大の穴を塞いでいる。放置した時間ぶんの許容量が
 * 貯まらないので、「1時間待ってから大きな数字を送る」が効かなくなる。
 * 持続的な上限は HOPPER_MAX_RATE 枚/秒 —— ゲームの物理的な天井そのもの —— に固定される。
 */
export const RATE_WINDOW_MS = 5 * 60 * 1000;

/** 端数と往復の遅れを吸収するぶん。ここを大きくしすぎない */
export const RATE_GRACE = 100;

/** 上限に当たった回数がこれを超えたら flagged。1回は誤差でも起きうる */
export const STRIKES_TO_FLAG = 3;

/**
 * ★ 印を立てる条件は、クランプの条件よりずっと緩くする
 *
 * 実測で分かったこと: 上限に当たったかどうかで印を立てると、
 * **正直なプレイヤーにも立つ**。オフラインで20分遊んでから初回同期すると、
 * 申告 3,000 枚に対して許容量は数百枚しかなく、当たり前に上限に当たる。
 * （カウンタ自体は1分ほど遊べば追いつくので、クランプ側は問題ない。）
 *
 * 誤爆で正直なプレイヤーを永久にランキングから外すコストは、
 * 印を1つ見逃すコストよりずっと高い。クランプが本体で印はおまけ、という
 * §8.2 の力関係からしてもこちらが正しい。
 * `Wallet.restore` の「厳しく弾かない」と同じ判断。
 *
 * なので印は「そのアカウントの一生ぶんを積んでも届かない」ときだけ立てる。
 * 未登録期間に貯めた記録を吸収するための余裕がこれ。
 */
export const BACKLOG_GRACE = 1_000_000;

/* ---------------- ランキング参加資格 (§8.5) ---------------- */

/** サーバが実測したプレイ時間。Sybil のコストをここで作る */
export const ELIGIBLE_PLAY_MS = 30 * 60 * 1000;

/** 同期のあった日数。1日で稼げないようにする */
export const ELIGIBLE_DAYS = 3;

/** これ未満の母数では統計にならないので数字を見せない */
export const RANKING_MIN_POPULATION = 30;

/** 分布表の段数 */
export const HISTOGRAM_BUCKETS = 100;

/* ---------------- 入口の制限 ---------------- */

/**
 * 本文の上限 (§15-9)。実測 319 バイトのセーブに対して十分な余裕。
 * Workers は 100MB まで受けてしまうので、`json()` を呼ぶ **前** に弾く
 */
export const MAX_BODY_BYTES = 8 * 1024;

/**
 * セッションの寿命。Cookie の Max-Age と揃える。
 *
 * 設計では2年にしていたが、**400日が上限**だった（実測: Hono が
 * "Cookies Max-Age SHOULD NOT be greater than 400 days" で例外を投げる。
 * ブラウザ側も同じ上限で切り詰める）。長く書いても意味がないので合わせる。
 *
 * 400日以上あいだが空いた端末は Cookie を失う。D1 の行は残っているので、
 * そのときは引き継ぎコード (§5.3) が唯一の復帰経路になる。
 */
export const SESSION_TTL_MS = 400 * 24 * 60 * 60 * 1000;

/** 引き継ぎコードの寿命 */
export const TRANSFER_TTL_MS = 10 * 60 * 1000;

/** 1日に作れるユーザー数の上限 (§15-3) */
export const SIGNUP_PER_DAY = 2000;

export const COOKIE_NAME = 'mw_token';

/* ---------------- 共通の小道具 ---------------- */

/**
 * 非負整数として読む。`Wallet` の `uint()` と同じ方針で、
 * **捨てずに直す**。厳しく弾くと、こちらのバグで正直なプレイヤーの記録を消す
 */
export function uint(v: unknown, fallback = 0, max = SANITY_MAX): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  const n = Math.floor(v);
  if (n < 0) return fallback;
  return n > max ? max : n;
}

/** epoch からの日数。日付の境界は UTC で数える (サーバの時計) */
export function dayOf(ms: number): number {
  return Math.floor(ms / 86400000);
}

/**
 * best_medals を分布表の段に割る。
 * 対数にするのは、実際の分布が低い側に密集するため
 */
export function bucketOf(best: number): number {
  if (best <= 0) return 0;
  const b = Math.floor(Math.log10(1 + best) * 14);
  return Math.max(0, Math.min(HISTOGRAM_BUCKETS - 1, b));
}
