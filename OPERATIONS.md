# GAgent Operations Guide

GAgent is the operator-facing entry point for the six-tool G-Stack. It should be installed, verified, and smoke-tested before being used as the stack control plane.

## Install

```bash
npm install
npm run build
npm link
```

## Verify

```bash
npm run verify
```

This runs package, documentation, privacy, test-isolation, MCP contract, TypeScript, and Jest checks.

## Local CI

```bash
npm run ci:local
```

This runs the full local gate: quality checks, typecheck, tests, build, and CLI smoke tests against `dist/cli.js`.

## Runtime Configuration

Use `.env.example` and the GAgent config file as references for tool endpoints, enabled tools, integration behavior, and pipeline thresholds.

## Health Checks

Use the CLI health command after build/link:

```bash
gagent health
```

The health check should report installed tools, configured tools, and degraded states clearly.

## Common Failure Modes

- **Tool not installed**: GAgent should report unavailable tools without crashing.
- **Bad config**: invalid config should fall back to safe defaults or fail with a clear schema error.
- **MCP mismatch**: run `npm run check:mcp-contract` to ensure MCP tool names match expected contracts.
- **CLI not built**: run `npm run build` before `npm run smoke`.

## Release Readiness

Before release, run:

```bash
npm run ci:local
```

Then confirm README, architecture, testing, operations, and changelog content reflect the actual public API.
