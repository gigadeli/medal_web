import { CFG } from '../config.js';
import { rnd } from '../core/Rng.js';

const SYMBOLS = CFG.slot.symbols;
export const LINES = CFG.slot.lines;
const N_SYM = SYMBOLS.length;

/**
 * 3x3 の盤面とペイラインまわり。
 *
 * 盤面は cols[列][段] で持つ。リールが縦に回るので、列を1本の単位に
 * しておくと「1列ずつ止める」演出がそのまま書ける。
 *
 * ─────────────────────────────────────────────────────────────
 * 出目は「結果を決めてから作る」(DESIGN_GIMMICKS.md §3.10)
 *
 * 先に盤面を引いてから配当を数える作りにすると、期待値が weights から
 * 直接読めなくなる。1ライン時代に実測で追い込んだ払い戻しの根拠が消えるので、
 * 順番は今までと同じにしてある:
 *
 *   ① SlotMachine が絵柄とライン数を引く  (ここで払い出し枚数が確定する)
 *   ② buildGrid が「その結果になる盤面」を組み立てる
 *
 * ②は必ず①の通りの盤面を返す。狙っていないラインが偶然揃った場合は
 * 作り直すので、画面に出る当たりと払い出しは常に一致する。
 * ─────────────────────────────────────────────────────────────
 */

/** 役の格。ライン数抽選と演出の期待度が両方これを見る */
export function tierOf(res) {
  if (res.jp) return 'jp';
  if (!res.win) return 'miss';
  return res.symbol.tier || 'small';
}

function pickWeighted(weights) {
  let total = 0;
  for (const w of weights) total += w;
  let r = rnd() * total;
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i];
    if (r <= 0) return i;
  }
  return weights.length - 1;
}

/** 揃うライン数を引く。返り値は本数そのもの (1 / 2 / 3 / 5) */
export function pickLineCount(tier) {
  const w = CFG.slot.lineWeights[tier];
  if (!w) return 1;
  return [1, 2, 3, 5][pickWeighted(w)];
}

const randSym = () => (rnd() * N_SYM) | 0;

/** 揃っているライン番号を全部返す */
export function linesWon(cols) {
  const out = [];
  for (let i = 0; i < LINES.length; i++) {
    const L = LINES[i];
    const a = cols[0][L[0]];
    if (a === cols[1][L[1]] && a === cols[2][L[2]]) out.push(i);
  }
  return out;
}

/** 2列目まで止めた時点でリーチが掛かっているか */
function hasReach(cols) {
  for (const L of LINES) if (cols[0][L[0]] === cols[1][L[1]]) return true;
  return false;
}

/**
 * ラインを n 本ぶん選んだとき、実際には何本成立するか。
 *
 * 選んだラインのマスを絵柄で埋め、残りは別の絵柄にする作りなので、
 * 「選んでいないのに、マスが全部埋まってしまったライン」も一緒に成立する。
 * ここはその数を数えるだけの純粋な関数。
 */
function closureCount(set) {
  const covered = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const li of set) {
    const L = LINES[li];
    for (let c = 0; c < 3; c++) covered[c][L[c]] = 1;
  }
  let n = 0;
  for (const L of LINES) {
    if (covered[0][L[0]] && covered[1][L[1]] && covered[2][L[2]]) n++;
  }
  return n;
}

/**
 * ちょうど n 本になるラインの組み合わせを選ぶ。
 *
 * 選んだ本数どおりにならない組み合わせがあるので引き直している:
 *   横3本すべて  → 9マス全部が同じ絵柄になり、斜めも成立して 5本
 *   上段+下段+斜め → 四隅が埋まるので、もう1本の斜めも勝手に成立して 4本
 *
 * lineWeights が [1,2,3,5] しか持たないのは、この 4本 が
 * 「狙って作れる形」ではなく副産物でしか出てこないため。
 */
function pickLineSet(n) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const pool = [0, 1, 2, 3, 4];
    for (let i = pool.length - 1; i > 0; i--) {
      const j = (rnd() * (i + 1)) | 0;
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    const set = pool.slice(0, n).sort((a, b) => a - b);
    if (closureCount(set) === n) return set;
  }
  // ここには来ない (n=1,2,3 はいずれも成立する組み合わせが必ずある)
  return [1];
}

const emptyGrid = () => [[-1, -1, -1], [-1, -1, -1], [-1, -1, -1]];

/** 当たりの盤面。狙ったラインだけを S で埋め、残りは S 以外で埋める */
function buildWin(symbolIndex, count) {
  const wanted = count === 5 ? [0, 1, 2, 3, 4] : pickLineSet(count);

  for (let attempt = 0; attempt < 60; attempt++) {
    const cols = emptyGrid();
    for (const li of wanted) {
      const L = LINES[li];
      for (let c = 0; c < 3; c++) cols[c][L[c]] = symbolIndex;
    }
    // 空きマスは S 以外で埋める。ここに S が入ると狙っていないラインが揃う
    for (let c = 0; c < 3; c++) {
      for (let r = 0; r < 3; r++) {
        if (cols[c][r] >= 0) continue;
        let v = randSym();
        while (v === symbolIndex) v = randSym();
        cols[c][r] = v;
      }
    }
    // 空きマスだけで別の絵柄が揃ってしまうことがある (下段3マスが全部同じ等)
    const won = linesWon(cols);
    if (won.length === wanted.length) return { cols, winLines: won };
  }

  // 60回引いても収まらないときは中段1本だけの最小構成に落とす
  const cols = emptyGrid();
  for (let c = 0; c < 3; c++) {
    for (let r = 0; r < 3; r++) {
      if (r === 1) { cols[c][r] = symbolIndex; continue; }
      let v = randSym();
      while (v === symbolIndex) v = randSym();
      cols[c][r] = v;
    }
  }
  return { cols, winLines: linesWon(cols) };
}

/**
 * ハズレの盤面。
 *
 * reach を掛ける場合は「3列目が1コマ滑ってハズれた」形にする。
 * 滑る前の窓 (tease) と滑った後の窓は1コマずれた同じリール帯なので、
 *   tease  = [T0, T1, T2]
 *   滑った後 = [新しく降りてきた1枚, T0, T1]
 * になる。見た目のごまかしではなく、本当に1コマ動かしている。
 */
function buildMiss(wantReach) {
  if (wantReach) {
    for (let attempt = 0; attempt < 80; attempt++) {
      const symbolIndex = randSym();
      const L = LINES[(rnd() * LINES.length) | 0];

      const cols = emptyGrid();
      cols[0][L[0]] = symbolIndex;
      cols[1][L[1]] = symbolIndex;
      for (let c = 0; c < 2; c++) {
        for (let r = 0; r < 3; r++) if (cols[c][r] < 0) cols[c][r] = randSym();
      }

      // 揃っていたはずの3列目
      const tease = [randSym(), randSym(), randSym()];
      tease[L[2]] = symbolIndex;
      // そこから1コマ滑らせる
      cols[2] = [randSym(), tease[0], tease[1]];

      if (linesWon(cols).length === 0) {
        return { cols, winLines: [], reach: true, tease };
      }
    }
  }

  for (let attempt = 0; attempt < 80; attempt++) {
    const cols = [
      [randSym(), randSym(), randSym()],
      [randSym(), randSym(), randSym()],
      [randSym(), randSym(), randSym()],
    ];
    // reach を掛けない回は、2列目までで既に揃いかけていないことまで見る。
    // ここを見ないと「リーチ表示は出ないのに絵は揃っている」ちぐはぐが出る
    if (linesWon(cols).length === 0 && (wantReach || !hasReach(cols))) {
      return { cols, winLines: [], reach: hasReach(cols), tease: null };
    }
  }

  // 保険。全部違う絵柄で埋めれば必ずハズレになる
  const cols = [[0, 1, 2], [3, 4, 5], [6, 7, 0]];
  return { cols, winLines: [], reach: false, tease: null };
}

/**
 * 抽選結果から盤面を組み立てる。
 * @returns {{cols:number[][], winLines:number[], reach:boolean, tease:number[]|null}}
 */
export function buildGrid(res) {
  if (res.win) {
    const { cols, winLines } = buildWin(res.index, res.lines || 1);
    return { cols, winLines, reach: true, tease: null };
  }
  return buildMiss(rnd() < 0.55);
}
