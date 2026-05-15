CREATE TABLE IF NOT EXISTS agent_runs (
  run_id TEXT PRIMARY KEY,
  task TEXT,
  output TEXT,
  exit_code INTEGER,
  cost_usd REAL,
  timestamp TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_runs_timestamp ON agent_runs(timestamp);
