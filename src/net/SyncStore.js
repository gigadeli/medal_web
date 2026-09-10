/**
 * D1 へのミラー (DESIGN_SERVER.md §7)
 *
 * `SaveStore` の後ろに差し込む「sink」。ゲーム側もセーブ側もここを知らない。
 * `main.js` が `SaveStore.sink = new SyncStore(...)` と1行書くだけでつながる。
 *
 * ■ 方針
 *   localStorage が正、ここはミラー。
 *   **失敗しても黙って捨てる。** 次のデバウンスで送り直せばよく、
 *   ネットが死んでもゲームは今まで通り動く。
 *
 * ■ デバウンスが localStorage より 30 倍長い理由 (§7.1)
 *   `wallet.onChange` はメダル1枚ごとに発火する。同じ頻度で D1 に書くと
 *   無料枠の書き込みが溶ける。
 */
import { CFG } from '../config.js';
import { ApiClient } from './ApiClient.js';

/** 非負整数として読む。`Wallet.uint()` と同じ方針 */
const u = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
const maxU = (a, b) => Math.max(u(a), u(b));

/**
 * 競合したときのマージ (§7.2)
 *
 * 規則を決めておかないと「大きいほうを採る」コードが `medals` にも適用されて、
 * **持ち枚数が勝手に増える**。分けて書く理由はそれ。
 *
 *   通算・最高記録 … 大きいほう (減ることは無い)
 *   いま遊んでいる台 … ローカル優先 (サーバの古い値で上書きしたら台が消える)
 */
function merge(local, remote) {
  if (!remote || typeof remote !== 'object') return local;

  const out = { ...local };
  out.best = maxU(local.best, remote.best);

  const ll = local.lifetime || {};
  const rl = remote.lifetime || {};
  const ls = ll.slot || {};
  const rs = rl.slot || {};
  const byId = { ...(ls.byId || {}) };
  for (const k of Object.keys(rs.byId || {})) {
    // 知らないキーは持ち込まない。config にある絵柄だけ
    if (CFG.slot.symbols.some((s) => s.id === k)) byId[k] = maxU(byId[k], rs.byId[k]);
  }

  out.lifetime = {
    inserted: maxU(ll.inserted, rl.inserted),
    earned: maxU(ll.earned, rl.earned),
    lost: maxU(ll.lost, rl.lost),
    games: maxU(ll.games, rl.games),
    slot: {
      spins: maxU(ls.spins, rs.spins),
      wins: maxU(ls.wins, rs.wins),
      byId,
    },
    jp: {
      wins: maxU((ll.jp || {}).wins, (rl.jp || {}).wins),
      paid: maxU((ll.jp || {}).paid, (rl.jp || {}).paid),
    },
  };
  if (out.lifetime.slot.wins > out.lifetime.slot.spins) {
    out.lifetime.slot.wins = out.lifetime.slot.spins;
  }
  // medals / run / fieldStock / settings / jackpot / steps はローカルのまま
  if (out.best < u(out.medals)) out.best = u(out.medals);
  return out;
}

export class SyncStore {
  /**
   * @param {object} opts
   * @param {(s: {serverUserId: string|null, pending: boolean, offline: boolean}) => void} [opts.onStatus]
   * @param {() => Promise<string|null>} [opts.getTurnstileToken] 未設定なら null を送る
   */
  constructor(opts = {}) {
    this.serverUserId = null;
    this.rev = 0;
    this.syncedAt = 0;

    this.onStatus = opts.onStatus || (() => {});
    /**
     * サーバの識別子が変わったときだけ呼ぶ (登録・引き継ぎ・削除)。
     *
     * ここが無いと **実測で踏んだ不具合**が出る:
     * 登録に成功しても `server.userId` が localStorage に書き戻されず、
     * リロードのたびに新しいユーザーを作りにいく。
     * D1 に誰も名乗れない行が積もり、§15-3 で塞いだはずの
     * 「書き込み枠を焼く」経路を自分で開けてしまう。
     *
     * rev の変化では呼ばない。毎回の同期で呼ぶと
     * 「persist → push → 60秒後に同期 → persist」の輪ができて、
     * 誰も遊んでいないのに書き込みが止まらなくなる。
     * rev がずれても 409 で直る (§7.2) ので、次の自然な保存に相乗りすれば足りる。
     */
    this.onIdentity = opts.onIdentity || (() => {});
    this.getTurnstileToken = opts.getTurnstileToken || (async () => null);

    this._pending = null;
    this._timer = 0;
    this._busy = false;
    /** 失敗が続いたときに叩き続けない */
    this._blockedUntil = 0;
    this._offline = false;
  }

  /** 起動時に localStorage の `server` フィールドから戻す */
  restore(server) {
    if (!server || typeof server !== 'object') return;
    if (typeof server.userId === 'string') this.serverUserId = server.userId;
    this.rev = u(server.rev);
    this.syncedAt = u(server.syncedAt);
  }

  /** `main.js` の snapshot() がこれを `server` フィールドに入れる */
  serialize() {
    return { userId: this.serverUserId, rev: this.rev, syncedAt: this.syncedAt };
  }

  _notify() {
    this.onStatus({
      serverUserId: this.serverUserId,
      pending: this._pending !== null,
      offline: this._offline,
    });
  }

  /* ---------------- SaveStore から呼ばれる口 ---------------- */

  /** 値が変わった。実際の送信はまとめて行う */
  push(state) {
    this._pending = state;
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = 0;
      void this.flush();
    }, CFG.sync.debounceMs);
  }

  /**
   * タブを閉じる/隠れるとき (§4.5)。
   * 非同期を待てないので sendBeacon に切り替える。
   */
  beacon(state) {
    const s = state || this._pending;
    if (!s || !this.serverUserId) return;   // 未登録なら諦める。登録は待てない
    ApiClient.beaconSave(this.rev, s, Date.now());
    // 送れたかは分からない。rev を進めないでおけば、
    // 次回の同期が 409 で正しい rev を教えてもらえる
  }

  /** デバウンスを待たずに送る */
  async flush() {
    if (this._busy || !this._pending) return;
    if (Date.now() < this._blockedUntil) return;

    this._busy = true;
    const state = this._pending;
    this._pending = null;
    try {
      await this._send(state);
    } finally {
      this._busy = false;
      this._notify();
    }
  }

  async _send(state) {
    const before = this.serverUserId;
    if (!this.serverUserId) {
      const token = await this.getTurnstileToken();
      const reg = await ApiClient.register(token);
      if (!reg) return this._fail();
      this.serverUserId = reg.userId;
      this.rev = reg.rev;
    }

    let payload = state;
    let res = await ApiClient.putSave(this.rev, payload, Date.now());

    // 別端末で遊んだあと。マージして1回だけ送り直す (§7.2)
    if (res.status === 'conflict') {
      payload = merge(state, res.payload);
      this.rev = res.rev;
      res = await ApiClient.putSave(this.rev, payload, Date.now());
    }

    /* セッションが無効。別端末で「記録を消す」を押した、400日空いて Cookie が
       落ちた、などで起きる。identity を捨てておかないと、
       次も同じ死んだ ID で PUT を撃ち続けて**永久に復帰できない** */
    if (res.status === 'error' && res.code === 401) {
      this.serverUserId = null;
      this.rev = 0;
      this.onIdentity(this.serialize());
      return this._fail();
    }
    if (res.status !== 'ok') return this._fail();

    this.rev = res.rev;
    this.syncedAt = Date.now();
    this._offline = false;
    // 登録できたことを localStorage に焼く。ここを忘れると毎回作り直しになる
    if (before !== this.serverUserId) this.onIdentity(this.serialize());
  }

  _fail() {
    this._offline = true;
    this._blockedUntil = Date.now() + CFG.sync.retryMs;
  }

  /* ---------------- ゲーム側から呼ぶ口 ---------------- */

  /**
   * 「記録を消す」(§7.3)。
   * サーバ側は行ごと消える。論理削除ではない。
   */
  async clear() {
    this._pending = null;
    if (this._timer) { clearTimeout(this._timer); this._timer = 0; }
    if (!this.serverUserId) return;
    await ApiClient.deleteUser();
    // ローカル側の識別子も落とす。消したのに残るのでは消したことにならない
    this.serverUserId = null;
    this.rev = 0;
    this.syncedAt = 0;
    this.onIdentity(this.serialize());
    this._notify();
  }

  /** 引き継ぎコードを発行する (§5.3) */
  async issueCode() {
    if (!this.serverUserId) {
      // まだ登録していない。先に1回同期してからでないとコードを出せない
      await this.flush();
      if (!this.serverUserId) return null;
    }
    return ApiClient.transferCode();
  }

  /**
   * 引き継ぎコードを使う。成功したらサーバのセーブをそのまま返す。
   * **マージしない。** ローカルを置き換える (§15-4)。
   * マージすると2つのアカウントの通算記録を合流させられる。
   */
  async redeemCode(code) {
    const r = await ApiClient.redeem(code);
    if (!r) return null;
    this.serverUserId = r.userId;
    const remote = await ApiClient.getSave();
    if (!remote) return null;
    this.rev = u(remote.rev);
    this.syncedAt = Date.now();
    this._notify();
    return remote.payload;
  }

  async ranking() {
    if (!this.serverUserId) return null;
    return ApiClient.ranking();
  }
}
