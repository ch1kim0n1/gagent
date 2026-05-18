# GAgent Performance

## SLO/SLI

### Service Level Objectives (SLOs)

| Metric | Target | Measurement Window |
| --- | --- | --- |
| Task success rate | ≥95% | 7-day rolling |
| P50 latency | <5s | 7-day rolling |
| P95 latency | <15s | 7-day rolling |
| P99 latency | <30s | 7-day rolling |
| Error rate | <5% | 7-day rolling |
| Backpressure rejection rate | <1% | 1-hour rolling |

### Service Level Indicators (SLIs)

- **Task success rate**: Percentage of tasks that complete successfully (exit code 0)
- **Latency**: Time from task submission to completion (p50, p95, p99)
- **Error rate**: Percentage of tasks that fail with non-zero exit code
- **Backpressure rejection rate**: Percentage of tasks rejected due to queue depth limits
- **Memory usage**: RSS and heap memory during task execution
- **Cache hit rate**: Percentage of cache hits for GBrain context lookups

### Alerting

Alert when:
- Task success rate falls below 90% (burn rate warning)
- P95 latency exceeds 20s for 5 consecutive minutes
- Backpressure rejection rate exceeds 2% for 10 consecutive minutes
- Memory usage exceeds 80% of available system memory



## SLO And SLI

| SLI | SLO | Measurement |
| --- | --- | --- |
| Pipeline success rate | >= 95% for standard runs | Pipeline results, receipts, and benchmark `success_rate`. |
| Pipeline p95 wall time | <= 30s for standard runs | Receipt latency, benchmark `p95_ms`, and load-test latency. |
| Health p95 latency | <= 200ms | `/health` k6 or Artillery test results. |
| Queue pressure | queued <= 2x `GAGENT_MAX_CONCURRENCY` | `getTaskProcessingStats()`. |
| Memory baseline | RSS <= 256MB for CLI benchmark smoke suite | `gagent benchmark --json` `max_rss_mb`. |

## Benchmarks

```bash
npm run build
node dist/cli.js benchmark --n 10 --json
```

The benchmark records per-run duration, success, heap usage, RSS, p50, and p95 for the local control
plane. Keep CI/release baselines with eval artifacts.

## Load Testing

```bash
k6 run load/k6.js
artillery run load/artillery.yml
```

Set `GAGENT_URL`, `VUS`, and `DURATION` for k6. Artillery target and rates are in
`load/artillery.yml`.

## Backpressure, Streaming, And Cancellation

Pipeline execution uses an overall task limiter configured by `GAGENT_MAX_CONCURRENCY` and
`GAGENT_MAX_QUEUE_DEPTH`. Queue overflow fails fast with a retryable backpressure error. Queued and
in-flight runs accept `AbortSignal`; cancellation is checked between major stages.

Long runs report progress through `execute({ onProgress })` and `executeStream(...)`. Progress phases
are `queued`, `prime`, `plan`, `execute`, `verify`, `cognitive_check`, `select`, `persist`, `learn`,
`complete`, and `cancelled`.

## Caching

GBrain context lookups use an in-process LRU-style TTL cache. Configure TTL with
`GAGENT_CONTEXT_CACHE_TTL_MS`; the default is five minutes.

## Model Resolution

Model choice follows an eight-step resolution chain:

1. Explicit task model
2. Winning GBrain config
3. Task-type default
4. Low-cost fast path
5. Quality escalation
6. Cross-vendor consensus
7. Critical decision
8. Safe fallback
