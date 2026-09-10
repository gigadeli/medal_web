/** Worker のバインディングと、ミドルウェアが下へ渡す値 (DESIGN_SERVER.md §10) */

/**
 * Rate Limiting binding。
 * §4.3 の通り **ロケーションごと・permissive** なので、
 * 「乱打を止める蓋」であって不正の検出手段ではない
 */
export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  /** dist/ の配信。/api/* 以外はそもそも Worker を通らない */
  ASSETS: Fetcher;
  DB: D1Database;
  API_LIMITER: RateLimiter;
  TRANSFER_LIMITER: RateLimiter;
  ENVIRONMENT: string;
  /** 未設定なら Turnstile の検証をスキップする (開発中はそれでよい) */
  TURNSTILE_SECRET?: string;
}

export type AppEnv = {
  Bindings: Env;
  Variables: {
    /** ログを串刺しするための ID。応答の X-Request-Id にも出る */
    reqId: string;
    /**
     * identity が解決したユーザー。
     * **クライアントが名乗った ID は絶対にここに入れない** (§5.1)
     */
    userId: string;
    /** `jsonBody` が長さを見てからパースした本文。ハンドラはこれだけを読む */
    body: unknown;
  };
};
