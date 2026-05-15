# GAgent Data Flow

```mermaid
flowchart LR
  Client["CLI or MCP client"] --> Parser["Command and schema validation"]
  Parser --> Pipeline["Pipeline.execute"]
  Pipeline --> Budget["Budget reservation"]
  Pipeline --> GBrainRead["GBrain context lookup"]
  Pipeline --> Planner["LLM strategy and verification decisions"]
  Planner --> Executor["GStack or GOrchestrator"]
  Executor --> Verifier["GMirror verification"]
  Executor --> Cognitive["GToM cognitive check"]
  Verifier --> Selector["Consensus winner selection"]
  Cognitive --> Selector
  Selector --> GBrainWrite["GBrain record and receipt write"]
  Selector --> GLearn["GLearn capture"]
  Selector --> Receipt["ReceiptRegistry JSONL append"]
  Selector --> SQLite["GAgentPersistenceManager SQLite transaction"]
  Selector --> Metrics["MetricsRegistry"]
  Metrics --> Prometheus["Prometheus text"]
  Metrics --> OTel["OpenTelemetry JSON"]
  Selector --> Audit["Audit JSONL"]
```

## Data Classes

| Data | Source | Destination | Sensitivity |
| --- | --- | --- | --- |
| Task text | CLI/MCP caller | Pipeline, receipts, optional GBrain | Potentially sensitive. |
| Attempt output | Stack tools | Selector, receipts, optional GBrain | Potentially sensitive. |
| Model usage | LLM client | SQLite, metrics, receipts | Operational. |
| Budget reservations | Pipeline | SQLite | Operational. |
| Audit decisions | Pipeline and observability | JSONL audit logs | Operational, may include task metadata. |
| Health data | Stack endpoints | CLI/MCP, metrics | Operational. |

## Persistence Flow

1. A task is validated and budget is reserved.
2. The pipeline gathers context and executes attempts.
3. The selector chooses a winner and computes receipt scores.
4. The receipt is appended to JSONL.
5. SQLite receives run, cost, metrics, and budget updates in transactional writes.
6. Metrics and audit logs are emitted for monitoring.

## Redaction

Logs and audit events should use structured fields and avoid raw prompt bodies unless the event is
explicitly an execution receipt. Redaction must happen before a field is sent to logs, metrics, or
webhooks.
