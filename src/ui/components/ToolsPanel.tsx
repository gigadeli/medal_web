import { gameStore, useStore } from '../store';
import styles from './ToolsPanel.module.css';

type Props = {
  onSelectSpecial: (kind: string) => void;
  onBump: () => void;
};

/** 3種の特殊メダル (DESIGN_GIMMICKS.md §3.7)。並びは 1 / 2 / 3 キーに対応する */
const SPECIALS = [
  { kind: 'gold', key: '1', glyph: '◉', name: 'ゴールド', hint: '+5枚' },
  { kind: 'bomb', key: '2', glyph: '✸', name: 'ボム', hint: '山を崩す' },
  { kind: 'ticket', key: '3', glyph: '✦', name: 'チケット', hint: 'スロット' },
] as const;

/**
 * 手持ちの特殊メダルと台パンの状態。
 *
 * 液晶 (SlotDisplay) は JP・STEP・倍率を出しているので、
 * ここが受け持つのは「プレイヤーがいま切れる手札」だけにしてある。
 */
export function ToolsPanel({ onSelectSpecial, onBump }: Props) {
  const { gold, bomb, ticket, selected, bumpCooldown, tilt } = useStore(gameStore);
  const stock: Record<string, number> = { gold, bomb, ticket };

  const bumpLabel = tilt > 0 ? `TILT ${Math.ceil(tilt)}`
    : bumpCooldown > 0 ? `${Math.ceil(bumpCooldown)}`
    : '台パン';

  return (
    <div className={`panel ${styles.panel}`}>
      <div className={styles.label}>ITEM</div>
      <div className={styles.row}>
        {SPECIALS.map((s) => {
          const n = stock[s.kind] ?? 0;
          return (
            <button
              key={s.kind}
              type="button"
              className={[
                styles.slot,
                n > 0 ? styles.has : '',
                selected === s.kind ? styles.on : '',
              ].join(' ')}
              onClick={() => onSelectSpecial(s.kind)}
              disabled={n <= 0}
              title={`${s.name} — ${s.hint}`}
            >
              <span className={styles.key}>{s.key}</span>
              <span className={`${styles.glyph} ${styles[s.kind]}`}>{s.glyph}</span>
              <span className={styles.count}>{n}</span>
            </button>
          );
        })}

        <button
          type="button"
          className={[
            styles.bump,
            tilt > 0 ? styles.tilt : '',
            bumpCooldown <= 0 && tilt <= 0 ? styles.has : '',
          ].join(' ')}
          onClick={onBump}
          title="場のメダルを揺さぶる。連打すると TILT になる"
        >
          <span className={styles.key}>B</span>
          <span className={styles.bumpLabel}>{bumpLabel}</span>
        </button>
      </div>
    </div>
  );
}
