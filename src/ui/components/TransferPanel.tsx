import { useState } from 'react';
import type { TransferCode } from '../store';
import styles from './TransferPanel.module.css';

type Props = {
  onIssue?: () => Promise<TransferCode | null>;
  onRedeem?: (code: string) => Promise<boolean>;
};

type Mode = 'closed' | 'issued' | 'entering';

/**
 * 端末間の引き継ぎ (DESIGN_SERVER.md §5.3)
 *
 * ログイン画面を作らない代わりの導線。10分・1回限りの使い捨てコードで移す。
 *
 * ■ 表示について
 *   コードは「秘密」なので、画面に出しっぱなしにしない。
 *   出したら1回だけ表示して、閉じたら二度と見せない (再発行はできる)。
 *
 * ■ 使ったあと
 *   `onRedeem` が true を返すとページが読み直される。ローカルは
 *   **マージせず置き換える**ので (§15-4)、そのまま続けるより読み直すほうが確実。
 */
export function TransferPanel({ onIssue, onRedeem }: Props) {
  const [mode, setMode] = useState<Mode>('closed');
  const [code, setCode] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!onIssue || !onRedeem) return null;

  const issue = async () => {
    setBusy(true);
    setError(null);
    const r = await onIssue();
    setBusy(false);
    if (!r) { setError('コードを発行できませんでした'); return; }
    setCode(r.code);
    setMode('issued');
  };

  const redeem = async () => {
    if (input.trim().length === 0) return;
    setBusy(true);
    setError(null);
    const ok = await onRedeem(input.trim());
    setBusy(false);
    // 成功するとページが読み直されるので、ここに戻ってくるのは失敗のときだけ。
    // 失効・使用済み・不一致はサーバ側で区別されない (総当たり対策)
    if (!ok) setError('使えないコードです（期限切れ・使用済み・入力ミス）');
  };

  if (mode === 'issued' && code) {
    return (
      <div className={styles.root}>
        <div className={styles.label}>引き継ぎコード（10分・1回限り）</div>
        <div className={styles.code}>{code}</div>
        <div className={styles.note}>
          もう一方の端末で入力してください。この画面を閉じると二度と表示されません
        </div>
        <button className={styles.ghost} onClick={() => { setCode(null); setMode('closed'); }}>
          閉じる
        </button>
      </div>
    );
  }

  if (mode === 'entering') {
    return (
      <div className={styles.root}>
        <div className={styles.label}>引き継ぎコードを入力</div>
        <input
          className={styles.input}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="XXXX-XXXX"
          maxLength={16}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
        />
        {error && <div className={styles.error}>{error}</div>}
        <div className={styles.buttons}>
          <button className={styles.ghost} disabled={busy} onClick={redeem}>
            {busy ? '確認中…' : '引き継ぐ'}
          </button>
          <button className={styles.ghost} onClick={() => { setMode('closed'); setError(null); }}>
            やめる
          </button>
        </div>
        <div className={styles.note}>
          いまこの端末にある記録は、引き継いだ記録で置き換わります
        </div>
      </div>
    );
  }

  return (
    <div className={styles.links}>
      <button className={styles.link} disabled={busy} onClick={issue}>
        {busy ? '発行中…' : '別の端末へ引き継ぐ'}
      </button>
      <button className={styles.link} onClick={() => setMode('entering')}>
        コードで引き継ぐ
      </button>
      {error && <div className={styles.error}>{error}</div>}
    </div>
  );
}
