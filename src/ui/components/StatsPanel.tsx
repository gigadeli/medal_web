import { statsStore, useStore } from '../store';
import styles from './StatsPanel.module.css';

/**
 * FPS などの計測値。
 * これらは毎フレーム変わるので、ゲーム側で数Hzに間引いてから store に入れている
 * (main.js の STATS_INTERVAL を参照)。
 */
export function StatsPanel() {
  const { fps, onField, stepMs } = useStore(statsStore);

  return (
    <div className={`panel ${styles.panel}`}>
      <div>FPS <b className={styles.value}>{fps}</b></div>
      <div>FIELD <b className={styles.value}>{onField}</b></div>
      <div>STEP <b className={styles.value}>{stepMs.toFixed(1)}</b> ms</div>
    </div>
  );
}
