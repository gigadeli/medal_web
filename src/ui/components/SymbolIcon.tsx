import { artOf } from '../symbols';

/**
 * 絵柄を1つ描く <svg>。
 *
 * 液晶パネル側 (game/SlotDisplay.js) は同じパスを Path2D にして Canvas に描く。
 * データが1箇所なので、HUD と液晶で絵が食い違うことがない。
 *
 * 色は CSS の color で渡し、パス側は currentColor を見る。
 * 絵柄色に染めたくないパーツ (チェリーの葉、スイカの縞) だけは
 * SymbolArt.js が直接色を持っている。
 */
export function SymbolIcon({ id, color, size = 22 }: {
  id: string;
  color: string;
  size?: number;
}) {
  return (
    <svg
      viewBox="0 0 100 100"
      width={size}
      height={size}
      style={{ color, display: 'block' }}
      aria-hidden="true"
      focusable="false"
    >
      {artOf(id).map((p, i) => {
        if (p.text) {
          return (
            <text
              key={i}
              x="50"
              y="52"
              textAnchor="middle"
              dominantBaseline="central"
              fontSize={p.size}
              fontWeight={800}
              letterSpacing="2"
              fill={p.fill}
            >
              {p.text}
            </text>
          );
        }
        if (p.stroke) {
          return (
            <path
              key={i}
              d={p.d}
              fill="none"
              stroke={p.stroke}
              strokeWidth={p.width}
              strokeLinecap={p.cap ?? 'butt'}
              strokeLinejoin="round"
            />
          );
        }
        return <path key={i} d={p.d} fill={p.fill} />;
      })}
    </svg>
  );
}
