import { gameStore, useStore } from '../store';
import styles from './WalletPanel.module.css';

/** プレイヤーの持ち枚数と通算成績 */
export function WalletPanel() {
  const { medals, best, inserted, earned, lost, gainSeq, gainAmount } = useStore(gameStore);

  return (
    <>
      <div className={`panel ${styles.panel}`}>
        <div className={styles.label}>MEDALS</div>
        <div className={`${styles.value} ${medals <= 20 ? styles.low : ''}`}>{medals}</div>
        <div className={styles.best}>BEST {best}</div>
        <div className={styles.rows}>
          <span>投入</span><b>{inserted}</b>
          <span>獲得</span><b>{earned}</b>
          <span>ロスト</span><b>{lost}</b>
        </div>
      </div>

      {/*
        獲得ポップ。key に連番を渡して要素ごと作り直すことで、
        連続で獲得してもアニメーションが必ず頭から再生される。
      */}
      {gainSeq > 0 && (
        <div key={gainSeq} className={styles.gain}>
          +{gainAmount}
        </div>
      )}
    </>
  );
}
