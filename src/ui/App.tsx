import { WalletPanel } from './components/WalletPanel';
import { PayTablePanel } from './components/PayTablePanel';
import { StatsPanel } from './components/StatsPanel';
import { SlotPanel } from './components/SlotPanel';
import { ControlsBar } from './components/ControlsBar';
import { GameOverOverlay } from './components/GameOverOverlay';
import { LoadingOverlay } from './components/LoadingOverlay';

type Props = {
  error?: string | null;
  onRestart?: () => void;
};

/**
 * UI レイヤの組み立て。
 * 各コンポーネントは必要なストアだけを購読するので、
 * 例えば持ち枚数が増えても FPS 表示は再レンダリングされない。
 */
export function App({ error, onRestart }: Props) {
  return (
    <>
      <WalletPanel />
      <PayTablePanel />
      <StatsPanel />
      <SlotPanel />
      <ControlsBar />
      <GameOverOverlay onRestart={onRestart ?? (() => {})} />
      <LoadingOverlay error={error} />
    </>
  );
}
