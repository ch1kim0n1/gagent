# GAgent Runbook

## Overview
GAgent is an orchestration pipeline that executes tasks through the G-Stack with parallel attempts, verification, and cognitive checks.

## Quick Start

### Installation
```bash
cd gagent
npm install
npm run build
```

### Basic Usage
```bash
# Run a task
gagent run "Implement a REST API endpoint"

# Run with verification
gagent run "Fix the bug" --verify

# Run full pipeline
gagent run "Add feature" --full
```

## Operations

### Task Execution
**Command:** `gagent run <task> [options]`

**Purpose:** Execute a task through the GAgent pipeline.

**Parameters:**
- `--parallel N`: Number of parallel attempts (default: 1)
- `--verify`: Run GMirror verification
- `--cognitive-check`: Run GToM authenticity check
- `--learn`: Capture to GLearn
- `--full`: Run full pipeline (parallel + verify + check + learn)
- `--dry-run`: Simulate without execution

**Example:**
```bash
gagent run "Implement user authentication" --parallel 3 --verify --cognitive-check
```

**Output Schema:**
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

### Health Check
**Command:** `gagent health`

**Purpose:** Check health of all tools in the stack.

**Output:**
```
GAgent Health Check
Status: healthy
Components:
  Tool Registry: ✓
  GOrchestrator: ✓
  GStack: ✓
  GMirror: ✓
  GToM: ✓
  GLearn: ✓
```

### Evaluation Mode
**Command:** `gagent eval [options]`

**Purpose:** Run evaluation on pipeline performance.

**Parameters:**
- `-c, --corpus`: Path to test corpus JSON
- `--cycles N`: Number of cycles for statistical comparison (default: 1)
- `-o, --output`: Write output to file

### Statistics
**Command:** `gagent stats`

**Purpose:** Show statistics from recent pipeline runs.

### Drift Detection
**Command:** `gagent drift`

**Purpose:** Check for performance drift over time.

## Troubleshooting

### No Winner Selected
**Symptom:** Pipeline completes but no winner is selected

**Solution:**
- Check if all attempts failed
- Review attempt results for errors
- Increase parallel attempts for better chances

### Verification Failures
**Symptom:** Execution succeeds but verification fails

**Solution:**
- Review GMirror failure modes
- Check GToM authenticity issues
- Adjust task prompt for better alignment

### High Latency
**Symptom:** Pipeline takes > 60 seconds

**Solution:**
- Reduce parallel attempts
- Skip verification for non-critical tasks
- Check individual tool latencies

## Configuration

### Pipeline Options
```json
{
  "task": "string",
  "parallel": 1,
  "verify": false,
  "cognitiveCheck": false,
  "learn": false,
  "dryRun": false
}
```

### Tool Registry
GAgent uses a tool registry to manage available tools:
- GOrchestrator: Code execution
- GStack: Code review
- GMirror: UX verification
- GToM: Authenticity check
- GLearn: Pattern learning

## Integration Points

### GOrchestrator
- Primary execution engine for code tasks
- Handles attempt orchestration

### GStack
- Provides code review for each attempt
- Used for quality assessment

### GMirror
- Verifies UX quality of generated code
- Used in verification phase

### GToM
- Checks for authenticity and manipulation
- Used in cognitive check phase

### GLearn
- Captures patterns from execution
- Used for continuous improvement

### GAgent MCP
- Exposes run, health, brain search, stack review operations
- Primary interface for external agents

## Monitoring

### Key Metrics
- Pipeline success rate
- Average execution time
- Verification pass rate
- Cost per execution

### Alerting Thresholds
- Success rate < 80%: Review tool configuration
- Execution time > 120s: Optimize parallel attempts
- Verification pass rate < 50%: Adjust verification thresholds

## Maintenance

### Daily
- Review pipeline success rates
- Check tool health status

### Weekly
- Run evaluation corpus
- Review cost and latency trends

### Monthly
- Update tool configurations
- Expand tool registry with new capabilities
