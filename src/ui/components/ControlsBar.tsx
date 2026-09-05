import { gameStore, useStore } from '../store';
import { IS_MOBILE } from '../../core/Device.js';
import styles from './ControlsBar.module.css';

type Props = {
  onToggleMute: () => void;
};

const KEYS: Array<[string[], string]> = [
  [['クリック', 'Space'], '発射（狙いは自動で首振り・長押しで連続）'],
  [['B'], '台パン'],
  [['1', '2', '3'], '特殊メダル'],
  [['右ドラッグ'], '視点'],
  [['M'], '消音'],
  [['D'], 'デバッグ'],
];

/**
 * モバイルはキーボードが無いぶん、説明することが少ない。
 * 台パンと特殊メダルは ITEM パネルのボタンで押せるので、ここには出さない。
 */
const TOUCH_KEYS: Array<[string[], string]> = [
  [['タップ'], '発射'],
  [['2本指'], '視点'],
];

export function ControlsBar({ onToggleMute }: Props) {
  const { muted } = useStore(gameStore);
  const keys = IS_MOBILE ? TOUCH_KEYS : KEYS;

  return (
    <>
      <div className={`panel ${styles.help} ${IS_MOBILE ? styles.compact : ''}`}>
        {keys.map(([ks, label], i) => (
          <span key={label}>
            {i > 0 && <span className={styles.sep}>·</span>}
            {ks.map((k, j) => (
              <span key={k}>
                {j > 0 && ' / '}
                <kbd>{k}</kbd>
              </span>
            ))}{' '}
            {label}
          </span>
        ))}
      </div>

      {/*
        消音は M キーに割り当ててあるが、キーボードの無い端末では押しようがない。
        表示だけだったこの札をボタンにして、どちらの端末からも切れるようにする。
      */}
      <button
        type="button"
        className={`panel ${styles.mute} ${muted ? styles.muted : ''}`}
        onClick={onToggleMute}
        title="消音の切り替え（M）"
      >
        {muted ? 'SOUND OFF' : 'SOUND ON'}
      </button>
    </>
  );
}
