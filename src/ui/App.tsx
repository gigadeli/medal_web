import { WalletPanel } from './components/WalletPanel';
import { PayTablePanel } from './components/PayTablePanel';
import { StatsPanel } from './components/StatsPanel';
import { ControlsBar } from './components/ControlsBar';
import { ToolsPanel } from './components/ToolsPanel';
import { GameOverOverlay } from './components/GameOverOverlay';
import { LoadingOverlay } from './components/LoadingOverlay';

type Props = {
  error?: string | null;
  onRestart?: () => void;
  onClearData?: () => void;
  onSelectSpecial?: (kind: string) => void;
  onBump?: () => void;
};

const noop = () => {};

/**
 * UI レイヤの組み立て。
 * 各コンポーネントは必要なストアだけを購読するので、
 * 例えば持ち枚数が増えても FPS 表示は再レンダリングされない。
 *
 * JP・STEP・倍率は筐体の液晶 (game/SlotDisplay.js) が受け持つ。
 * HUD に出すのは「プレイヤーの持ち物」だけにして、盤面の上を空けておく。
 */
export function App({ error, onRestart, onClearData, onSelectSpecial, onBump }: Props) {
  return (
    <>
      <WalletPanel />
      <PayTablePanel />
      <StatsPanel />
      <ToolsPanel onSelectSpecial={onSelectSpecial ?? noop} onBump={onBump ?? noop} />
      <ControlsBar />
      <GameOverOverlay
        onRestart={onRestart ?? noop}
        onClearData={onClearData ?? noop}
      />
      <LoadingOverlay error={error} />
    </>
  );
}
