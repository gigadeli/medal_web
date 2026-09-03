import { gameStore, useStore } from '../store';
import styles from './ControlsBar.module.css';

const KEYS: Array<[string[], string]> = [
  [['マウス移動', '←', '→'], '投入位置'],
  [['クリック', 'Space'], '投入（長押しで連続）'],
  [['右ドラッグ'], '視点'],
  [['M'], '消音'],
  [['D'], 'デバッグ'],
];

export function ControlsBar() {
  const { muted } = useStore(gameStore);

  return (
    <>
      <div className={`panel ${styles.help}`}>
        {KEYS.map(([keys, label], i) => (
          <span key={label}>
            {i > 0 && <span className={styles.sep}>·</span>}
            {keys.map((k, j) => (
              <span key={k}>
                {j > 0 && ' / '}
                <kbd>{k}</kbd>
              </span>
            ))}{' '}
            {label}
          </span>
        ))}
      </div>

      <div className={`panel ${styles.mute} ${muted ? styles.muted : ''}`}>
        {muted ? 'SOUND OFF' : 'SOUND ON'}
      </div>
    </>
  );
}
