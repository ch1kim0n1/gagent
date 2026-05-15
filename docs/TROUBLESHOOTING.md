# GAgent Troubleshooting

## `npm run verify` Fails On Docs

Run:

```bash
npm run check:docs
```

The documentation gate requires `README.md`, `ARCHITECTURE.md`, `TESTING.md`, `OPERATIONS.md`,
`SECURITY.md`, `CONTRIBUTING.md`, `CHANGELOG.md`, `AGENTS.md`, and `.env.example`.

## MCP Contract Check Fails

Run:

```bash
npm run check:mcp-contract
rg "gagent_" src/mcp/server.ts
```

The server must include the expected tool names and package version. If a tool is renamed, update
the server, tests, and contract documentation together.

## GBrain Calls Fail

Symptoms:

- `GBrain circuit breaker is open`
- `HTTP 503`
- timeout or network errors in structured logs

Actions:

1. Verify `GBRAIN_ENDPOINT`.
2. Call the endpoint `/health` directly.
3. Wait for the circuit-breaker timeout or restart the process after the upstream is healthy.
4. Re-run the task or replay the failed receipt.

## Budget Exceeded

GAgent reserves budget before model calls and commits actual cost after completion.

Actions:

```bash
node dist/cli.js cost
```

Lower `--parallel`, raise the budget intentionally, or wait for stale reservations to expire.

## Receipts Cannot Be Written

Check:

- Receipt directory exists and is writable.
- The process user can create JSONL files.
- `RECEIPT_SIGNATURE_KEY` is valid if signing is enabled.
- Disk is not full.

## TypeScript Cannot Resolve Shared Imports

Some pipeline code imports shared stack clients. Make sure the monorepo layout is intact and run
commands from the repository root that contains the sibling `shared` workspace.

## TypeDoc Generation Fails

Run:

```bash
npx typedoc --options typedoc.json
```

Fix TypeScript syntax or unresolved entry points first. Warnings about private implementation
types should be reviewed but do not block docs unless public API output is missing.
