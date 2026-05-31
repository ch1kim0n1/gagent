# GAgent — Agent-Readable Contract

## Purpose
GAgent is the unified CLI and execution framework for the six-tool agent stack. It manages task execution, receipt tracking (JSONL + SQLite), and optional HMAC-SHA256 signing for tamper detection. Currently it models **developer-productivity tasks** (file operations, shell commands, subagent dispatch). For DYAD it must grow a **streaming/daemon execution mode** — iMessage ingestion from `chat.db` is a continuous feed, not a one-shot request/response.

## Current Core Capabilities
- Execute tasks with configurable parameters and metadata
- Track execution receipts with optional PII redaction
- HMAC-SHA256 signing for tamper detection
- SQLite persistence (`~/.gagent/gagent.db`) with schema_version + migration runner
- JSONL receipt storage (`gagent/test/baselines/receipts-YYYY-Www.jsonl`)
- CLI commands: `eval`, `replay`, `regress`, `trend`, `drift`, `cost`

## API Contract (current)

```typescript
interface ExecutionRequest {
  task: string;
  parameters: Record<string, any>;
  metadata?: Record<string, any>;
}

interface ExecutionReceipt {
  receipt_id: string;
  task: string;
  parameters: Record<string, any>;
  output: string;
  exit_code: number;
  timestamp: string;
  signature?: string;            // HMAC-SHA256 if RECEIPT_SIGNATURE_KEY is set
}
```

### SQLite Schema (current)
```sql
agent_runs (
  run_id      TEXT PRIMARY KEY,
  task        TEXT,
  output      TEXT,
  exit_code   INTEGER,
  cost_usd    REAL,
  timestamp   TEXT
)
```

---

## What Must Change for DYAD

### 1. Streaming / Daemon Execution Mode
DYAD's macOS daemon reads `~/Library/Messages/chat.db` on a polling interval and emits new messages as a stream. GAgent needs a daemon mode that:

```typescript
// New execution mode
interface DaemonExecutionConfig {
  mode: 'daemon';
  source: 'imessage' | 'file_watch' | 'webhook';
  poll_interval_ms: number;      // e.g. 5000
  checkpoint_key: string;        // cursor for resume-from-last-message
  on_message: (msg: RawMessage) => Promise<void>;
  poll?: (lastRowid: number) => Promise<RawMessage[]>;        // BYO source reader
  max_attempts?: number;                                     // retries before dead-letter (default 3)
  on_dead_letter?: (msg: RawMessage, error: unknown) => Promise<void>;
}

// CLI addition needed:
// gagent daemon --source imessage --interval 5000
```

> **Implementation status (BYO-poller):** `DaemonRunner` does **not** ship a
> built-in `chat.db` reader. The caller injects a `poll(lastRowid)` callback
> that returns new messages; `imessage-daemon.ts` is the intended home for a
> concrete iMessage poller. The runner guarantees **at-least-once** delivery:
> the ingestion checkpoint only advances past a message after `on_message`
> succeeds (or, when configured, after `on_dead_letter` accepts it). Failed
> messages are retried with backoff and never silently skipped; `poll()`
> errors are caught and retried so the loop survives transient failures.

**Files to create:** `src/core/daemon-runner.ts`, `src/modes/imessage-daemon.ts`
**File to modify:** `src/cli.ts` — add `daemon` command

### 2. PII Redaction Pipeline
iMessage content is maximally sensitive. GAgent must redact PII **before** any receipt is written or sent to any downstream tool. Add:

```typescript
interface PIIRedactionConfig {
  redact_phone_numbers: boolean;
  redact_names: boolean;           // replace with participant_a / participant_b
  redact_locations: boolean;
  hash_contact_ids: boolean;       // SHA-256 of phone/email so dyad_id is stable but unlinkable
}
```

**Files to create:** `src/core/pii-redactor.ts`
**Wire into:** `src/core/receipt-registry.ts` — redact before `append()`

### 3. SQLite Schema Extension for DYAD
Extend the `agent_runs` table and add DYAD-specific tables:

```sql
-- Extend existing table
ALTER TABLE agent_runs ADD COLUMN dyad_id TEXT;
ALTER TABLE agent_runs ADD COLUMN message_count INTEGER;

-- New table for message cursors (daemon resume)
CREATE TABLE IF NOT EXISTS ingestion_checkpoints (
  source      TEXT PRIMARY KEY,   -- 'imessage', 'file:path'
  last_rowid  INTEGER NOT NULL,   -- last chat.db ROWID processed
  updated_at  TEXT NOT NULL
);
```

**File to modify:** `src/core/gagent-persistence.ts` — add migration `fromVersion < 1` that creates `ingestion_checkpoints` and alters `agent_runs`.

### 4. Ethical Refusal Classifier
DYAD requires a classifier that refuses to generate advice that:
- Pathologizes normal relationship behavior
- Assigns blame to one party without sufficient evidence
- Suggests the user leave a relationship (out of scope)
- Processes messages from minors

```typescript
interface RefusalClassifierResult {
  should_refuse: boolean;
  reason?: 'minor_detected' | 'blame_assignment' | 'out_of_scope' | 'insufficient_data';
  confidence: number;
}
```

**File to create:** `src/core/ethical-refusal-classifier.ts`
**Wire into:** `src/pipeline/orchestrator.ts` — check before any LLM call that produces relationship advice

### 5. DYAD Task Handler
Add a task handler type for DYAD analysis tasks:

```typescript
// New task type
interface DyadAnalysisTask {
  task: 'analyze_relationship_window';
  parameters: {
    dyad_id: string;
    message_window: RawMessage[];
    detectors: Array<'emotion_labeling' | 'bid_classification' | 'repair_detection' | 'labor_asymmetry'>;
    time_range: { start: string; end: string };
  };
}
```

**File to create:** `src/handlers/dyad-analysis-handler.ts`

### 6. Cost Hard Gate
The pipeline enforces a per-run cost hard gate. When a run supplies `budgetUsd`,
that value is the ceiling. When it does **not**, the run is **not** unbounded:
a safe default ceiling (`GAGENT_DEFAULT_RUN_BUDGET_USD`, default **$1.00**) is
enforced instead. Exceeding the ceiling throws:

```typescript
// In src/pipeline/orchestrator.ts (enforceActiveRunBudget)
if (actualCostUsd > this.activeRunBudget.maxCostUsd) {
  throw new Error(`Cost hard gate: $${actualCostUsd.toFixed(4)} exceeds budget $${this.activeRunBudget.maxCostUsd.toFixed(4)}`);
}
```

A separate global `BudgetLedger` (`cost_budget_usd_per_hour`, default $20) caps
cumulative spend per process and also fails closed when exhausted.

---

## Importable API surface
The package builds to a flat `dist/` layout and exposes these subpaths
(all resolve to real built files): `gagent` / `gagent/sdk` (the SDK),
`gagent/pii` & `gagent/PIIRedactor`, `gagent/ethics` & `gagent/EthicalClassifier`,
and `gagent/client`. The `gagent` bin maps to `dist/cli.js`. `dist/` is built by
the `prepack`/`prepublishOnly` hooks so the published tarball always ships code.

## Configuration
- `RECEIPT_SIGNATURE_KEY` / `receipt_signature_key` — optional HMAC key for signing receipts (when set, receipts with a missing/invalid signature are rejected as integrity failures)
- `GAGENT_DB_PATH` — override default `~/.gagent/gagent.db`
- `DYAD_PII_REDACTION` — `true` to enable PII redaction (required for DYAD)
- `GAGENT_DAEMON_INTERVAL_MS` — polling interval for daemon mode
- `GAGENT_DEFAULT_RUN_BUDGET_USD` — default per-run cost ceiling when no `budgetUsd` is supplied (default 1.0)
- `GAGENT_ALLOW_DEV_SECRET` — `true` to allow the insecure default MCP auth secret for local dev only (otherwise auth fails closed)

## Persistence
- SQLite: `~/.gagent/gagent.db` (`GAgentPersistenceManager`)
- Receipts: JSONL per ISO week

## Integration Points
- **Called by:** GOrchestrator (executes sampled configurations), DYAD daemon pipeline
- **Calls:** Receipt registry, SQLite persistence, LLM client, tool registry, ethical refusal classifier (new)
