import { CFG } from '../config.js';
import { gameStore, slotStore } from './store';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export type Symbol = {
  id: string;
  name: string;
  glyph: string;
  color: string;
  weight: number;
  pay: number;
};

/** 絵柄の定義。config から取り出して型を付けるのはここ1箇所だけにする */
export const SYMBOLS = CFG.slot.symbols as unknown as Symbol[];

export type DrawResult = {
  index: number;
  symbol: Symbol;
  amount: number;
  win: boolean;
};

/** SlotController が鳴らす音。Sound クラスの一部だけを要求する */
export type SlotSound = {
  reelStop(): void;
  reach(): void;
  lose(): void;
  win(level?: number): void;
  jackpot(): void;
};

type Figures = {
  symbols: [number, number, number];
  reach: boolean;
};

/**
 * 抽選演出の進行役。
 *
 * 見た目は React コンポーネント (components/SlotPanel.tsx) が担当し、
 * ここは「いつ何を表示するか」だけをストアに書き込む。
 * SlotMachine 側からは play() を await するだけで、React であることを意識しなくてよい。
 *
 * 結果は先に決まっていて、リールはその出目に「止めに行く」。
 * 参考記事と同じく目押しは無い。
 */
export class SlotController {
  private sound: SlotSound;

  constructor(sound: SlotSound) {
    this.sound = sound;
  }

  /** 出目を決める。アタリならゾロ目、ハズレは3つとも別の絵柄にする */
  private figures(res: DrawResult): Figures {
    if (res.win) {
      return { symbols: [res.index, res.index, res.index], reach: true };
    }
    const n = SYMBOLS.length;
    const pick = () => (Math.random() * n) | 0;

    const a = pick();
    if (Math.random() < 0.45) {
      // リーチだけかけて外す
      let c = pick();
      while (c === a) c = pick();
      return { symbols: [a, a, c], reach: true };
    }
    let b = pick();
    while (b === a) b = pick();
    let c = pick();
    while (c === a || c === b) c = pick();
    return { symbols: [a, b, c], reach: false };
  }

  private stopReel(index: number, symbol: number): void {
    const s = slotStore.get();
    const symbols = [...s.symbols] as [number, number, number];
    const spinning = [...s.spinning] as [boolean, boolean, boolean];
    symbols[index] = symbol;
    spinning[index] = false;
    slotStore.set({ symbols, spinning });
    this.sound.reelStop();
  }

  async play(res: DrawResult): Promise<void> {
    const { symbols, reach } = this.figures(res);

    slotStore.set({
      visible: true,
      label: 'CHANCE',
      symbols: [0, 0, 0],
      spinning: [true, true, true],
      reach: false,
      result: '',
      tone: 'idle',
    });

    await sleep(600);
    this.stopReel(0, symbols[0]);
    await sleep(450);
    this.stopReel(1, symbols[1]);

    if (reach) {
      slotStore.set({ reach: true });
      this.sound.reach();
      await sleep(1200);
    } else {
      await sleep(450);
    }
    this.stopReel(2, symbols[2]);

    if (res.win) {
      const big = res.amount >= 40;
      slotStore.set({
        tone: big ? 'big' : 'win',
        result: `${res.symbol.name}  +${res.amount}`,
      });
      gameStore.set({
        lastWinIndex: res.index,
        lastWinSeq: gameStore.get().lastWinSeq + 1,
      });
      if (res.amount >= 80) this.sound.jackpot();
      else this.sound.win(res.amount >= 40 ? 2 : res.amount >= 10 ? 1 : 0);
      await sleep(big ? 2400 : 1400);
    } else {
      slotStore.set({ tone: 'miss', result: 'MISS' });
      this.sound.lose();
      await sleep(650);
    }

    slotStore.set({ visible: false, reach: false, tone: 'idle' });
    await sleep(250);
  }
}
