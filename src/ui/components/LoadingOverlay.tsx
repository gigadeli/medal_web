import { useEffect, useState } from 'react';
import { gameStore, useStore } from '../store';
import styles from './LoadingOverlay.module.css';

type Props = { error?: string | null };

/**
 * Rapier の WASM 読み込み待ち。
 *
 * 消えるときのフェードは keyframes で行い、終了は setTimeout でアンマウントする。
 * transition に頼ると、重いフレームで遷移が進まず画面を覆ったままになりうる。
 */
export function LoadingOverlay({ error }: Props) {
  const { loading } = useStore(gameStore);
  const [mounted, setMounted] = useState(true);

  useEffect(() => {
    if (loading || error) return;
    const id = setTimeout(() => setMounted(false), 500);
    return () => clearTimeout(id);
  }, [loading, error]);

  if (!mounted) return null;

  const leaving = !loading && !error;

  return (
    <div className={`${styles.root} ${leaving ? styles.leaving : ''}`}>
      <div className={styles.title}>MEDAL PUSHER</div>
      {!error && (
        <div className={styles.bar}>
          <i />
        </div>
      )}
      <div className={`${styles.note} ${error ? styles.error : ''}`}>
        {error ? `起動に失敗しました: ${error}` : '物理エンジンを読み込んでいます…'}
      </div>
    </div>
  );
}
