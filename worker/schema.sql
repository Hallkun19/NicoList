DROP TABLE IF EXISTS shared_lists;

CREATE TABLE shared_lists (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  created_at INTEGER DEFAULT (unixepoch())
);

CREATE INDEX idx_shared_lists_created_at ON shared_lists(created_at);

-- レートリミット用テーブル
DROP TABLE IF EXISTS rate_limits;

CREATE TABLE rate_limits (
  ip TEXT NOT NULL,
  ts INTEGER NOT NULL
);

CREATE INDEX idx_rate_limits_ip_ts ON rate_limits(ip, ts);
