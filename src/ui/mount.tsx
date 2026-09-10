import { StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { App } from './App';
import {
  gameStore, statsStore,
  type GameState, type Ranking, type StatsState, type TransferCode,
} from './store';
import './theme.css';

export type MountOptions = {
  /** ゲームオーバー画面の「もう一度」 */
  onRestart: () => void;
  /** ゲームオーバー画面の「記録を消す」 */
  onClearData: () => void;
  /** 消音の切り替え (キーボードの M と同じ操作)。キーの無い端末用 */
  onToggleMute?: () => void;

  /* ---- サーバ機能 (DESIGN_SERVER.md)。未接続なら渡さなくてよい ---- */
  /** パーセンタイルを引く (§8.5) */
  onFetchRanking?: () => Promise<Ranking | null>;
  /** 引き継ぎコードを発行する (§5.3) */
  onIssueTransferCode?: () => Promise<TransferCode | null>;
  /** 引き継ぎコードを使う。成功したらページが読み直される */
  onRedeemTransferCode?: (code: string) => Promise<boolean>;
};

export type UIHandle = {
  /** クレジットやジャックポットなど、変化が疎い値 */
  setGame(patch: Partial<GameState>): void;
  /** FPS など毎フレーム変わる値。呼び出し側で間引くこと */
  setStats(patch: Partial<StatsState>): void;
  /** 獲得ポップを1回打つ */
  popGain(amount?: number): void;
  /** 起動失敗を画面に出す */
  fail(message: string): void;
};

/**
 * React の UI をマウントして、ゲーム側から触るためのハンドルを返す。
 *
 * ゲームループは React を一切知らない。ストアに値を書くだけで、
 * 実際に変わった値を購読しているコンポーネントだけが再レンダリングされる。
 */
export function mountUI(container: HTMLElement, options: MountOptions): UIHandle {
  const root: Root = createRoot(container);
  const noop = () => {};
  const props = {
    onRestart: options.onRestart,
    onClearData: options.onClearData,
    onToggleMute: options.onToggleMute ?? noop,
    onFetchRanking: options.onFetchRanking,
    onIssueTransferCode: options.onIssueTransferCode,
    onRedeemTransferCode: options.onRedeemTransferCode,
  };
  root.render(
    <StrictMode>
      <App {...props} />
    </StrictMode>
  );

  let gainSeq = 0;

  return {
    setGame: (patch) => gameStore.set(patch),
    setStats: (patch) => statsStore.set(patch),
    popGain: (amount = 1) => {
      gainSeq += 1;
      gameStore.set({ gainSeq, gainAmount: amount });
    },
    fail: (message) => {
      root.render(
        <StrictMode>
          <App error={message} {...props} />
        </StrictMode>
      );
    },
  };
}
