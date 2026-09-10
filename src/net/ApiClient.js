/**
 * サーバとの通信 (DESIGN_SERVER.md §9)
 *
 * **fetch と sendBeacon を知ってよいのはこのファイルだけ。**
 * `SaveStore` が localStorage を1ファイルに閉じ込めているのと同じ形にしている。
 * 将来つなぎ先が変わっても、ここの中身を差し替えればゲーム側は触らずに済む。
 *
 * ■ 決まりごと
 *   **どのメソッドも例外を投げない。** 失敗は null / false で返す。
 *   セーブの正は localStorage 側にあるので、ここが落ちてもゲームは続けられる。
 *   投げると呼び出し側に try/catch が散らばり、
 *   「ネットが無いと遊べない」に一歩近づく。
 */

const BASE = '/api';

/** JSON を投げて JSON を受け取る。失敗は null */
async function request(path, init) {
  try {
    const res = await fetch(BASE + path, {
      // Cookie を送る。同一オリジンなので既定でも付くが、意図を明示しておく
      credentials: 'same-origin',
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init && init.headers) },
    });
    // 409 は「競合」という正常な結果なので、本文まで読んで返す
    if (!res.ok && res.status !== 409) return { ok: false, status: res.status, data: null };
    const data = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, data };
  } catch {
    // オフライン、DNS 失敗、Cookie ブロックなど。黙って諦める
    return { ok: false, status: 0, data: null };
  }
}

class ApiClientImpl {
  /**
   * 匿名ユーザーを作る (§5.2)。
   * 「同期が必要になってから」呼ぶ。開いて即閉じた人の行を作らないため。
   * @param {string|null} turnstileToken 未設定なら null。サーバ側も未設定なら検証しない
   * @returns {Promise<{userId: string, rev: number}|null>}
   */
  async register(turnstileToken) {
    const r = await request('/session', {
      method: 'POST',
      body: JSON.stringify({ turnstile: turnstileToken }),
    });
    return r.ok && r.data ? r.data : null;
  }

  /**
   * セーブを送る。
   * @returns {Promise<{status:'ok', rev:number} | {status:'conflict', rev:number, payload:object|null} | {status:'error', code:number}>}
   */
  async putSave(rev, payload, clientSavedAt) {
    const r = await request('/save', {
      method: 'PUT',
      body: JSON.stringify({ rev, payload, clientSavedAt }),
    });
    if (r.ok && r.data) return { status: 'ok', rev: r.data.rev };
    if (r.status === 409 && r.data) {
      return { status: 'conflict', rev: r.data.rev, payload: r.data.payload };
    }
    return { status: 'error', code: r.status };
  }

  /** 別端末から引き継いだ直後など、ローカルが空のときだけ使う */
  async getSave() {
    const r = await request('/save', { method: 'GET' });
    return r.ok && r.data ? r.data : null;
  }

  /**
   * タブを閉じる/隠れるときの最後の1回 (§4.5)。
   *
   * `pagehide` の中では通常の fetch が打ち切られるので sendBeacon を使う。
   * sendBeacon は独自ヘッダを付けられないが Cookie は付く。
   * CSRF 対策を独自ヘッダに寄せられないのはこれが理由 (§4.5)。
   *
   * また `application/json` の Blob を渡せているのは **同一オリジンだから**で、
   * 別オリジン構成にすると preflight が要求されて送れなくなる (§15-14)。
   */
  beaconSave(rev, payload, clientSavedAt) {
    try {
      if (typeof navigator === 'undefined' || !navigator.sendBeacon) return false;
      const body = new Blob(
        [JSON.stringify({ rev, payload, clientSavedAt })],
        { type: 'application/json' }
      );
      // sendBeacon は POST 固定。PUT にできないので専用の経路を用意している
      return navigator.sendBeacon(`${BASE}/save/beacon`, body);
    } catch {
      return false;
    }
  }

  /** 「記録を消す」(§7.3)。サーバ側は行ごと消える */
  async deleteUser() {
    const r = await request('/user', { method: 'DELETE' });
    return r.ok;
  }

  /** パーセンタイル (§8.5)。資格未達なら status: 'ineligible' が返る */
  async ranking() {
    const r = await request('/ranking', { method: 'GET' });
    return r.ok && r.data ? r.data : null;
  }

  /** 引き継ぎコードを発行する (§5.3) */
  async transferCode() {
    const r = await request('/transfer/code', { method: 'POST', body: '{}' });
    return r.ok && r.data ? r.data : null;
  }

  /** 引き継ぎコードを使う。失効・使用済み・不一致はすべて null で返る */
  async redeem(code) {
    const r = await request('/transfer/redeem', {
      method: 'POST',
      body: JSON.stringify({ code }),
    });
    return r.ok && r.data ? r.data : null;
  }
}

export const ApiClient = new ApiClientImpl();
