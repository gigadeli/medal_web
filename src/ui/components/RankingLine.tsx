import { useEffect, useState } from 'react';
import type { Ranking } from '../store';
import styles from './RankingLine.module.css';

type Props = {
  /** 未接続なら渡さない。その場合このコンポーネントは何も描かない */
  onFetch?: () => Promise<Ranking | null>;
};

const fmtMinutes = (ms: number) => Math.ceil(ms / 60000);

/**
 * 「上位 N%」の1行 (DESIGN_SERVER.md §8.5)
 *
 * 名前も順位も出さない。理由は初稿の「名前が要らないから安全」ではなく、
 * **パーセンタイルは分母が攻撃対象**だから (§15-1)。
 * 成立させているのはサーバ側の参加資格で、この画面はその結果を出すだけ。
 *
 * そして `unverified` は必ず表示する。数字は検証できていない
 * (DESIGN_SECURITY.md §5 案3)。書かないという選択肢は無い。
 */
export function RankingLine({ onFetch }: Props) {
  const [state, setState] = useState<Ranking | null | 'loading'>('loading');

  useEffect(() => {
    if (!onFetch) { setState(null); return; }
    let alive = true;
    const done = (v: Ranking | null) => { if (alive) setState(v); };
    onFetch().then(done, () => done(null));
    return () => { alive = false; };
  }, [onFetch]);

  // 通信中と未接続は何も出さない。ゲームオーバー画面に空欄が増えるだけなので
  if (state === 'loading' || state === null) return null;

  if (state.status === 'ineligible') {
    const parts: string[] = [];
    if (state.needPlayMs > 0) parts.push(`あと ${fmtMinutes(state.needPlayMs)} 分`);
    if (state.needDays > 0) parts.push(`あと ${state.needDays} 日`);
    return (
      <div className={styles.root}>
        <span className={styles.dim}>ランキング参加まで {parts.join(' / ')}</span>
      </div>
    );
  }

  if (state.status === 'building') {
    return (
      <div className={styles.root}>
        <span className={styles.dim}>ランキング集計中（{state.population} 人）</span>
      </div>
    );
  }

  return (
    <div className={styles.root}>
      <div className={styles.rank}>
        上位 <b>{state.topPercent}</b>%
        <span className={styles.dim}> / {state.population} 人</span>
      </div>
      {state.unverified && (
        <div className={styles.disclaimer}>
          この数字は自己申告で、サーバでは検証していません
        </div>
      )}
    </div>
  );
}
