import { gameStore, useStore } from '../store';
import { SYMBOLS } from '../symbols';
import styles from './PayTablePanel.module.css';

/** ブランク(pay 0)は配当表に出さない。青7は枚数を持たないが JP 役なので出す */
const PAYING = SYMBOLS.map((s, i) => ({ ...s, index: i })).filter((s) => s.pay > 0 || s.jp);

/**
 * 配当表と抽選の保留ランプ。
 * 直近に揃った絵柄を光らせるので、何が当たったのか一目で分かる。
 *
 * 配当は倍率が掛かった後の値を出す (DESIGN_GIMMICKS.md §3.2)。
 * 溜めた倍率がいくらの得になるのかが、表を見た瞬間に分かるようにするため。
 */
export function PayTablePanel() {
  const { hold, holdMax, odds, lastWinIndex, lastWinSeq } = useStore(gameStore);

  return (
    <div className={`panel ${styles.panel}`}>
      <div className={styles.label}>
        PAY TABLE
        {odds > 1 && <b className={styles.odds}>×{odds}</b>}
      </div>
      <div className={styles.rows}>
        {PAYING.map((s) => {
          const hit = s.index === lastWinIndex;
          return (
            <div
              // 当たるたびに key を変えて、同じ絵柄が続いてもアニメを打ち直す
              key={hit ? `${s.id}-${lastWinSeq}` : s.id}
              className={`${styles.cell} ${hit ? styles.hit : ''}`}
              title={s.name}
            >
              <span
                className={`${styles.glyph} ${s.glyph.length > 1 ? styles.bar : ''}`}
                style={{ color: s.color }}
              >
                {s.glyph}
              </span>
              <span className={`${styles.pay} ${s.jp ? styles.jp : ''}`}>
                {s.jp ? 'JP' : s.pay * odds}
              </span>
            </div>
          );
        })}
      </div>
      <div className={styles.hold}>
        {Array.from({ length: holdMax }, (_, i) => (
          <i key={i} className={`${styles.lamp} ${i < hold ? styles.lit : ''}`} />
        ))}
      </div>
    </div>
  );
}
