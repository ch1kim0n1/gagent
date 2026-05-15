CREATE TABLE IF NOT EXISTS escalation_metrics (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS llm_call_history (
  id TEXT PRIMARY KEY,
  model_id TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  operation TEXT,
  timestamp TEXT NOT NULL,
  metadata_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_llm_call_history_timestamp ON llm_call_history(timestamp);

CREATE TABLE IF NOT EXISTS cost_ledger (
  id TEXT PRIMARY KEY,
  operation TEXT NOT NULL,
  model_id TEXT,
  cost_usd REAL NOT NULL DEFAULT 0,
  timestamp TEXT NOT NULL,
  metadata_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_cost_ledger_timestamp ON cost_ledger(timestamp);
