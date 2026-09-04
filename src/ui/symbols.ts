import { CFG } from '../config.js';

export type SlotSymbol = {
  id: string;
  name: string;
  glyph: string;
  color: string;
  weight: number;
  pay: number;
};

/**
 * 絵柄の定義。config から取り出して型を付けるのはここ1箇所だけにする。
 * 演出そのものは 3D 側 (game/SlotDisplay.js) が描くので、
 * UI が使うのは配当表の表示だけ。
 */
export const SYMBOLS = CFG.slot.symbols as unknown as SlotSymbol[];
