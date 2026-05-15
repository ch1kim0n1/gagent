# GAgent Runbook

## Daily Checks

```bash
npm run verify
node dist/cli.js health
node dist/cli.js metrics --format prometheus
node dist/cli.js cost
```

Review health score, recent failed receipts, budget reservations, and GBrain circuit-breaker state.

## Start MCP Server

```bash
npm run build
node dist/cli.js serve
```

Confirm the client can list MCP tools and call `gagent_health`.

## Run A Task

```bash
node dist/cli.js run "update the package metadata" --parallel 3 --verify --budget 1
```

Expected result:

- At least one attempt succeeds.
- A winner is selected.
- A receipt is appended.
- Cost is committed to the budget ledger.
- Metrics and decision audit entries are written.

## Backup And Restore

```bash
node dist/cli.js backup ./backups/gagent-$(date +%Y%m%d)
node dist/cli.js restore ./backups/gagent-20260515
```

Run `health` and `receipts` after restore to verify state continuity.

## Release Checklist

1. `npm run verify`
2. `npm run build`
3. `npm run docs:api`
4. `git diff --check`
5. Confirm `CHANGELOG.md`, `README.md`, and generated API docs describe the shipped behavior.
6. Push to `master`.

## Incident Response

| Symptom | Action |
| --- | --- |
| Health score below 80 | Inspect failed services, endpoint env vars, and network reachability. |
| Budget reservations stuck | Run `gagent cost`, wait for TTL, then inspect budget ledger state. |
| GBrain writes skipped | Check circuit-breaker logs, `GBRAIN_ENDPOINT`, `GBRAIN_AUTH_TOKEN`, and MCP transport settings. |
| Receipts missing | Check receipt directory permissions and `RECEIPT_SIGNATURE_KEY` errors. |
| MCP client cannot call write tools | Verify host auth wrapper grants write scope. |

## Operational Logs

Audit logs are JSONL. They should be shipped to centralized logging in production, with the local
copy retained long enough to debug receipt and budget disputes.
