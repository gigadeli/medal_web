/**
 * 申告された数字に頭を押さえる (DESIGN_SERVER.md §8.2 / §8.3)
 *
 * ■ この設計でいちばん大事な考え方
 *   初稿は違反に `flagged = 1` の **印を付ける** 設計だった。これは間違いで、
 *   印は「記録を消す」(DELETE /api/user) で洗える (§15-2)。
 *   そして §7.3 は「消すと書いたボタンは消さなければいけない」と決めているので、
 *   墓標を残す解決は取れない。
 *
 *   なので中心に置くのは印ではなく、
 *   **`scores` のカウンタが1回の同期で進める量に上限をかけること**。
 *   カウンタ側に効くので、消して作り直しても最初からやり直しになるだけになる。
 *
 * ■ なぜこれで効くのか
 *   分母 (経過時間) は必ず **サーバの時計** で測り、5分で頭打ちにする。
 *   放置しても許容量が貯まらないので、持続的な上限は
 *   `CFG.hopper.maxRate` = 50枚/秒 —— ゲームの物理的な天井 —— に固定される。
 *
 * ■ それでも防げないこと (§8.4)
 *   50枚/秒を出し続ける自動化は通る。だからランキングに載せるのは
 *   `best_medals` (一発勝負) だけにして、積み上がる数字は載せない。
 */
import type { ScoreClaim } from './schema.js';
import {
  BACKLOG_GRACE, HOPPER_MAX_RATE, JP_MAX, RATE_GRACE, RATE_WINDOW_MS, SANITY_MAX,
  STRIKES_TO_FLAG, WALLET_START,
  ELIGIBLE_DAYS, ELIGIBLE_PLAY_MS,
  bucketOf, dayOf,
} from './limits.js';

export type ScoreState = {
  best_medals: number;
  lifetime_earned: number;
  jp_wins: number;
  jp_paid: number;
  play_ms: number;
  sync_days: number;
  last_sync_day: number;
  bucket: number;
  strikes: number;
  flagged: number;
};

export const emptyScore = (): ScoreState => ({
  best_medals: 0,
  lifetime_earned: 0,
  jp_wins: 0,
  jp_paid: 0,
  play_ms: 0,
  sync_days: 0,
  last_sync_day: -1,
  bucket: 0,
  strikes: 0,
  flagged: 0,
});

/**
 * この同期で獲得枚数をいくつまで進めてよいか。
 *
 * `dtMs` を RATE_WINDOW_MS で頭打ちにするのが要点。
 * 1時間放置してから送っても、5分ぶんの許容量しか出ない。
 */
export function allowance(dtMs: number): number {
  const eff = Math.min(Math.max(dtMs, 0), RATE_WINDOW_MS);
  return Math.floor((HOPPER_MAX_RATE * eff) / 1000) + RATE_GRACE;
}

/**
 * そのアカウントが一生かけても届かない量。印を立てる判定にだけ使う。
 * クランプの判定 (`allowance`) より桁違いに緩い —— 理由は `BACKLOG_GRACE` の注記。
 */
export function absurdThreshold(now: number, createdAt: number): number {
  const lifeSec = Math.max(0, now - createdAt) / 1000;
  return HOPPER_MAX_RATE * lifeSec + BACKLOG_GRACE;
}

export type ApplyResult = {
  next: ScoreState;
  /** 上限に当たった (＝申告どおりには進めなかった)。正直なプレイヤーでも起きる */
  clamped: boolean;
};

/**
 * @param prev       いま D1 にある値
 * @param claim      クライアントの申告 (信じていない)
 * @param now        サーバの現在時刻
 * @param lastSeenAt サーバが最後にこのユーザーを見た時刻
 * @param createdAt  アカウントを作った時刻。印の判定にだけ使う
 */
export function applyClaim(
  prev: ScoreState, claim: ScoreClaim, now: number, lastSeenAt: number, createdAt: number
): ApplyResult {
  const dt = Math.min(Math.max(now - lastSeenAt, 0), RATE_WINDOW_MS);
  const allow = allowance(dt);

  /* --- ① 獲得枚数: レートを見てから単調性を当てる ---
     順序が逆だと「大きいほうを採る」が先に走り、
     レートを見る前に巨大な値が入る (§15-6) */
  const claimedEarned = Math.min(claim.lifetimeEarned, SANITY_MAX);
  const delta = claimedEarned - prev.lifetime_earned;
  const granted = delta <= 0 ? 0 : Math.min(delta, allow);
  const clamped = delta > allow;
  const nextEarned = prev.lifetime_earned + granted;

  /* --- ② 最高持ち枚数 ---
     medals は earn() でしか増えないので、常に
       medals <= CFG.wallet.start + lifetime.earned
     が成り立つ。つまり best は「サーバが認めた earned」に縛られる。
     ①でレートの頭を押さえた結果が、そのままランキングの数字を縛ることになる */
  const bestBound = WALLET_START + nextEarned;
  const nextBest = Math.max(prev.best_medals, Math.min(claim.best, bestBound));

  /* --- ③ ジャックポット ---
     払い出しはホッパーを通るので jp_paid は earned を超えられない */
  const nextJpWins = Math.max(prev.jp_wins, Math.min(claim.jpWins, SANITY_MAX));
  const nextJpPaid = Math.max(
    prev.jp_paid,
    Math.min(claim.jpPaid, nextJpWins * JP_MAX, nextEarned)
  );

  /* --- ④ サーバ実測の時間。ここだけは申告できない --- */
  const today = dayOf(now);
  const newDay = today !== prev.last_sync_day;

  /* --- ⑤ 印 ---
     **クランプに当たったことを印の条件にしない。** 実測すると、
     オフラインで遊んでから初回同期した正直なプレイヤーにも当たり前に立つ。
     (カウンタは1分ほど遊べば追いつくので、クランプ側は困らない。)
     印は「そのアカウントの一生ぶんを積んでも届かない」ときだけ立てる。
     連続したときだけ数えるのは、端数や往復の遅れを拾わないため */
  const absurd = claimedEarned > absurdThreshold(now, createdAt)
    || claim.best > absurdThreshold(now, createdAt) + WALLET_START;
  const strikes = absurd ? prev.strikes + 1 : Math.max(0, prev.strikes - 1);

  return {
    clamped,
    next: {
      best_medals: nextBest,
      lifetime_earned: nextEarned,
      jp_wins: nextJpWins,
      jp_paid: nextJpPaid,
      play_ms: prev.play_ms + dt,
      sync_days: prev.sync_days + (newDay ? 1 : 0),
      last_sync_day: today,
      bucket: bucketOf(nextBest),
      // 一度立った印は消さない (消したければ「記録を消す」が使える)
      strikes,
      flagged: prev.flagged === 1 || strikes >= STRIKES_TO_FLAG ? 1 : 0,
    },
  };
}

/**
 * ランキングの母集団に入れてよいか (§8.5)
 *
 * play_ms も sync_days もサーバの時計でしか進まないので、
 * 1万アカウントを資格まで育てるには1万アカウントぶんの実時間が要る。
 * パーセンタイルの分母を守っているのはこの関数。
 */
export function isEligible(s: ScoreState): boolean {
  return s.flagged === 0
    && s.play_ms >= ELIGIBLE_PLAY_MS
    && s.sync_days >= ELIGIBLE_DAYS;
}
