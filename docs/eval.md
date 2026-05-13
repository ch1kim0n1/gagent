# GAgent Evaluation Documentation

## Evaluation Framework
GAgent evaluates task execution performance through the G-Stack pipeline with parallel attempts, verification, and cognitive checks.

## Evaluation Methodology

### Pipeline Execution
GAgent executes tasks by:
1. Running parallel attempts (configurable number)
2. Selecting the best result based on quality metrics
3. Verifying results through GMirror (UX testing)
4. Checking authenticity through GToM (cognitive verification)
5. Capturing patterns in GLearn for continuous improvement

### Scoring Dimensions

#### Execution Success
- **1.0:** Task completed successfully with all attempts passing
- **0.5:** Some attempts failed but at least one succeeded
- **0.0:** All attempts failed

#### Verification Quality (GMirror)
- **1.0:** All verification checks pass
- **0.5:** Some verification issues but acceptable
- **0.0:** Critical verification failures

#### Cognitive Authenticity (GToM)
- **1.0:** High authenticity, no manipulation detected
- **0.5:** Moderate authenticity, some concerns
- **0.0:** Low authenticity, manipulation detected

### Overall Pipeline Success
- **Success:** At least one attempt succeeds AND verification passes
- **Failed:** All attempts fail OR verification fails critically

## Benchmarking

### Benchmark Corpus
Location: `shared/benchmark-corpus/comparison-v1/`

**Current Benchmarks:**
- `code-generation.json`: Code generation tasks
- `refactor.json`: Code refactoring tasks

**Task Format:**
```json
{
  "id": "task-001",
  "task": "Task description",
  "type": "task-type",
  "parallel": 3,
  "verify": true,
  "cognitiveCheck": true
}
```

### Running Benchmarks
```bash
# Single run
gagent eval -c corpus.json -o results.json

# Multi-run for statistical significance
gagent eval -c corpus.json --cycles 10 -o results.json
```

### Statistical Analysis
Multi-run evaluation provides:
- Mean success rate
- Standard deviation for reliability
- Confidence intervals for success estimates

## Performance Metrics

### Latency
- **Target:** P50 < 30s, P95 < 120s, P99 < 300s (simple tasks)
- **Measurement:** End-to-end pipeline execution time
- **Optimization:** Reduce parallel attempts, skip verification

### Cost
- **Target:** < $1.00 per execution (default parallel=1)
- **Components:**
  - LLM API costs (primary, scales with parallel attempts)
  - Verification costs (GMirror)
  - Cognitive check costs (GToM)

### Quality
- **Success Rate:** ≥ 80% for well-defined tasks
- **Verification Pass Rate:** ≥ 70% for generated code
- **Cognitive Check Pass Rate:** ≥ 90%

## Evaluation Modes

### Simple Execution
**Use case:** Quick task execution without verification
**Configuration:** `--parallel 1`
**Focus:** Speed over quality

### Verified Execution
**Use case:** Code generation requiring UX validation
**Configuration:** `--parallel 3 --verify`
**Focus:** Quality with UX verification

### Full Pipeline
**Use case:** Critical tasks requiring full validation
**Configuration:** `--full` (parallel + verify + cognitive check + learn)
**Focus:** Maximum quality and authenticity

## Cross-Tool Comparison

### Normalized Output
GAgent outputs conform to the normalized output schema:

```typescript
{
  success: boolean,
  score: number (0-1),
  cost_usd: number,
  tokens_used: number,
  llm_calls: number,
  latency_ms: number,
  p50_ms: number,
  p95_ms: number,
  p99_ms: number,
  quality: {
    correctness: number,
    efficiency: number,
    robustness: number,
    clarity: number,
    authenticity: number
  }
}
```

### Comparison with Other Tools
- **GOrchestrator:** Single tool vs. orchestration (complementary)
- **GMirror:** UX verification vs. task execution (sequential)
- **GToM:** Authenticity check vs. full pipeline (component)
- **GLearn:** Pattern capture vs. execution (output)

## Continuous Evaluation

### Automated Evaluation Pipeline
1. **Trigger:** On task submission
2. **Execution:** Run parallel attempts
3. **Verification:** Check quality through GMirror/GToM
4. **Selection:** Choose best result
5. **Capture:** Store patterns in GLearn

### Monitoring
- Track success rates over time
- Alert on degradation in success rate
- Review high-cost executions for optimization

### Improvement
- Regularly calibrate attempt selection criteria
- Expand parallel attempts for complex tasks
- Update verification thresholds based on results
