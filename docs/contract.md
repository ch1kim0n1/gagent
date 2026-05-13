# GAgent Contract

## Service Contract
GAgent provides orchestration pipeline capabilities through CLI and MCP interfaces for executing tasks through the G-Stack.

## Interface Definitions

### CLI Interface

#### run
**Command:** `gagent run <task> [options]`

**Input:**
```json
{
  "task": "string",
  "parallel": "number (default: 1)",
  "verify": "boolean",
  "cognitiveCheck": "boolean",
  "learn": "boolean",
  "full": "boolean",
  "dryRun": "boolean"
}
```

**Output:**
```json
{
  "status": "completed|failed",
  "winner": {
    "attempt_id": "string",
    "result": "object"
  },
  "attempts": [
    {
      "attempt_id": "string",
      "status": "success|failed",
      "result": "object"
    }
  ],
  "verification": {
    "gmirror": "pass|fail",
    "gtom": "pass|fail"
  }
}
```

**Error Conditions:**
- Invalid task description → Exit code 1, validation error
- All attempts failed → Exit code 1, no winner
- Tool health check failure → Exit code 1, health error

#### health
**Command:** `gagent health`

**Output:**
```
GAgent Health Check
Status: healthy|degraded
Components:
  Tool Registry: ✓|✗
  GOrchestrator: ✓|✗
  GStack: ✓|✗
  GMirror: ✓|✗
  GToM: ✓|✗
  GLearn: ✓|✗
```

**Exit Codes:** 0 (healthy), 1 (unhealthy)

### MCP Interface

#### gagent_run
**Input:**
```json
{
  "task": "string",
  "parallel": "number (default: 1)",
  "verify": "boolean (default: false)",
  "cognitive_check": "boolean (default: false)",
  "learn": "boolean (default: false)",
  "full": "boolean (default: false)",
  "dry_run": "boolean (default: false)"
}
```

**Output:** PipelineResult object (same as CLI)

#### gagent_health
**Input:** `{}`

**Output:** Health status object

#### gagent_brain_search
**Input:**
```json
{
  "query": "string"
}
```

**Output:**
```json
{
  "results": [
    {
      "id": "string",
      "content": "string",
      "relevance": "number"
    }
  ]
}
```

#### gagent_stack_review
**Input:**
```json
{
  "path": "string"
}
```

**Output:** Code review results

#### gagent_config_get
**Input:**
```json
{
  "key": "string"
}
```

**Output:** Configuration value

#### gagent_config_set
**Input:**
```json
{
  "key": "string",
  "value": "any"
}
```

**Output:** Confirmation

## Data Contracts

### PipelineOptions
```typescript
interface PipelineOptions {
  task: string;
  parallel: number;
  verify: boolean;
  cognitiveCheck: boolean;
  learn: boolean;
  dryRun: boolean;
}
```

### PipelineResult
```typescript
interface PipelineResult {
  success: boolean;
  winner?: AttemptResult;
  attempts?: AttemptResult[];
  error?: string;
}
```

### AttemptResult
```typescript
interface AttemptResult {
  id: string;
  status: 'success' | 'failed';
  result: any;
  latency_ms: number;
}
```

## SLA Guarantees

### Performance
- **P50 Latency:** < 30s for simple tasks
- **P95 Latency:** < 120s for simple tasks
- **P99 Latency:** < 300s for simple tasks
- **Availability:** 99% uptime

### Quality
- **Success Rate:** ≥ 80% for well-defined tasks
- **Verification Pass Rate:** ≥ 70% for generated code
- **Cognitive Check Pass Rate:** ≥ 90%

### Cost
- **Maximum Cost per Execution:** $1.00 (default parallel=1)
- **Cost Transparency:** Full cost breakdown provided

## Error Handling

### Retry Policy
- Transient errors: Up to 3 attempts per tool
- Tool health failures: Fail fast, no retry
- LLM API failures: Retry with different model tier

### Fallback Behavior
- If all attempts fail: Return failure with error details
- If verification fails: Return result with verification status
- If tool unavailable: Skip and continue with available tools

## Versioning

### API Versioning
- Current version: v1
- Backward compatibility: Guaranteed within major version
- Deprecation Policy: 6 months notice

## Security

### Authentication
- CLI: No authentication (local execution)
- MCP: Token-based authentication (Tier 4-5 infrastructure in place)

### Authorization
- Read operations: Any authenticated user
- Write operations: Any authenticated user
- Config changes: Admin role required

### Data Privacy
- Task data not persisted beyond execution
- Generated code stored in GBrain with receipts
- Audit logs retained for 30 days
