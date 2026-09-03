import { gameStore, useStore } from '../store';
import styles from './GameOverOverlay.module.css';

type Props = { onRestart: () => void };

/**
 * 持ち枚数が尽きたときの表示。
 * フィールドのメダルはそのまま残す（筐体の在庫であってプレイヤーの物ではない）ので、
 * リスタートしても山は崩れず、続きから遊べる。
 */
export function GameOverOverlay({ onRestart }: Props) {
  const { gameOver, best, inserted, earned, lost } = useStore(gameStore);
  if (!gameOver) return null;

  return (
    <div className={styles.root}>
      <div className={styles.card}>
        <div className={styles.title}>GAME OVER</div>
        <div className={styles.rows}>
          <span>最高持ち枚数</span><b className={styles.hi}>{best}</b>
          <span>投入</span><b>{inserted}</b>
          <span>獲得</span><b>{earned}</b>
          <span>ロスト</span><b>{lost}</b>
        </div>
        <button className={styles.button} onClick={onRestart} autoFocus>
          もう一度
        </button>
        <div className={styles.note}>フィールドのメダルはそのまま残ります</div>
      </div>
    </div>
  );
}
