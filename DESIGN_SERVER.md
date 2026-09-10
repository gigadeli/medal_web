# サーバ設計 —— Cloudflare Workers + D1

作成: 2026-09-10 / 対象: 本リポジトリ
前提として読むもの: `DESIGN.md §11`（セーブ）、`DESIGN_SECURITY.md §5`（サーバを足すときに必ず読むこと）

---

## 0. 決めたこと

| 項目 | 決定 |
|---|---|
| 配信 | **Workers Static Assets**。ゲーム本体と API を同一 Worker・同一オリジンで出す |
| 目的 | ① セーブのバックアップ／端末間引き継ぎ ② ランキング |
| 識別 | **匿名 user_id + サーバ発行トークン**（HttpOnly Cookie）。クライアント生成の `userId` は名乗りに使わない |
| セーブの正 | **localStorage が正、D1 はミラー**。ネットが死んでもゲームは止まらない |
| 処理の分割 | `/api/*` をミドルウェア連鎖に通す（Hono）。SQL はハンドラに書かない |

そして本文書は最初に一度だけ、はっきり書いておきます。

> **`DESIGN_SECURITY.md §5` は正しい。クライアントが申告した数字は検証できない。**
> §8 で、それでもランキングを出すためにやること／やらないことを決めます。

**§15 は初稿に対するセキュリティレビューです。** そこで §8.3 と §8.4 の推奨が
間違っていたことが分かったため、本文は修正済みです。実装前に §15 を読んでください。

---

## 1. 現状と、変わること

いま動いているもの:

```
GitHub Actions → Vite build → dist/ → GitHub Pages（静的のみ）
ブラウザ: localStorage キー1つ "medalweb:v1:save"（実測 319 バイト）
```

変わるのはここだけです。

| | 現在 | 変更後 |
|---|---|---|
| 配信元 | GitHub Pages | Cloudflare Workers（Static Assets） |
| セーブ | localStorage のみ | localStorage（正）+ D1（ミラー） |
| `main.js` | `SaveStore` を呼ぶ | **変わらない** |
| `Wallet` / 物理 / 演出 | — | **一切変わらない** |
| ゲームのオフライン動作 | 動く | **動く**（ここは死守する） |

`SaveStore` の後ろに同期の口を1つ足すだけで済むのは、`DESIGN.md §11.7` が
「localStorage を知っているのはこのファイルだけ」という形にしておいたからです。
同じ理屈で、**fetch を知っているのは `src/net/ApiClient.js` だけ**にします。

---

## 2. 全体構成

```
                        Cloudflare Workers（1つ）
  ブラウザ ──────▶ ┌──────────────────────────────────────────┐
                   │ assets router                            │
                   │  /            → dist/index.html          │  ← Worker を通らない
                   │  /assets/*    → dist/assets/*.js .mp4    │  ← Worker を通らない
                   │  /api/*       → run_worker_first で横取り │
                   └───────────────┬──────────────────────────┘
                                   ▼
                   ┌──────────────────────────────────────────┐
                   │ Hono app（ミドルウェア連鎖 → ルート）     │  §4
                   └───────────────┬──────────────────────────┘
                                   ▼
                          D1: medal_web                          §6
```

`run_worker_first: ["/api/*"]` にするのが要点です。3.7MB の JS と 7.1MB の mp4 は
Worker を起動せずに配信され、**Worker 呼び出しは API のときだけ**になります
（無料枠 10万リクエスト／日を、動画のレンジリクエストで溶かさないため）。

### なぜ Pages でも GitHub Pages でもなく Workers か

| 案 | 判断 |
|---|---|
| GitHub Pages のまま + API だけ別 Worker | **却下**。オリジンが分かれる → CORS 設定が要る、Cookie が cross-site になり `SameSite=None` 必須、プライバシー設定で落ちる端末が出る |
| Cloudflare Pages + Pages Functions | 可。ただしルーティングがファイル規約に縛られ、「ミドルウェアに処理を分けたい」という今回の狙いとは相性が悪い |
| **Workers Static Assets（採用）** | 同一オリジン。Cookie は `SameSite=Lax` で済み、CORS が要らない。ルーティングをコードで書ける |

同一オリジンにすると **CORS ミドルウェアがほぼ不要になる**（開発時の `localhost:5173` だけ）ので、
これは「機能を足す」ではなく「機能を消す」判断です。

### アセットの制限確認（実測値との突き合わせ）

| 制限 | 値 | 本プロジェクト | |
|---|---|---|---|
| 1ファイル最大 | 25 MiB | `fever_1.mp4` = 7.1 MB | ✓ |
| ファイル数 | 20,000（無料） | `dist/` = 19 ファイル | ✓ |
| 合計 | 無制限 | 12 MB | ✓ |

`vite.config.js` の `base: './'` はルート配信でもそのまま動くので、**触りません**。

---

## 3. ディレクトリ

```
src/
  server/                    ← 新規。Worker 側。ブラウザには一切バンドルされない
    index.ts                 エントリ。Hono app を組み立て、それ以外は ASSETS に流す
    middleware/
      requestId.ts
      error.ts
      security.ts
      cors.ts                開発時だけ効く
      rateLimit.ts
      identity.ts            ★ Cookie → user_id
      validate.ts
    routes/
      save.ts                PUT /api/save, GET /api/save
      ranking.ts             GET /api/ranking
      transfer.ts            POST /api/transfer/code, POST /api/transfer/redeem
      user.ts                DELETE /api/user
    db/                      ★ SQL を書いてよいのはここだけ
      users.ts  sessions.ts  saves.ts  scores.ts  transfer.ts
    domain/
      schema.ts              受け取る JSON の形（検証はここ）
      plausibility.ts        外れ値判定（§8）。Worker と将来のバッチで共用
  net/                       ← 新規。クライアント側
    ApiClient.js             ★ fetch を知ってよいのはここだけ
    SyncStore.js             SaveStore の後ろに差し込む同期層
migrations/
  0001_init.sql
wrangler.jsonc
```

`db/` と `routes/` を分けるのは、**SQL がハンドラに散らばると外れ値判定やランキングの
クエリを直せなくなる**からです。`SaveStore` が localStorage を1ファイルに閉じ込めているのと
同じ動機で、`D1Database` に触るのを `db/` だけにします。

---

## 4. ミドルウェア設計 ★本題

### 4.1 連鎖の順序

順序には意味があります。上から下へ入り、下から上へ抜けます。

```
  ① requestId    ─┐  リクエストIDを振る。以降のログを串刺しできる
  ② error        ─┤  ここより下の例外を JSON に変える。スタックは返さない
  ③ security     ─┤  応答ヘッダ（nosniff / frame-deny / referrer-policy）
  ④ cors         ─┤  開発時の localhost だけ。本番では素通り
  ⑤ rateLimit    ─┤  ここで落とせば D1 に触らずに済む
  ⑥ identity     ─┤  Cookie のトークン → user_id を解決／必要なら発行
  ⑦ validate     ─┤  本文の形を検証。通ったものだけが下へ行く
  ⑧ handler      ─┘  db/ を呼ぶ。ここには if も SQL も最小限しか無い
```

**なぜこの順か**（並べ替えると壊れるところ）:

- `error` は **ミドルウェアではなく `app.onError` で登録します**（実装時に判明。§16-1）。
  Hono の `compose` はミドルウェア1枚ごとに try/catch を持っていて、
  内側が投げた時点でその場で `onError` を呼ぶため、
  外側の `await next()` は reject せず、`try/catch` 方式は**一度も動きません**。
  `onError` にすると応答は投げた深さで作られ、そこから外側の
  `await next()` の後ろが順に走るので、**500 の応答にも `security` のヘッダが付きます**
  ——狙っていた性質はそのまま得られます
- `rateLimit` は `identity` の **上**。認証前に落とせば、攻撃時に D1 を読まずに済みます。
  キーは（未認証なら）IP、（認証済みなら）user_id にしたいところですが、
  順序上まだ user_id が無いので **IP で引きます**。IP は保存しません
- `validate` は `identity` の **下**。壊れた本文より先に「誰か」を確定させたほうが、
  ログが役に立ちます

### 4.2 各ミドルウェアの責務

| # | ファイル | やること | やらないこと |
|---|---|---|---|
| ① | `requestId.ts` | `crypto.randomUUID()` を `c.set('reqId')`。応答に `X-Request-Id` | ログの本文を作らない |
| ② | `error.ts` | 例外を `{ error, reqId }` に。想定内は `HttpError(status, code)`、想定外は 500 固定 | **例外メッセージをそのまま返さない**（D1 のエラー文にテーブル名が乗る） |
| ③ | `security.ts` | `X-Content-Type-Options: nosniff` / `X-Frame-Options: DENY` / `Referrer-Policy: no-referrer` / `Cache-Control: no-store` | CSP はここでは付けない（→ §13） |
| ④ | `cors.ts` | `env.ENVIRONMENT === 'dev'` のときだけ `localhost:5173` を許可 | 本番でワイルドカード Origin を許可しない |
| ⑤ | `rateLimit.ts` | `env.API_LIMITER.limit({ key })`。超過は 429 + `Retry-After` | 正確な課金・計測に使わない（後述） |
| ⑥ | `identity.ts` | Cookie `mw_token` → SHA-256 → `sessions` 引き当て（`expires_at` も見る）→ `c.set('userId')` | **クライアントが本文や header で名乗った ID を一切見ない** |
| ⑦ | `validate.ts` | 本文の型・範囲・上限バイト数。`domain/schema.ts` の定義を当てる | 「ありえない数字か」の判断（それは §8、ハンドラの下） |

`identity` は **`require` の1モードだけ**です。初稿には「無ければその場で発行する」
`ensure` モードもありましたが、実装時に廃止しました（§16-3）。理由は2つ:

1. **Turnstile のトークンは `sendBeacon` に載せられない。**
   登録が同期の経路に混ざっていると、§15-3 の対策を掛けられない
2. 登録は書き込み枠を焼く経路なので、入口を1つに絞りたい

登録は `POST /api/session` に分離しました。**遅延登録（開いて即閉じた人の行を作らない）
の性質は保たれています** —— クライアントが「同期が必要になってから」呼ぶだけです。

### 4.3 Rate Limiting binding の性質（誤解しやすい）

`wrangler.jsonc` の `ratelimits` binding は使いますが、性質を正しく理解して使います。

- **period は 10 か 60 秒しか取れない**
- **カウンタは Cloudflare のロケーションごと**。グローバルに正確ではない
- ドキュメントが明言している通り「permissive, eventually consistent, 正確な計上に使うな」

したがってこれは **乱打を止める蓋**であって、不正の検出手段ではありません。
§8 の外れ値判定を rate limit で代用しようとしないこと。

### 4.4 なぜ Hono か

| 案 | 判断 |
|---|---|
| **Hono（採用）** | Workers ネイティブ。`app.use()` の連鎖がまさに今回やりたい形。依存ゼロ。`c.set/c.get` で `userId` を下へ渡せる |
| 素の `fetch` ハンドラ + 自前 `compose()` | 依存は増えないが、結局 Hono の劣化版を書くことになる。ルーティング・Cookie・型付き `env` を全部自作する |
| Express など | Node 前提。Workers では動かない |

`package.json` に増えるのは `hono` 1つだけです。
`zod` は入れません（→ §13）。検証は `domain/schema.ts` に手書きします。理由は、
検証したい内容が「非負整数か・上限を超えていないか」だけで、
`Wallet` の `uint()` と同じ実装をサーバ側にもう一度書けば足りるからです。

### 4.5 CSRF と `sendBeacon` の衝突 ★踏みやすい

Cookie 認証なので CSRF を考える必要があります。素直な対策は
「独自ヘッダ（`X-Requested-With` 等）を必須にする」ですが、**これは採用できません**。

`DESIGN.md §11.4` が決めた通り、書き込みは `pagehide` で確実に流します。
`pagehide` の中では通常の `fetch` は打ち切られるので `navigator.sendBeacon` を使いますが、
**`sendBeacon` は独自ヘッダを付けられません**（Cookie は付きます）。

なので防御はこの2枚にします。

1. `SameSite=Lax` —— 他サイトからの `POST` にはそもそも Cookie が付かない
2. `Origin` ヘッダの照合 —— 自オリジン以外の書き込みは 403

`sendBeacon` は `Origin` を送るので②を通ります。
`SameSite=Lax` はクロスサイトの `POST`（`sendBeacon` を含む）に Cookie を付けないので、
①だけでも実質防げています。②は保険です。

---

## 5. 識別と認証

### 5.1 クライアント生成の `userId` を名乗りに使わない

`DESIGN.md §11.3` が既に書いています。

> **この ID を認証の代わりにしてはいけません。**

具体的に何が起きるか。`userId` は localStorage に平文で入っていて、
プレイヤーが自由に書き換えられます。それをサーバが信じると:

- 他人の `userId` を入れれば **他人のセーブが読める・上書きできる**
- ランキングは、他人の名前で好きな数字を出せる遊びになる

なので **サーバが発行した秘密（トークン）だけを名乗りとして受け付けます**。

### 5.2 発行と保存

```
クライアントが「同期が必要になった」と判断して POST /api/session
   → Turnstile を検証する（§15-3。シークレット未設定なら素通し）
   → サーバが user_id（UUIDv4）とトークン（32バイト乱数、base64url）を生成
   → D1 の sessions には SHA-256(トークン) だけを入れる（生トークンは保存しない）
   → users と sessions は **必ず batch で一緒に作る**（§16-7）
   → Set-Cookie: mw_token=<トークン>;
        HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=34560000  ← 400日
```

**Max-Age は 400 日が上限です。** 設計では2年と書いていましたが、
ブラウザ側の仕様で切り詰められ、Hono も例外を投げます（§16-2）。
400日以上あいだが空いた端末は Cookie を失います。D1 の行は残っているので、
そのときは**引き継ぎコード（§5.3）が唯一の復帰経路**になります。

決めた点と、その理由:

| 決定 | 理由 |
|---|---|
| **遅延発行**（初回起動時ではなく初回セーブ時） | 開いて即閉じた人の行を作らない。D1 の書き込み枠（無料 10万/日）を守る |
| `HttpOnly` | JS から読めない。将来 XSS が入っても盗まれない（現状 XSS 面は無い＝`DESIGN_SECURITY.md §4`） |
| `SameSite=Lax`（`Strict` ではない） | `Strict` は外部リンクから開いたときに Cookie が付かず、初回だけ別人になる。`Lax` でも cross-site POST は防げる |
| トークンはハッシュで保存 | D1 が漏れても、そのままでは名乗れない |
| 1 user に **複数** session 行 | 端末ごとに1行。引き継ぎ後も元の端末が使えるようにする |

**Cookie が保存できない環境**（プライベートモード、ブロック設定）では、
`SaveStore.available === false` と**まったく同じ扱い**にします。同期は黙って諦め、
ゲームは今まで通り localStorage だけで動きます。HUD に小さく「未同期」とだけ出します。

### 5.3 引き継ぎコード

ログイン画面を作らないので、端末間の移動はこの形にします。

```
[元の端末]  POST /api/transfer/code   → "K7M2-P9QX"（8文字、10分、1回だけ）
[新の端末]  POST /api/transfer/redeem { code }
              → 同じ user_id に新しい session 行を足し、新しいトークンを Cookie に入れる
              → GET /api/save でミラーを引き、localStorage を上書きする
```

- コードも **ハッシュで保存**します
- `used_at` を立てて1回で使い切ります
- 失効・使用済み・不一致は **区別せず** 同じ 404 を返します（総当たりに情報を与えない）
- `transfer/redeem` の rate limit は特に厳しく（IP あたり 10 回/分）

### 5.4 セーブのスキーマ版は上げない ★

D1 の user_id をクライアントに覚えさせる必要がありますが、
**`CFG.save.version` は 1 のまま据え置きます**。

`SaveStore.load()` は `data.v !== VERSION` のセーブを **null にして捨てます**。
版を 2 に上げると、既存プレイヤーの通算記録・最高記録が全部消えます。
`Wallet.restore` が古いセーブの `jp` を「版を上げずに既定で埋める」で処理したのと同じ方針で、
**フィールドを足すだけ**にします。

```jsonc
{
  "v": 1,
  "userId": "...",          // 既存。ローカル専用の識別子として残す。サーバには送らない
  "server": {               // ← 追加。無ければ「まだ同期していない」
    "userId": "...",        // サーバが発行した ID。表示とデバッグ用
    "rev": 42,              // 単調増加。競合判定に使う（§7.2）
    "syncedAt": 1788486000000
  }
}
```

既存の `userId` を消さないのは、**「記録を消す」がローカルだけで完結する経路を残す**ためです。

---

## 6. D1 スキーマ

### 6.1 テーブル

```sql
-- migrations/0001_init.sql
PRAGMA foreign_keys = ON;

-- 時刻は全部 unix ミリ秒の INTEGER。SQLite に日付型は無い
CREATE TABLE users (
  id            TEXT    PRIMARY KEY,      -- UUIDv4。サーバが生成する
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL          -- サーバの時計。§8 のレート計算の分母
);

-- 端末ごとに1行。生トークンは保存しない
CREATE TABLE sessions (
  token_hash    TEXT    PRIMARY KEY,      -- SHA-256(token) の hex
  user_id       TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    INTEGER NOT NULL,
  last_used_at  INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

-- localStorage のミラー。1 user 1 行
CREATE TABLE saves (
  user_id         TEXT    PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  rev             INTEGER NOT NULL,       -- クライアントの単調増加カウンタ
  payload         TEXT    NOT NULL,       -- セーブ JSON をそのまま（実測 319 バイト）
  client_saved_at INTEGER NOT NULL,       -- クライアントの時計。信じない。表示用
  updated_at      INTEGER NOT NULL        -- サーバの時計
);

-- ランキング用に payload から切り出した非正規化
CREATE TABLE scores (
  user_id         TEXT    PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  best_medals     INTEGER NOT NULL DEFAULT 0,
  lifetime_earned INTEGER NOT NULL DEFAULT 0,
  jp_wins         INTEGER NOT NULL DEFAULT 0,
  jp_paid         INTEGER NOT NULL DEFAULT 0,
  play_ms         INTEGER NOT NULL DEFAULT 0,   -- サーバが測る（§8）
  flagged         INTEGER NOT NULL DEFAULT 0,   -- 1 なら集計から外す。消さない
  updated_at      INTEGER NOT NULL
);
-- ランキングは flagged=0 だけを見る → 部分インデックス
CREATE INDEX idx_scores_best ON scores(best_medals DESC) WHERE flagged = 0;
CREATE INDEX idx_scores_jp   ON scores(jp_paid     DESC) WHERE flagged = 0;

CREATE TABLE transfer_codes (
  code_hash   TEXT    PRIMARY KEY,
  user_id     TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  used_at     INTEGER                      -- NULL なら未使用
);
CREATE INDEX idx_transfer_expires ON transfer_codes(expires_at);
```

**保存しないもの**: IP アドレス、User-Agent、メールアドレス、名前。
rate limit のキーに IP を使いますが、それは binding の中の話で、D1 には書きません。

### 6.2 なぜ `payload` を丸ごと TEXT で持つのか

セーブの中身をカラムに展開したくなりますが、しません。

- **セーブの形はこれからも変わる**。この開発で筐体レイアウトが5回変わり、
  `jp` フィールドが後から生えた前例があります。そのたびに `ALTER TABLE` と
  マイグレーションを積むのは、ミラーの用途に対して重すぎます
- 実測 319 バイト。展開して得られるものが無い
- **一方、ランキングに要る数字だけはカラムが要る**（`ORDER BY` とインデックス）。
  そこは `scores` に切り出します

つまり **「戻すためのデータ = 不透明な blob」「比べるためのデータ = 正規化したカラム」** の2階建てです。
`Wallet` の `run` / `lifetime` と同じ発想です。

### 6.3 マイグレーション運用

```bash
wrangler d1 migrations create medal_web init
wrangler d1 migrations apply medal_web --local     # 開発
wrangler d1 migrations apply medal_web --remote    # 本番（--remote を忘れると本番に当たらない）
```

CI では **`deploy` の前に `--remote` を流します**。逆順にすると、
新しいコードが存在しないカラムを読んで 500 を返す時間帯ができます。

---

## 7. 同期プロトコル

### 7.1 いつ送るか（書き込み量の見積もり）

ここは慎重に決める必要があります。`wallet.onChange` は **メダル1枚ごと**に発火し、
`SaveStore` はそれを 2 秒デバウンスしています。**同じ頻度で D1 に書くと枠が溶けます。**

| | localStorage | D1 |
|---|---|---|
| 契機 | 値の変化 | 値の変化 |
| デバウンス | **2 秒**（`CFG.save.debounceMs`） | **60 秒**（`CFG.sync.debounceMs`、新設） |
| 離脱時 | `pagehide` → `flush()` | `pagehide` → `sendBeacon` |
| 失敗したら | HUD に「保存できていない」 | **黙って捨てる**。次のデバウンスで再送 |

見積もり（無料枠: 書き込み 10万行/日）:

```
1 セッション 20 分 = 60秒デバウンス → 約 20 回同期
1 回の同期 = saves 1行 + scores 1行 + users 1行(last_seen) = 3 行
→ 1 セッション 60 行 → 1 日あたり 約 1,600 セッションまで無料枠に収まる
```

個人プロジェクトとしては十分です。足りなくなったら `users.last_seen_at` の更新を
同期のたびではなく1日1回に間引けば 1/3 になります。

### 7.2 競合

`rev` は **サーバが持つ**単調増加カウンタです。クライアントは
「前回サーバから受け取った `rev`」をそのまま送り返すだけで、自分で数字を作りません
（§15-5。クライアントに単調増加カウンタを持たせると `rev: 2^53` を送られて、
以後どの端末からも上書きできない行ができます）。

```
PUT /api/save { rev: 41, payload: {...} }     ← 前回サーバがくれた値

  サーバの rev == 41 → 保存し、rev を 42 に増やして 200 { rev: 42 }
  サーバの rev != 41 → 409 + サーバ側の { rev, payload } を返す
```

**照合と書き込みは1つの SQL 文で行います**（§16-11）。
「読む → 比べる → 書く」に分けると、同時に届いた2本が両方とも検査を通ります。
本番で `visibilitychange` と `pagehide` の beacon が 1ms 差で届き、実際に両方通りました。

409 を受けたクライアントは **マージして1回だけ再送**します。マージ規則:

| フィールド | 規則 | 理由 |
|---|---|---|
| `lifetime.*`, `best`, `jp.*` | **大きいほう** | 通算記録。減ることは無い |
| `medals`, `run.*`, `fieldStock` | **ローカルを優先** | 今まさに遊んでいる台の状態。サーバの古い値で上書きしたら台が消える |
| `rev` | `max(local, server) + 1` | 次で必ず勝つ |

「localStorage が正」なので、409 は**別端末で遊んだときにしか起きません**。
それでも規則を決めておくのは、決めていないと「大きいほう」を選ぶコードが
`medals` にも適用されて **持ち枚数が勝手に増える**からです。

### 7.3 記録を消す

既存の `onClearData` に1本足します。**論理削除にはしません。**

```js
onClearData: () => {
  SaveStore.clear();
  userId = SaveStore.newUserId();
  ApiClient.deleteUser();     // ← 追加。DELETE /api/user。失敗しても UI は止めない
  ...
}
```

サーバ側は `DELETE FROM users WHERE id = ?` の1文です。
`ON DELETE CASCADE` で `sessions` / `saves` / `scores` / `transfer_codes` が消え、
Cookie は `Max-Age=0` で落とします。

`DESIGN.md §11.10` の教訓をそのまま持ち込みます。

> 消したのに識別子が残るのでは消したことになりません。

`deleted_at` を立てて残す設計にしなかったのはこのためです。
**「消す」と書いたボタンは消さなければいけません。** テストも「書けているか」ではなく
**「D1 から行が消えているか」** を見ます。

---

## 8. ランキングと、信じられない数字 ★

### 8.1 前提を先に認める

「localStorage が正」+「ランキング」を同時に選んだので、
**ランキングに乗る数字は全部プレイヤーの自己申告**です。これは設計の欠陥ではなく、
選んだ構成の必然です。`DESIGN_SECURITY.md §5` が挙げた3案のうち、
案1（入力ログをサーバで再現）は Rapier の浮動小数の環境差で成立しないと既に結論が出ています。

**採るのは案2（統計的な外れ値検出）と案3（検証しないと明示する）の組み合わせです。**

### 8.2 サーバ側でやること —— 「印を付ける」ではなく「頭を押さえる」

`domain/plausibility.ts`。方針は `Wallet.restore` と同じ **「捨てずに直す」**。

ただし重要な訂正が1つあります。初稿では違反を `flagged = 1` で**印を付ける**設計にしていましたが、
**印は「記録を消す」で洗えます**（§15-2）。なので中心に置くのは印ではなく、
**`scores` のカウンタが1回の同期で進める量に上限をかけること**です。

```
scores.lifetime_earned += min( 申告された増分, 許容量 )
                          ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^ ここが本体
```

| # | 判定 | しきい値の根拠 | 違反したら |
|---|---|---|---|
| 1 | 絶対上限 | `CFG.wallet.sanityMax = 9,999,999` | クランプ（`Wallet` と同じ値をサーバにも置く） |
| 2 | **払い出しレート** | `CFG.hopper.maxRate = 50 枚/秒` が物理的な天井 | **許容量まで切り下げる**（+ 連続したら `flagged`） |
| 3 | 通算は減らない | `lifetime.*` は単調増加 | 大きいほうを採る。減少そのものは異常ではない（別端末の古いセーブ） |
| 4 | `wins <= spins` | `Wallet.restore` と同じ | 切り下げ |
| 5 | JP の整合 | `jp.paid <= jp.wins * CFG.jackpot.max(=800) + towerLimit` | 切り下げ |

**順序が意味を持ちます。②は③より先に評価します。** 逆にすると
「大きいほうを採る」が先に走って、レートを見る前に巨大な値が入ります（§15-6）。

### 8.3 許容量は「待っても貯まらない」

分母はすべて**サーバの時計**で測ります。そして初稿の最大の穴はここで塞ぎます。

```
Δt = now − users.last_seen_at              ← クライアントの申告ではない
Δt_有効 = min(Δt, 300秒)                   ← ★ 5分で頭打ち

許容量 = CFG.hopper.maxRate(50) * Δt_有効秒 + 余裕100     →  最大 15,100 枚
scores.play_ms += Δt_有効
```

**`Δt` を 5 分で頭打ちにするのが要点です。**
初稿の §8.3 では「同期を1時間止めてから1時間ぶんを1回で送れば通る」と書きましたが、
頭打ちを入れると **待っても許容量は貯まりません**。
15,100 枚を得るには実際に 5 分待つ必要があり、待った直後の `last_seen_at` は更新されるので、
**持続的な上限は 50枚/秒 —— ゲームの物理的な天井そのもの**に固定されます。

| | 初稿 | 頭打ちを入れた後 |
|---|---|---|
| 1時間放置してから申告 | 18万枚が通る | **15,100 枚まで** |
| 持続的に稼げる上限 | 実質無制限 | **50 枚/秒**（＝ホッパーの物理上限） |
| 現実のプレイ | 1〜3 枚/秒 | 影響なし |

`play_ms` をクライアントに申告させないのが、この設計でいちばん強い部品です。
サーバが測った時間だけは、バンドルを書き換えても増やせません。

### 8.4 それでも残ること（正直に書く）

- **50枚/秒を出し続ける自動化は止まりません。** ホッパー全開と同じ速度なので
  「物理的にありえない」とは言えず、弾く理由がありません。1日回せば 432万枚です
- したがって **通算獲得枚数のような「積み上がる数字」はランキングに向きません。**
  ランキングに載せるのは `best_medals`（最高持ち枚数、一発勝負）にします。
  こちらは1セッションの上限が効くので、時間を掛けても伸びません
- `DESIGN_SECURITY.md §2.3` と同じ性質です。潰したのは手軽さであって、可能性ではありません

### 8.5 ランキングの見せ方 ★初稿から変更

初稿は「名前が要らないのでパーセンタイルが安全」と書きましたが、**これは逆でした**。
パーセンタイルの分母は `scores` の行数で、**行はタダで作れます**（§15-1）。
1万件の `best_medals = 0` を投入すれば、自分の実力に関係なく「上位 0.01%」が出ます。
**トップ10より攻撃しやすい**というのが正しい評価です。

分母を守るために、**ランキング参加資格**を入れます。

```
資格 = サーバが測った play_ms >= 30分
       かつ 同期のあった日が 3日以上（サーバの日付で数える）
       かつ flagged = 0
```

どちらも `play_ms` と同じで **サーバの時計でしか進まない**ので、
1万アカウントを資格まで育てるには1万アカウントぶんの実時間が要ります。
Sybil のコストがゼロから「数日 × アカウント数」に上がります。
登録そのものにも Turnstile を1回だけ挟みます（§15-3）。

| 案 | 判断 |
|---|---|
| **パーセンタイル（資格つき）** | 採用。ただし「名前が要らないから安全」ではなく「**資格で分母を守るから**成立する」 |
| 名前つきトップ10 | 第2段階。`DESIGN_SECURITY.md §4` の「ユーザー入力の表示箇所なし」が終わる。長さ制限・禁止語・通報を用意してから |
| 「検証していません」と明記 | **必ずやる**。`DESIGN_SECURITY.md §5` の案3 |

母数が `30` 未満の間は「集計中」とだけ出して数字を見せません。

クエリは**毎回スキャンしません**（§15-7。10万人で1リクエスト20万行読み、無料枠を数百回で使い切ります）。
Cron Trigger で 10 分おきに 100 段の分布表を作り、参照はそこへの 1 行引きにします。

```sql
CREATE TABLE score_histogram (   -- 0002_histogram.sql
  bucket     INTEGER PRIMARY KEY,   -- best_medals を対数で 100 段に割る
  cum_count  INTEGER NOT NULL,      -- この段以下の累積人数（資格つきのみ）
  built_at   INTEGER NOT NULL
);
```

---

## 9. クライアント側の差分

触るファイルは4つ、既存の改造は2つだけです。

| ファイル | 内容 |
|---|---|
| `src/net/ApiClient.js` | 新規。`fetch` / `sendBeacon` を知るのはここだけ。全メソッドが失敗しても投げずに `false` を返す |
| `src/net/SyncStore.js` | 新規。60秒デバウンス、`rev` の管理、409 のマージ（§7.2） |
| `src/save/SaveStore.js` | **追加のみ**。`save()` / `flush()` / `clear()` の中で `this.sink?.push(state)` を呼ぶ。sink は差し込まれなければ何もしない |
| `src/main.js` | 起動時に `SaveStore.sink = new SyncStore(...)` を1行。`snapshot()` に `server` フィールドを足す |
| UI（`store.ts` / `StatsPanel`） | 「未同期」表示（`saveError` と同じ扱い）と、パーセンタイル表示 |
| `GameOverOverlay` | 「引き継ぎコードを出す / 入れる」導線 |

**`Wallet` / 物理 / 演出 / `Jackpot` は1行も変えません。**
`main.js` が同期の存在を知るのは `SaveStore.sink = ...` の1行だけで、
これは `mountUI` の裏に UI を隠しているのと同じ構造です（`DESIGN.md §6.5`）。

---

## 10. 設定とデプロイ

### wrangler.jsonc

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "medal-web",
  "main": "src/server/index.ts",
  "compatibility_date": "2026-09-10",

  "assets": {
    "directory": "./dist",
    "binding": "ASSETS",
    "not_found_handling": "single-page-application",
    // ここが要点。3.7MB の JS と 7.1MB の mp4 で Worker を起動しない
    "run_worker_first": ["/api/*"]
  },

  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "medal_web",
      "database_id": "<wrangler d1 create の出力>",
      "migrations_dir": "migrations"
    }
  ],

  "ratelimits": [
    { "name": "API_LIMITER",      "namespace_id": "1001",
      "simple": { "limit": 60, "period": 60 } },
    { "name": "TRANSFER_LIMITER", "namespace_id": "1002",
      "simple": { "limit": 10, "period": 60 } }
  ],

  "vars": { "ENVIRONMENT": "production" },
  "observability": { "enabled": true }
}
```

### 開発

`@cloudflare/vite-plugin` を試しましたが、**採用しませんでした**（§16-10）。
プラグインは出力を `dist/client` と `dist/<worker名>` に組み替えるので、
`assets.directory: "./dist"` が合わなくなり、GitHub Pages へのフォールバックも壊れます。

代わりに **Vite の dev プロキシ**で `/api` を `wrangler dev` に転がします。
`vite build` の出力は今日とまったく同じままで、ブラウザから見ても同一オリジンなので
Cookie もそのまま通ります。代わりに開発中は2プロセス要ります。

```bash
npm i hono
npm i -D wrangler @cloudflare/workers-types
npx wrangler d1 create medal_web     # 出た database_id を wrangler.jsonc に貼る
npm run db:migrate                   # ローカル D1 にスキーマを当てる

npm run dev:api                      # 端末1: wrangler dev (:8787)
npm run dev                          # 端末2: vite (:5173、/api は :8787 へ)
```

### CI

`.github/workflows/deploy-pages.yml` を `deploy-workers.yml` に置き換えます。

```
checkout → npm ci → npm run typecheck → npm run build
        → wrangler d1 migrations apply medal_web --remote   ← deploy より前
        → wrangler deploy
```

必要な GitHub Secret は `CLOUDFLARE_API_TOKEN` と `CLOUDFLARE_ACCOUNT_ID` の2つです。

**GitHub Pages のワークフローは、しばらく消さずに残します。** Workers 側で事故ったときに
「静的だけは生きている URL」があるのは安いので、切り替えが安定するまで両方流します。

---

## 11. コスト

| | 無料枠 | 本設計の消費 |
|---|---|---|
| Worker 呼び出し | 10万/日 | API のみ。1セッション約 25 回 → 約 4,000 セッション/日 |
| D1 書き込み | 10万行/日 | 1セッション 60 行 → 約 1,600 セッション/日 ← **ここが最初に詰まる** |
| D1 読み取り | 500万行/日 | 同期は PK 引き数行。ランキングは分布表への **1 行引き**（§8.5）。**毎回スキャンする初稿の案だと 1万人で 250 リクエスト/日で枯れる** |
| D1 容量 | 500 MB | 1 user 約 1KB → 50万人 |
| アセット配信 | 無制限 | 12MB × PV |

**無料枠のまま運用できます。** 詰まるとしたら D1 の書き込みで、
そのときの手は「同期デバウンスを 60秒 → 180秒」「`users.last_seen_at` の更新を間引く」の順です。

---

## 12. 実装フェーズ

| # | やること | 検証 |
|---|---|---|
| 1 | Workers Static Assets に載せ替える。API はまだ無い | 今と同じように遊べる。mp4 が再生される。`dist` の配信で Worker が起動していない |
| 2 | ミドルウェア連鎖 + `GET /api/health` だけ | 429 が返る。500 でスタックが漏れない。`X-Request-Id` が付く。**`sendBeacon` が `Origin` を送るか実測**（§15-13。送らないなら CSRF 防御が1枚になる） |
| 3 | D1 + identity + `PUT /api/save` | Cookie が付く。2回目の同期で行が増えない（UPSERT） |
| 4 | `DELETE /api/user` | **D1 から行が消えている**ことを SQL で確認（§7.3） |
| 5 | 引き継ぎコード | 別ブラウザで通算記録が復元される。同じコードが2回使えない |
| 6 | `plausibility`（上限クランプ） | `payload` に 1e9 を入れても `scores` が許容量ぶんしか進まない。**1時間待ってから送っても 15,100 枚で頭打ち**（§8.3）。正常なプレイでは一度もクランプされない |
| 7 | 登録に Turnstile + 参加資格 + 分布表 | スクリプトで 100 アカウント作れない。資格未達の行がパーセンタイルの分母に入らない（§8.5） |

**フェーズ1と4を先に通すのが重要**です。1は「今より悪くなっていないこと」の確認で、
4は「消せること」の確認。どちらも後回しにすると取り返しがつきません。

---

## 13. あえてやらないこと

| 案 | やらない理由 |
|---|---|
| **セーブの完全なサーバ権威化** | ネットが切れた瞬間にゲームが止まる。物理も抽選もクライアントにある以上、権威にしたところで数字を検証できるわけでもない。**止まるデメリットだけを買うことになる** |
| **入力ログの再現によるリプレイ検証** | `DESIGN_SECURITY.md §5` の案1。Rapier は決定的に回せるが浮動小数の環境差でずれる。重い |
| **`zod`** | 検証したいのが「非負整数か・上限内か」だけ。`Wallet.uint()` を server 側に写すほうが軽く、しきい値がゲーム本体と同じ場所（`CFG`）を向く |
| **ORM（Drizzle 等）** | テーブル5つ、クエリ10本程度。スキーマ定義を二重に持つコストのほうが高い |
| **KV でのセッションキャッシュ** | D1 の `sessions` を毎回引くのは 1 行の PK 参照。KV を足すと「消したのに消えていない」経路が増える（§7.3 と正面から衝突する） |
| ~~**CSP**~~ | ~~優先度が低い~~ → **やることに変更**（§15-8）。認証 Cookie を持った時点で XSS の価値が上がった。外部スクリプトを読んでいないので `script-src 'self' 'wasm-unsafe-eval'` がそのまま入る |
| **名前つきランキングを第1段階に入れる** | ユーザー入力の表示がゼロという現状（`DESIGN_SECURITY.md §4`）を、パーセンタイルで代替できるうちは崩さない |
| **Durable Objects** | リアルタイム対戦も共有状態も無い。1リクエスト1ユーザーで完結する |

---

## 14. 未決

1. **カスタムドメイン**を当てるか（`*.workers.dev` のままでも動く）
2. **ランキングの母数がしばらく1人**である問題。§8.4 の「30人未満は集計中」で逃げているが、
   実質ずっと集計中になる可能性がある。自分の過去最高との比較を先に出すほうが良いかもしれない
3. `sessions.expires_at` の**掃除**。Cron Trigger で1日1回消すか、参照時に遅延削除するか

---

## 15. セキュリティレビュー（2026-09-10、初稿に対して）

初稿を攻撃側から読み直した結果です。**推奨が2箇所（§8.4 と §8.3）間違っていた**ので、
本文をそれぞれ §8.5 / §8.3 に書き直してあります。ここには「何が見つかったか」を残します。

`DESIGN_SECURITY.md §0` の前提はサーバを足しても変わりません。
**物理も抽選もクライアントにあるので、チートは原理的に防げません。**
以下は「防いだ」という主張ではなく、**新しく作ってしまった穴を塞いだ記録**です。

### 15.1 致命的 —— 設計を変えたもの

#### 1. Sybil でランキングの分母を作れる（初稿 §8.4 の推奨が逆だった）

`PUT /api/save` は Cookie 無しでも通り（`ensure` モード）、その場でユーザーを作ります。
**アカウントはタダで無限に作れます。**

```
攻撃: best_medals = 0 のユーザーを 1万件作る
結果: 自分の実スコアが「上位 0.01%」になる
```

初稿は「パーセンタイルは名前が要らないから安全」と書きましたが、
**パーセンタイルは分母が攻撃対象**なので、むしろトップ10より脆いという評価が正しいです。

→ **対策**: §8.5 の**参加資格**（サーバ実測 `play_ms >= 30分` かつ同期のあった日が3日以上）。
サーバの時計でしか進まないので、1万アカウントを育てるには1万アカウントぶんの実時間が要ります。

#### 2. 「記録を消す」が `flagged` のロンダリングになる（§7.3 と §8.2 の正面衝突）

`flagged = 1` を立てても、`DELETE /api/user` を押せば行ごと消えて綺麗な状態に戻れます。
そして §7.3 は「**消すと書いたボタンは消さなければいけない**」と決めているので、
墓標（削除済みハッシュ）を残す解決は取れません。**プライバシーと不正検出が正面から衝突します。**

→ **対策**: プライバシーを優先し、**`flagged` に頼るのをやめました**。
§8.2 の中心を「印を付ける」から「**1回の同期で進める量に上限をかける**」に変更しています。
上限はカウンタそのものに掛かるので、消して作り直しても最初からやり直しになるだけです。
資格（§8.5）も同じ性質なので、**消して逃げるコストと Sybil のコストが同じ**になります。
1つの対策で2つの穴が塞がるのは偶然ではなく、どちらも「サーバの実時間」を土台にしたからです。

#### 3. 無認証の登録が D1 書き込み枠を焼く（可用性）

無料枠は書き込み 10万行/日。1リクエスト3行なので、**約 33,000 リクエストで全員の同期が止まります**。
`ratelimits` binding は §4.3 の通り **ロケーションごと・permissive** なので、
IP を散らされると実効上限はずっと高くなります。

→ **対策**: **登録の経路にだけ Turnstile** を1回挟みます（無料プランで検証リクエスト無制限、
ウィジェット20個まで）。ゲーム中の同期には挟みません。
併せて `users` への INSERT を D1 側の実カウンタで日次上限にかけます。

### 15.2 高 —— 実装前に必ず直すもの

| # | 内容 | 対策 |
|---|---|---|
| 4 | **引き継ぎ後のマージでアカウントを合成できる**。端末Aで user_1 の記録を持ったまま user_2 のコードを redeem し、409 のマージ規則（大きいほう）を踏ませると user_2 に user_1 の通算が合流する | redeem 時は **localStorage をサーバ値で置換**（マージしない）。加えて §8.2 の上限がカウンタ側に効くので合流分は入らない |
| 5 | **`rev` がクライアント制御**。`rev: 2^53` を送られると以後どの端末からも上書きできない行ができる（自分自身も直せない） | **`rev` はサーバが持つ**。クライアントは受け取った値を返すだけ（§7.2 修正済み） |
| 6 | **§8.2 のルール2と4が矛盾**していた。「大きいほうを採る」が先に走るとレート判定の前に巨大値が入る | 評価順を明示（レート → 単調性）。§8.2 修正済み |
| 7 | **ランキングのクエリが O(n) 行読み取り**。1万人で1リクエスト約2万行 → 無料枠 500万行/日を **250 リクエストで使い切る**。DoS 以前に運用できない | Cron で 100 段の分布表を作り、参照は 1 行引き（§8.5 修正済み） |

### 15.3 中 —— 決め切れていなかったもの

| # | 内容 | 決めたこと |
|---|---|---|
| 8 | **`HttpOnly` は盗難を防ぐが「使用」は防がない**。同一オリジンで JS を走らせられる者は Cookie を読めなくても使える。Cookie を導入した時点で XSS の価値が上がった | §13 で CSP を「第2段階」に置いていたが、**優先度を上げる**。現状 `innerHTML` も外部スクリプトも無いので（`DESIGN_SECURITY.md §4`）、`script-src 'self' 'wasm-unsafe-eval'` で今すぐ入る |
| 9 | 本文サイズ上限が数値になっていなかった | `Content-Length > 8KB` を **`c.req.json()` の前に** 弾く（実測 319 バイトに対して十分な余裕）。Workers は 100MB まで受けるので、パースさせると無料枠 10ms の CPU が飛ぶ |
| 10 | `identity` が `expires_at` を見る、と書いていなかった | `WHERE token_hash = ? AND expires_at > ?`。期限切れは 401 |
| 11 | 引き継ぎコードのエントロピーが未定義（「8文字」としか書いていない） | Crockford Base32 の 8 文字 = **40 bit**。10分・1回限り・404 統一なら総当たりに耐える。**ハッシュ化保存は必須**（40 bit は D1 が漏れたら総当たりできる） |
| 12 | SQL の書き方をルールにしていなかった | `db/` では **prepared statement + `bind()` のみ**。文字列連結を禁止。`payload` は `JSON.parse` 後に**既知キーだけ拾う**（`Wallet._byId` と同じ方針）。展開に `{...payload}` を使わない |

### 15.4 要実測 —— 前提が崩れると防御が1枚減るもの

| # | 内容 |
|---|---|
| 13 | **`sendBeacon` が `Origin` を送るか**。Fetch 仕様は GET/HEAD 以外に `Origin` を付けるので送るはずだが、**仕様文面から確証が取れなかった**。§4.5 の CSRF 防御はこれと `SameSite=Lax` の2枚組で、送られない場合は `SameSite=Lax` の1枚になる。**実装フェーズ2で必ず実測する** |
| 14 | `sendBeacon` に `application/json` の Blob を渡せるのは **同一オリジンだから**。§2 で別オリジン案を却下した判断が、ここでも効いている。オリジンを分ける改修をするときは §4.5 が壊れる |

### 15.5 確認して問題なかったもの

| 項目 | 結果 |
|---|---|
| 秘密鍵をクライアントに配っていないか | 配っていない。`DESIGN_SECURITY.md §3`「鍵と一緒に配る署名は署名ではない」を踏んでいない ✓ |
| `*.workers.dev` の Cookie 境界 | `workers.dev` は Public Suffix List に載るので、他人の Worker と Cookie を共有しない ✓（独自ドメインに移すときも `Domain=` を付けず host-only を維持すること） |
| 生トークン・生コードの保存 | どちらもハッシュのみ ✓ |
| IP / UA / メールの保存 | 保存しない ✓ |
| 例外メッセージの漏れ | `error.ts` で 500 固定 ✓ |
| API のキャッシュ | `Cache-Control: no-store`。加えて **`Vary: Cookie`** を付ける（Cloudflare 側で取り違えないため） |

### 15.6 このレビューで変わらなかった結論

**ランキングの数字は検証できません。** §8.3 の頭打ちで持続的な上限は
`CFG.hopper.maxRate = 50 枚/秒`（ゲームの物理的な天井）に固定できましたが、
それは「その速度で回し続ける自動化は通る」という意味でもあります。
だから §8.4 で **ランキングに載せるのを `best_medals`（一発勝負）に絞り**、
`lifetime.earned` のような積み上がる数字は載せません。

そして `DESIGN_SECURITY.md §5` の案3 —— **「検証していません」と画面に書く** ——
は、対策をどれだけ積んでも省略しません。

---

## 16. 実装して分かったこと（2026-09-10）

設計どおりに書けなかった箇所と、実際に動かして測った結果です。
`DESIGN.md §11.10` と同じで、**踏んだ落とし穴を残すため**の節です。

### 16.1 設計を変えたもの

| # | 何が起きたか | どう直したか |
|---|---|---|
| 1 | **`try/catch` のエラーミドルウェアが一度も動かなかった。** Hono の `compose` はミドルウェア1枚ごとに try/catch を持ち、内側が投げた時点でその場で `onError` を呼ぶ。外側の `await next()` は reject しない | `app.onError` で登録。応答は投げた深さで作られ、そこから外側の `await next()` の後ろが走るので、**500 にも `security` のヘッダが付く**（狙いは達成。実測で確認） |
| 2 | **Cookie の `Max-Age` は 400 日が上限。** 設計の2年で Hono が例外を投げ、登録が 500 になった | `SESSION_TTL_MS` を 400 日に。400日空いた端末は Cookie を失い、引き継ぎコードが唯一の復帰経路になる（§5.2 に追記） |
| 3 | **Turnstile のトークンを `sendBeacon` に載せられない。** 登録が `PUT /api/save` に混ざっていると §15-3 の対策が掛けられない | 登録を `POST /api/session` に分離。`identity` の `ensure` モードは廃止。遅延登録の性質は「クライアントが必要になってから呼ぶ」で保つ |
| 4 | **`sendBeacon` は POST 固定**でメソッドを選べない | 同じ処理を `POST /api/save/beacon` にも生やした。CSRF 防御（SameSite + Origin）は同じに効く |
| 5 | **Worker が起動時に落ちた。** `config.js` の `if (!import.meta.env.DEV) deepFreeze(CFG)`（`DESIGN_SECURITY.md §2.5`）は workerd に `import.meta.env` が無く TypeError になる | `import.meta.env && import.meta.env.DEV` に。ブラウザ側の挙動は変わらない。Worker は CFG を読むだけなので凍結されて困らない |
| 6 | ★ **上限に当たったことを印の条件にすると、正直なプレイヤーに `flagged` が立つ。** オフラインで20分遊んでから初回同期すると当たり前に当たる | 印の条件をクランプから切り離し、「そのアカウントの一生ぶんを積んでも届かない」量（`absurdThreshold`）に変更。**クランプが本体で印はおまけ**という §8.2 の力関係からしてもこちらが正しい |
| 7 | **登録が原子的でなかった。** Cookie 発行で例外が出たとき、`users` と `sessions` の行だけが残った（実際に孤児が発生） | Cookie を先に積み、`users` + `sessions` を `db.batch()` で一緒に作る。逆順で失敗しても「セッションの無い Cookie」= 次で 401 になって作り直されるだけ |
| 8 | ★ **登録に成功しても `server.userId` が localStorage に書き戻らず、リロードのたびに新しいユーザーを作っていた。** §15-3 で塞いだはずの「書き込み枠を焼く」経路を自分で開けていた（実測で3回の再登録を観測） | `SyncStore` に `onIdentity` を足し、識別子が変わったときだけ `persist()` を呼ぶ。**`rev` の変化では呼ばない** —— 呼ぶと「保存→同期→保存」の輪ができて、誰も遊んでいないのに書き込みが止まらなくなる |
| 9 | **401 から復帰できなかった。** 別端末で「記録を消す」を押されたり Cookie が切れたりすると、死んだ ID で PUT を撃ち続ける | 401 を受けたら identity を捨てて、次の同期で登録し直す |
| 10 | **`@cloudflare/vite-plugin` が出力を `dist/client` と `dist/<worker名>` に組み替える。** `assets.directory: "./dist"` が合わなくなり、Pages へのフォールバックも壊れる | プラグインをやめ、Vite の dev プロキシで `/api` を `wrangler dev` に転がす。`vite build` の出力は今日とまったく同じ（§10） |
| 11 | ★ **`rev` の照合がアトミックでなかった。** 本番で `visibilitychange` と `pagehide` の両方から `sendBeacon` が飛び、**1ms 差で2本**が届いた。ハンドラが「読む→比べる→書く」に分かれていたため両方が `rev=1` を読んで両方が通り、両方が書いた（`rev` が 3 ではなく 2 で止まったのが証拠）。**2端末が同時に同期すると 409 を返さずに片方が黙って消える** —— §7.2 が防ぐはずのケースそのもの | 書き込みを `INSERT ... ON CONFLICT DO UPDATE ... WHERE saves.rev = ?` の**1文**にした。SQLite が1文の中で評価するので同時に来ても片方しか通らない。事前の読みは「サーバ側の payload を返してマージさせる」ための親切な経路として残し、**競合の検査そのものは SQL 側**に移した |

### 16.2 実測

`wrangler dev` + ローカル D1 に対して実際に叩いた結果です。

| 試したこと | 結果 |
|---|---|
| `GET /api/health` | 200。`X-Request-Id` / `nosniff` / `DENY` / `no-referrer` / `no-store` / `Vary: Cookie` が全部付く ✓ |
| Cookie 無しで `PUT /api/save` | `{"error":"no_session"}` **401**。エラー応答にもセキュリティヘッダが付く ✓ |
| 登録 | `HttpOnly; Secure; SameSite=Lax; Path=/` ✓。ページから `document.cookie` → **`""`**（HttpOnly が効いている）✓ |
| `rev` の競合 | 古い `rev` で 409 + サーバ側の `{rev, payload}` を返す ✓ |
| **登録直後に `earned: 1200` を申告** | **127 だけ加算**（許容量 = 50枚/秒 × 0.547秒 + 100）✓ |
| 同じ申告を数回くり返す | 1200 に追いつき、**`strikes: 0`**（正直なプレイヤーが誤爆しない）✓ |
| **`earned` / `best` に 1e9 を3回** | `lifetime_earned` **2299**、`best_medals` **2599**、`flagged: 1` ✓ |
| ↑ `best` が 2599 で止まる理由 | `best ≤ CFG.wallet.start(300) + earned(2299)`。**レートの頭を押さえた結果が、そのままランキングの数字を縛っている**（§8.2 ②の狙いどおり）✓ |
| 8KB 超の本文 | **413**。`json()` を呼ぶ前に落ちる ✓ |
| `Origin: https://evil.example` で PUT | **403** `bad_origin` ✓ |
| 引き継ぎコードを小文字・ハイフン無しで入力 | 通る（正規化が効く）✓ |
| 同じコードをもう一度 / 存在しないコード | **どちらも同じ 404** `bad_code` ✓ |
| 引き継ぎ後 | 1 user に session 2行。両方の端末が使える ✓ |
| **`DELETE /api/user`** | `saves` / `scores` / `transfer_codes` が **0 件**。Cookie は `Max-Age=0`。旧トークンは 401 ✓ |
| cron（`/cdn-cgi/handler/scheduled`） | 分布表 78 行、`total` 40（資格を満たした 40 人と一致）✓ |
| 母数 29 人 | `{"status":"building"}` —— **数字を見せない** ✓ |
| 資格を満たしたユーザー | `{"status":"ok","topPercent":77.5,"population":40,"unverified":true}` ✓ |
| 資格未達 | `{"status":"ineligible","needPlayMs":...,"needDays":2}` ✓ |
| `_headers` | wrangler が `✨ Parsed 2 valid header rules` と表示。CSP が静的側に付く ✓ |
| ゲーム本体 | 起動・投入・描画・音とも変化なし。コンソールの警告は元からある WebGL のものだけ ✓ |
| `npm audit --omit=dev` | **0 件**（`hono` 追加後）✓ |
| バンドル | 3,714KB → **3,724KB**（+10KB。`src/net/` のぶん） |

### 16.3 設計のまま通ったもの

`run_worker_first` による Worker 起動の抑制、D1 のスキーマとカスケード削除、
`payload` を不透明な blob として持つ判断、`rev` をサーバが持つ形、
参加資格による分母の保護、Cookie 方針、`db/` に SQL を閉じ込める構造は
そのまま動きました。**`Wallet` / 物理 / 演出 / `Jackpot` は1行も変えていません。**

### 16.4 本番（`medal-web.r0venloy.workers.dev`）で実測

`wrangler tail` は**実際のリクエストヘッダを出す**ので、これで未検証だった前提を潰しました。

| 試したこと | 結果 |
|---|---|
| ★ **`sendBeacon` は `Origin` を送るか**（§15-13 / §16.4-1 だった宿題） | **送る。** 別オリジン（`http://localhost:5173`）からの beacon が `origin: http://localhost:5173` / `sec-fetch-site: cross-site` を伴って届き、**403 `bad_origin`** で弾かれた。§4.5 の CSRF 防御は2枚とも機能している |
| 同一オリジンの `pagehide` beacon | **200**、`content-type: application/json`、`origin: https://medal-web.r0venloy.workers.dev`。**JSON の Blob を送れているのは同一オリジンだからで**（§15-14）、オリジンを分ける構成にすればここが壊れる |
| CSP（`public/_headers`） | HTML の応答に付いている。**CSP 下で Rapier の WASM も動画も正常に動く** ✓ |
| 本番ビルドの防御 | `typeof window.game === 'undefined'` ✓（`DESIGN_SECURITY.md §2.2` が維持されている）、`document.cookie` は `""` ✓ |
| ハッシュ付きアセット | `Cache-Control: public, max-age=31536000, immutable` ✓ |
| ブラウザからの初回同期 | `POST /api/session` → `PUT /api/save` が**各1回**。D1 に users/sessions/saves/scores が 1 行ずつ。`play_ms` はサーバ実測 ✓ |
| ★ **同じ `rev` で PUT を2本同時** | 修正前: 両方 200（＝競合を検出できていない）。修正後: **200 が1本、409 が1本**。409 には勝者の payload が乗るのでマージできる ✓ |

### 16.5 まだ試していないこと

| # | 内容 |
|---|---|
| 1 | **Turnstile を有効にした状態**。`TURNSTILE_SECRET` 未設定で素通しする経路しか通していない。**未設定のあいだは §15-1 の Sybil と §15-3 の書き込み枠 DoS が開いたまま** |
| 2 | **`ratelimits` binding の 429**。実際に上限まで叩いていない |
| 3 | **ランキングが `status: 'ok'` になる状態**。資格（30分 + 3日）を満たす実データがまだ無い |
| 4 | **cron の本番動作**。`*/10 * * * *` で登録済みだが、分布表が作られたことを本番では確認していない |
