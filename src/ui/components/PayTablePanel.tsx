import { gameStore, useStore } from '../store';
import { LINES, SYMBOLS } from '../symbols';
import { SymbolIcon } from './SymbolIcon';
import styles from './PayTablePanel.module.css';

/** ブランク(pay 0)は配当表に出さない。青7は枚数を持たないが JP 役なので出す */
const PAYING = SYMBOLS.map((s, i) => ({ ...s, index: i })).filter((s) => s.pay > 0 || s.jp);

/** 有効ラインの早見図。3x3 の点を5本の線で結ぶ (DESIGN_GIMMICKS.md §3.10) */
function LineMap() {
  const at = (i: number) => 8 + i * 17;
  return (
    <svg viewBox="0 0 50 50" aria-hidden="true" focusable="false">
      {[0, 1, 2].map((r) =>
        [0, 1, 2].map((c) => (
          <circle key={`${r}-${c}`} cx={at(c)} cy={at(r)} r="3" fill="rgba(140,165,210,.28)" />
        ))
      )}
      {LINES.map((L, i) => (
        <polyline
          key={i}
          points={L.map((r, c) => `${at(c)},${at(r)}`).join(' ')}
          fill="none"
          stroke="var(--cyan)"
          strokeWidth="1.6"
          strokeOpacity=".65"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
    </svg>
  );
}

/**
 * 配当表と抽選の保留ランプ。
 * 直近に揃った絵柄を光らせるので、何が当たったのか一目で分かる。
 *
 * 盤面が 3x3 になり、5本のラインを同時に見るようになった。
 * 表に出す枚数は **1ラインあたり** で、実際の払い出しは
 * これに揃ったライン数が掛かる。倍率は掛けた後の値を出す (§3.2)。
 */
export function PayTablePanel() {
  const { hold, holdMax, odds, lastWinIndex, lastWinSeq } = useStore(gameStore);

  return (
    <div className={`panel ${styles.panel}`}>
      <div className={styles.label}>
        PAY TABLE
        <b className={styles.perLine}>1 LINE あたり</b>
        {odds > 1 && <b className={styles.odds}>×{odds}</b>}
      </div>
      <div className={styles.lineMap} title={`有効ライン ${LINES.length}本`}>
        <LineMap />
        <span className={styles.lineCount}>{LINES.length} LINES</span>
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
              <SymbolIcon id={s.id} color={s.color} />
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
