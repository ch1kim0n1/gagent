# GAgent API Overview

This document summarizes the stable public surfaces. Regenerate the browsable TypeScript API with:

```bash
npm run docs:api
```

The generated output is committed under `docs/api`.

## CLI API

| Command | Inputs | Output |
| --- | --- | --- |
| `gagent run <task>` | Task text plus `--parallel`, `--verify`, `--cognitive-check`, `--learn`, `--budget`, `--cycles` | Pipeline result, receipt, persisted run. |
| `gagent health` | Optional config/environment | Health rows for stack tools and internal services. |
| `gagent eval` | Corpus path, cycles, output path | Evaluation report and baseline comparison data. |
| `gagent receipts` | Limit/date filters | Stored execution receipts. |
| `gagent drift` | Optional metric name | Drift detector output. |
| `gagent cost` | Optional detail flags | Budget ledger and model cost summary. |
| `gagent metrics` | Format options | Prometheus or JSON metrics snapshot. |
| `gagent serve` | MCP transport options | Starts the MCP server. |

CLI commands should fail with non-zero exit codes for invalid input, unavailable required state,
or runtime errors. Commands that can degrade, such as `health`, should report component failures
without crashing the entire process.

## TypeScript API

Primary classes:

- `Pipeline` in `src/pipeline/orchestrator.ts`: task execution, health checks, receipts, drift,
  model tiers, and observability exports.
- `GAgentPersistenceManager` in `src/core/gagent-persistence.ts`: SQLite schema and transactional
  state writes.
- `ReceiptRegistry` in `src/core/receipt-registry.ts`: JSONL receipt append/read operations.
- `BudgetLedger` in `src/core/budget-ledger.ts`: budget reservation, commit, expiration, and stats.
- `GAgentObservability` in `src/core/observability.ts`: metrics, traces, audit logs, and health alerts.
- `ToolRegistry` in `src/tools/registry.ts`: local stack tool registration and execution.
- `GAgentMCPServer` in `src/mcp/server.ts`: MCP tool registration and dispatch.

## Pipeline Result Shape

```ts
type PipelineResult = {
  success: boolean;
  winner?: {
    id: string;
    output: string;
    score?: number;
  };
  attempts?: Array<{
    id: string;
    output: string;
    score?: number;
  }>;
  error?: string;
};
```

## Receipt Contract

Receipts include:

- `receipt_id`, `schema_version`, `timestamp`, and `project`.
- Input and config hashes for reproducibility.
- Models used, score dimensions, verdict, cost, and hard-gate status.
- Metadata for task flags, consensus, Wilson confidence intervals, and budget state.

Receipts are append-only. Do not mutate historical receipts to repair a run; append a superseding
receipt or create a migration that documents the change.

## Compatibility

The package is versioned with semver. MCP tool names and required input fields are stable within a
major version. New optional fields may be added in minor versions.
