import { useEffect, useState } from 'react';
import { slotStore, useStore } from '../store';
import { SYMBOLS } from '../SlotController';
import styles from './SlotPanel.module.css';

type ReelProps = {
  index: number;
  spinning: boolean;
  reaching: boolean;
};

/**
 * リール1つ。
 * 回転中の絵柄の差し替えはコンポーネントの中で完結させる。
 * ストアに毎回書くと 18Hz でアプリ全体が再レンダリングされてしまうため。
 */
function Reel({ index, spinning, reaching }: ReelProps) {
  const [face, setFace] = useState(index);

  useEffect(() => {
    if (!spinning) {
      setFace(index);
      return;
    }
    const id = setInterval(() => {
      setFace((Math.random() * SYMBOLS.length) | 0);
    }, 55);
    return () => clearInterval(id);
  }, [spinning, index]);

  const symbol = SYMBOLS[face]!;
  const cls = [
    styles.reel,
    spinning ? styles.spinning : '',
    reaching ? styles.reaching : '',
  ].join(' ');

  return (
    <div className={cls}>
      <span
        className={symbol.glyph.length > 1 ? styles.text : ''}
        style={{ color: symbol.color }}
      >
        {symbol.glyph}
      </span>
    </div>
  );
}

export function SlotPanel() {
  const { visible, label, symbols, spinning, reach, result, tone } = useStore(slotStore);
  if (!visible) return null;

  const cls = [
    styles.panel,
    tone === 'win' ? styles.win : '',
    tone === 'big' ? `${styles.win} ${styles.big}` : '',
  ].join(' ');

  return (
    <div className={cls}>
      <div className={styles.label}>{label}</div>
      <div className={styles.reels}>
        {symbols.map((s, i) => (
          <Reel
            key={i}
            index={s}
            spinning={spinning[i]!}
            reaching={reach && i === 2 && spinning[2]!}
          />
        ))}
      </div>
      <div className={styles.result}>{result}</div>
    </div>
  );
}
