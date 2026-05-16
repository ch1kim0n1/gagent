ALTER TABLE agent_runs ADD COLUMN dyad_id TEXT;
ALTER TABLE agent_runs ADD COLUMN message_count INTEGER;

CREATE TABLE IF NOT EXISTS ingestion_checkpoints (
  source TEXT PRIMARY KEY,
  last_rowid INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
