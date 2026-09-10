-- DESIGN_SERVER.md §6.1
--
-- 時刻は全部 unix ミリ秒の INTEGER。SQLite に日付型は無い。
-- IP / User-Agent / メール / 名前は保存しない。

PRAGMA foreign_keys = ON;

CREATE TABLE users (
  id            TEXT    PRIMARY KEY,   -- UUIDv4。サーバが生成する
  created_at    INTEGER NOT NULL,
  -- サーバの時計。§8.3 のレート許容量と play_ms の分母になる。
  -- クライアントの申告値をここに入れてはいけない
  last_seen_at  INTEGER NOT NULL
);

-- 端末ごとに1行。生トークンは保存しない (§5.2)
CREATE TABLE sessions (
  token_hash    TEXT    PRIMARY KEY,   -- SHA-256(token) の hex
  user_id       TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    INTEGER NOT NULL,
  last_used_at  INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL       -- identity はここを必ず見る (§15-10)
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

-- localStorage のミラー。1 user 1 行。
-- payload は不透明な blob として扱う (§6.2)。中身の形が変わっても
-- ALTER TABLE が要らないのが利点で、比較に使う数字だけ scores に切り出す
CREATE TABLE saves (
  user_id         TEXT    PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  rev             INTEGER NOT NULL,    -- サーバが持つ (§7.2 / §15-5)
  payload         TEXT    NOT NULL,    -- セーブ JSON をそのまま (実測 319 バイト)
  client_saved_at INTEGER NOT NULL,    -- クライアントの時計。信じない。表示用
  updated_at      INTEGER NOT NULL     -- サーバの時計
);

-- ランキング用の非正規化。
-- ここのカウンタは「1回の同期で進める量」に上限がかかる (§8.2)。
-- 印を付けるのではなく頭を押さえるのが本体で、理由は
-- 「記録を消す」で印が洗えるから (§15-2)
CREATE TABLE scores (
  user_id         TEXT    PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  best_medals     INTEGER NOT NULL DEFAULT 0,
  lifetime_earned INTEGER NOT NULL DEFAULT 0,
  jp_wins         INTEGER NOT NULL DEFAULT 0,
  jp_paid         INTEGER NOT NULL DEFAULT 0,

  -- サーバが測る。クライアントは申告できない。§8.5 の参加資格の土台
  play_ms         INTEGER NOT NULL DEFAULT 0,
  sync_days       INTEGER NOT NULL DEFAULT 0,   -- 同期のあった日数
  last_sync_day   INTEGER NOT NULL DEFAULT -1,  -- epoch からの日数

  -- 分布表のバケット。書き込み時に JS で計算して入れる。
  -- こうしておくと cron 側が log10() 無しで GROUP BY できる
  bucket          INTEGER NOT NULL DEFAULT 0,

  strikes         INTEGER NOT NULL DEFAULT 0,   -- 上限に当たった連続回数
  flagged         INTEGER NOT NULL DEFAULT 0,   -- 1 なら集計から外す
  updated_at      INTEGER NOT NULL
);
-- ランキングは資格を満たした flagged=0 だけを見る
CREATE INDEX idx_scores_bucket ON scores(bucket) WHERE flagged = 0;

CREATE TABLE transfer_codes (
  code_hash   TEXT    PRIMARY KEY,     -- SHA-256(code)。40bit なので必ずハッシュで持つ
  user_id     TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  used_at     INTEGER                  -- NULL なら未使用
);
CREATE INDEX idx_transfer_expires ON transfer_codes(expires_at);

-- 分布表 (§8.5)。参照は1行引きで済ませる
CREATE TABLE score_histogram (
  bucket     INTEGER PRIMARY KEY,
  cum_count  INTEGER NOT NULL,         -- この段以下の累積人数 (資格を満たした人のみ)
  built_at   INTEGER NOT NULL
);

-- 登録数の日次上限 (§15-3)。ratelimits binding はロケーションごとで
-- permissive なので、D1 側に実カウンタを持つ
CREATE TABLE signup_counter (
  day     INTEGER PRIMARY KEY,         -- epoch からの日数
  count   INTEGER NOT NULL
);
