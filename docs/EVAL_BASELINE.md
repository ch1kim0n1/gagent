# GAgent Evaluation Baseline

GAgent evaluates the full agent stack rather than a single model call. The baseline therefore
measures execution success, verification quality, cognitive-check quality, cost, latency, and
receipt completeness.

## Baseline Corpus

Recommended corpus dimensions:

| Dimension | Examples |
| --- | --- |
| CLI task | Initialize config, inspect registry, export metrics. |
| Code task | Small TypeScript edit, test repair, refactor. |
| Verification task | Require `--verify` and validate GMirror output handling. |
| Safety task | Require `--cognitive-check` and validate GToM handling. |
| Learning task | Require `--learn` and validate GLearn capture behavior. |
| Failure task | Missing tool, budget exceeded, GBrain unavailable. |

Each corpus item should include expected command flags, required artifacts, maximum cost, maximum
latency, and pass/fail assertions.

## Running Evaluations

```bash
node dist/cli.js eval --corpus ./test/baselines/gagent-corpus.json --cycles 10 --output ./tmp/eval.json
npm run eval:summary -- --input ./tmp/eval.json
npm run eval:compare -- --baseline ./test/baselines/regression-baselines.jsonl --input ./tmp/eval.json
```

When using the npm wrappers, pass additional arguments after `--`.

## Acceptance Thresholds

| Metric | Target |
| --- | --- |
| Task success rate | `>= 0.80` on well-defined tasks. |
| Verification pass rate | `>= 0.70` when `--verify` is enabled. |
| Cognitive-check pass rate | `>= 0.90` for benign tasks. |
| P95 latency | `< 120s` for simple stack tasks. |
| Cost per default run | `<= $1.00` unless a corpus item raises the budget. |
| Receipt completeness | `100%` of non-dry-run executions. |

## Statistical Rules

- Use at least 10 cycles before declaring a regression fixed.
- Report Wilson confidence intervals for small samples.
- Mark comparisons with fewer than 30 samples as small-sample evidence.
- Treat cost and latency regressions independently from quality regressions.

## Baseline Updates

Update baselines only when behavior intentionally changes:

1. Run the old and new baseline on the same corpus.
2. Confirm no hard gates regressed.
3. Commit the new baseline with a changelog note explaining why it moved.
4. Keep previous baseline files available for release comparison.
