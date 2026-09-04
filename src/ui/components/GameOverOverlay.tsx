import { useState } from 'react';
import { gameStore, useStore } from '../store';
import styles from './GameOverOverlay.module.css';

type Props = {
  onRestart: () => void;
  onClearData: () => void;
};

/**
 * 持ち枚数が尽きたときの表示。
 * フィールドのメダルはそのまま残す（筐体の在庫であってプレイヤーの物ではない）ので、
 * リスタートしても山は崩れず、続きから遊べる。
 *
 * 「記録を消す」はここに置いている。設定画面を新設するより安く、
 * 記録をリセットしたくなるのはたいていゲームオーバーの直後なので（DESIGN.md §11.8）。
 */
export function GameOverOverlay({ onRestart, onClearData }: Props) {
  const { gameOver, best, inserted, earned, lost, saveError } = useStore(gameStore);
  const [confirming, setConfirming] = useState(false);

  if (!gameOver) return null;

  const clear = () => {
    setConfirming(false);
    onClearData();
  };

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

        {confirming ? (
          <>
            <div className={styles.warn}>
              通算の記録と最高記録がすべて消えます。元に戻せません。
            </div>
            <div className={styles.buttons}>
              <button className={styles.danger} onClick={clear}>消す</button>
              <button className={styles.ghost} onClick={() => setConfirming(false)}>やめる</button>
            </div>
          </>
        ) : (
          <>
            <button className={styles.button} onClick={onRestart} autoFocus>
              もう一度
            </button>
            <div className={styles.note}>フィールドのメダルはそのまま残ります</div>
            <button className={styles.link} onClick={() => setConfirming(true)}>
              記録を消す
            </button>
            {saveError && (
              <div className={styles.warn}>
                このブラウザでは記録を保存できていません
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
