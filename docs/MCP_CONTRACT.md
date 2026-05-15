# GAgent MCP Contract

GAgent exposes the same operational surface to MCP clients that shell users get through the CLI.
The server name is `gagent`, version `0.1.0`.

## Auth And Scopes

The MCP server supports scope checks internally:

| Scope | Tools |
| --- | --- |
| Read | `gagent_health`, `gagent_brain_search`, `gagent_get_receipts`, `gagent_get_drift`, `gagent_get_cost_stats`, `gagent_models`, `gagent_get_models`, `gagent_tier`, `gagent_get_tier_metrics`, `gagent_registry` |
| Write | `gagent_run`, `gagent_config_set` |

Deployments that wrap the MCP server should enforce caller identity before granting write scope.

## Tools

### `gagent_run`

Runs a task through the pipeline.

```json
{
  "task": "string",
  "parallel": 3,
  "verify": true,
  "cognitive_check": false,
  "learn": false,
  "full": false,
  "dry_run": false,
  "budget_usd": 1.0
}
```

Returns the pipeline result and persists a receipt when execution is not a dry run.

### `gagent_health`

Returns stack health and internal health score. Input is `{}`.

### `gagent_brain_search`

```json
{ "query": "string" }
```

Queries GBrain through the configured endpoint. If GBrain is unavailable, the tool returns a
structured error rather than failing the MCP server process.

### `gagent_stack_review`

```json
{ "path": "string" }
```

Delegates review to GStack for the provided path.

### `gagent_config_get` and `gagent_config_set`

Read and write configuration values. Writes are privileged and should be audited by the host.

### `gagent_get_receipts`

```json
{
  "limit": 25,
  "offset": 0,
  "start_date": "2026-05-01T00:00:00.000Z",
  "end_date": "2026-05-15T23:59:59.999Z"
}
```

Returns recent or filtered receipts.

### `gagent_get_drift`

```json
{ "metric_name": "overall_score" }
```

Returns drift analysis for one metric or all tracked metrics.

### `gagent_get_cost_stats`

Returns budget reservations, committed spend, expired reservations, and remaining budget.

### `gagent_models`, `gagent_get_models`, `gagent_tier`, `gagent_get_tier_metrics`

Return configured model tiers and runtime escalation metrics.

### `gagent_registry`

Returns registered stack tools and availability information.

## Error Contract

Errors should include:

- `error`: human-readable message.
- `code`: stable machine-readable code when possible.
- `retryable`: whether the caller should retry.

Network failures to external stack tools are retryable only when the underlying client marks them
retryable. Validation failures and missing required fields are not retryable.

## Compatibility Tests

Run:

```bash
npm run check:mcp-contract
npm test -- test/mcp.test.ts
```

The quality gate verifies expected tool names in `src/mcp/server.ts`.
