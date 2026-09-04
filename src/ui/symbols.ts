import { CFG } from '../config.js';
import { artOf as rawArtOf } from '../render/SymbolArt.js';

export type SlotSymbol = {
  id: string;
  name: string;
  color: string;
  weight: number;
  /** 1ライン揃ったときの枚数。実際の払い出しは pay x ライン数 x 倍率 */
  pay: number;
  /** 役の格。ライン数抽選と演出の期待度が両方これを見る */
  tier: 'miss' | 'small' | 'mid' | 'big' | 'jp';
  /** 枚数ではなくジャックポット当選になる役 (DESIGN_GIMMICKS.md §3.4) */
  jp?: boolean;
};

/** SVG のパーツ。塗り / 線 / 文字 のいずれか */
export type ArtPart = {
  d?: string;
  fill?: string;
  stroke?: string;
  width?: number;
  cap?: 'round' | 'butt' | 'square';
  text?: string;
  size?: number;
};

/**
 * 絵柄の定義。config から取り出して型を付けるのはここ1箇所だけにする。
 *
 * 絵そのものは render/SymbolArt.js に SVG のパスで置いてあり、
 * 液晶パネル (Canvas 2D) と HUD の配当表 (React の <svg>) が同じデータを読む。
 * どちらか片方だけ直して見た目がずれる、ということが起きない。
 */
export const SYMBOLS = CFG.slot.symbols as unknown as SlotSymbol[];

export const artOf = rawArtOf as unknown as (id: string) => ArtPart[];

/** ペイライン。1本を「列ごとに、どの段を見るか」で書く (DESIGN_GIMMICKS.md §3.10) */
export const LINES = CFG.slot.lines as unknown as number[][];
