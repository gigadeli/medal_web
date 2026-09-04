import { useSyncExternalStore } from 'react';

/**
 * ゲームループ (60Hz) と React をつなぐ最小限の外部ストア。
 *
 * 毎フレーム setState すると React が 60fps で再レンダリングして描画を圧迫する。
 * ここでは書き込み時に浅い比較をして、**値が実際に変わったときだけ**
 * スナップショットを差し替えて通知する。変化がなければ参照は同一のままなので
 * useSyncExternalStore は再レンダリングしない。
 *
 * さらに、毎フレーム変わってしまう値 (FPS やステップ時間) は
 * 呼び出し側で数Hzに間引いてから set する (main.js を参照)。
 */
export class Store<T extends object> {
  private state: T;
  private listeners = new Set<() => void>();

  constructor(initial: T) {
    this.state = initial;
  }

  /** useSyncExternalStore に渡すため、必ず同一参照を返す */
  get = (): T => this.state;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  set(patch: Partial<T>): void {
    let changed = false;
    for (const key in patch) {
      if (!Object.is(this.state[key], patch[key])) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }
}

export function useStore<T extends object>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

/* ------------------------------------------------------------------ */

export type GameState = {
  /** プレイヤーの持ち枚数 */
  medals: number;
  best: number;
  inserted: number;
  earned: number;
  lost: number;
  gameOver: boolean;
  /** localStorage に書けていない (プライベートモード / 容量超過) */
  saveError: boolean;
  hold: number;
  holdMax: number;
  muted: boolean;
  loading: boolean;
  /** 獲得ポップの再生トリガ。値が変わるたびにアニメを打ち直す */
  gainSeq: number;
  gainAmount: number;
  /** 直近に揃った絵柄。配当表のハイライトに使う (-1 でなし) */
  lastWinIndex: number;
  lastWinSeq: number;
};

export type StatsState = {
  fps: number;
  /** フィールド上のメダル数 (持ち枚数とは別物) */
  onField: number;
  stepMs: number;
};

export const gameStore = new Store<GameState>({
  medals: 0,
  best: 0,
  inserted: 0,
  earned: 0,
  lost: 0,
  gameOver: false,
  saveError: false,
  hold: 0,
  holdMax: 3,
  muted: false,
  loading: true,
  gainSeq: 0,
  gainAmount: 1,
  lastWinIndex: -1,
  lastWinSeq: 0,
});

export const statsStore = new Store<StatsState>({
  fps: 0,
  onField: 0,
  stepMs: 0,
});
