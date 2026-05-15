# GAgent Migrations

GAgent stores durable state in SQLite and appends execution evidence to JSONL receipt files.
Migrations must be deterministic, idempotent, and safe to run during startup before CLI or MCP
commands serve requests.

## State Stores

| Store | Default location | Contents |
| --- | --- | --- |
| SQLite | `~/.gagent/gagent.db` | Runs, receipts, model metrics, cost entries, budget reservations, schema version. |
| Receipts | `gagent/test/baselines/receipts-YYYY-Www.jsonl` in tests, configured receipt dir in runtime | Execution receipts used for replay and regression gates. |
| Metrics | `~/.gagent/audit/llm-metrics.json` unless overridden | Local model latency, cost, and success counters. |
| Audit logs | `~/.gagent/audit/*.jsonl` unless overridden | Shell jobs, decisions, and redacted operational events. |

## Migration Rules

1. Add SQL migrations under `src/core/migrations/NNN_description.sql`.
2. Keep every migration forward-only. Rollbacks are data restores from backup, not reverse DDL.
3. Use `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, and guarded column additions.
4. Update `GAgentPersistenceManager` only when runtime code must coordinate the migration.
5. Add tests that open a temporary database, run migrations, and verify the new schema.
6. Document any operator-facing change in `CHANGELOG.md` and this file.

## Current Migrations

| Version | File | Purpose |
| --- | --- | --- |
| 1 | `001_initial_schema.sql` | Initial persistent run, receipt, and metadata tables. |
| 2 | `002_persistent_metrics.sql` | Persistent metrics and cost/budget ledger data. |

## Applying Migrations

The persistence manager applies migrations automatically when the database is opened. For local
verification, run:

```bash
npm run verify
node dist/cli.js health
```

If a migration fails, stop the process, preserve the database file, and inspect the failure before
retrying. Do not edit a previously shipped migration; add a new numbered migration that corrects
the state.

## Backup Before Production Migration

```bash
gagent backup ./backups/gagent-before-migration
npm run build
node dist/cli.js health
```

For Kubernetes or systemd deployments, take a volume snapshot or file copy of the SQLite database
before deploying a version that includes schema changes.
