import { CFG } from '../config.js';

const KEY = CFG.save.key;
const VERSION = CFG.save.version;

/**
 * セーブデータの読み書き (DESIGN.md §11)。
 *
 * localStorage を知っているのはこのファイルだけ。
 * 将来サーバへ移すときも、ここの中身を差し替えればゲーム側は触らずに済む。
 *
 * 盤面の座標は保存しない。保存するのは「場に何枚あったか」という数字1つだけなので、
 * データは数百バイトに収まり、キーも1つで足りる（＝書き込みは常に1回、原子性の心配がない）。
 */
class SaveStoreImpl {
  constructor() {
    this.available = this._probe();
    this.lastError = null;
    this._pending = null;
    this._timer = 0;
    /**
     * サーバへのミラー (DESIGN_SERVER.md §9)。
     *
     * 差し込まれなければ何も起きない。localStorage が正で、ここは付け足し。
     * `main.js` が `SaveStore.sink = new SyncStore(...)` と書くだけでつながり、
     * ゲーム側もこのファイルの読み書きの手順も変わらない。
     */
    this.sink = null;
  }

  /** プライベートウィンドウなどでは localStorage が使えない、または例外を投げる */
  _probe() {
    try {
      const k = '__medalweb_probe__';
      window.localStorage.setItem(k, '1');
      window.localStorage.removeItem(k);
      return true;
    } catch {
      return false;
    }
  }

  /** 端末で1回だけ発行する識別子。今は使わないが、将来サーバに名乗るため */
  newUserId() {
    try {
      if (window.crypto && typeof window.crypto.randomUUID === 'function') {
        return window.crypto.randomUUID();
      }
    } catch {
      /* 非セキュアコンテキストなどでは使えない。下のフォールバックへ */
    }
    // 厳密な UUID である必要はない。衝突しなければよい
    const r = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0');
    return `${r()}${r()}-${r()}-${r()}-${r()}-${r()}${r()}${r()}`;
  }

  /**
   * @returns {object|null} 読めなければ null (壊れている / 版が違う / 使えない)
   */
  load() {
    if (!this.available) return null;
    try {
      const raw = window.localStorage.getItem(KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (!data || data.v !== VERSION) return null;
      return data;
    } catch (e) {
      // 壊れたデータで起動できないほうが困るので、捨てて新規から始める
      this.lastError = e;
      return null;
    }
  }

  /** 値が変わったら呼ぶ。実際の書き込みはまとめて行う */
  save(state) {
    // ミラーは localStorage が使えるかどうかとは独立に動かす。
    // プライベートモードでも Cookie さえ通れば端末間の引き継ぎは成立する
    this.sink?.push(state);
    if (!this.available) return;
    this._pending = state;
    if (this._timer) return;
    this._timer = window.setTimeout(() => {
      this._timer = 0;
      this.flush();
    }, CFG.save.debounceMs);
  }

  /**
   * 引き継ぎで受け取ったセーブでローカルを置き換える (DESIGN_SERVER.md §5.3)。
   *
   * `save()` を使わないのは、sink に送り返さないため。
   * そして **マージしない**。マージすると2つのアカウントの通算記録を
   * 合流させられる (§15-4)。
   */
  replace(state) {
    if (!this.available) return;
    try {
      window.localStorage.setItem(KEY, JSON.stringify(state));
      this.lastError = null;
    } catch (e) {
      this.lastError = e;
    }
  }

  /** pagehide などから即時に書く */
  flush() {
    if (!this.available || !this._pending) return;
    if (this._timer) {
      window.clearTimeout(this._timer);
      this._timer = 0;
    }
    const state = this._pending;
    this._pending = null;
    try {
      window.localStorage.setItem(KEY, JSON.stringify(state));
      this.lastError = null;
    } catch (e) {
      // 容量超過やプライベートモードの拒否。握りつぶすが、失敗したことは残す
      this.lastError = e;
    }
  }

  /**
   * タブを閉じる / 隠れるときの最後の1回 (DESIGN.md §11.4 / DESIGN_SERVER.md §4.5)。
   *
   * `flush()` と分けているのは、`flush()` が2秒デバウンスの満了でも呼ばれるため。
   * ここを `flush()` に混ぜると、サーバへのビーコンが2秒ごとに飛ぶ。
   * この中では非同期処理ができないので、sink 側も sendBeacon に切り替わる。
   */
  finalize(state) {
    this.save(state);
    this.flush();
    this.sink?.beacon(state);
  }

  /** 記録を消す。userId も一緒に消える */
  clear() {
    // サーバ側も行ごと消す。待たない (押した直後に UI を止めない)
    void this.sink?.clear();
    this._pending = null;
    if (this._timer) {
      window.clearTimeout(this._timer);
      this._timer = 0;
    }
    if (!this.available) return;
    try {
      window.localStorage.removeItem(KEY);
      this.lastError = null;
    } catch (e) {
      this.lastError = e;
    }
  }
}

export const SaveStore = new SaveStoreImpl();
