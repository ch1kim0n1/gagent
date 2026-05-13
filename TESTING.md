# GAgent Testing Guide

GAgent follows the same maturity pattern as `gbrain` and `gstack`: fast local checks, focused unit tests, CLI smoke tests, MCP contract tests, and end-to-end mocked pipeline tests.

## Commands

```bash
npm test
npm run typecheck
npm run check:all
npm run verify
npm run ci:local
```

## Test Layers

## Unit Tests

- `test/config.test.ts` validates config defaults, persistence, and schema behavior.
- `test/registry.test.ts` validates tool registration, availability, discovery, and execution boundaries.
- `test/pipeline.test.ts` validates pipeline description and execution behavior.

## CLI Smoke Tests

`test/cli.test.ts` validates built CLI entry points such as `--version`, `--help`, and config commands. These tests are intentionally defensive because the CLI may not be built before normal unit tests.

## MCP Contract Tests

`test/mcp.test.ts` validates that the MCP server module is importable. The stronger production gate in `scripts/quality-gates.js` validates that expected MCP tool names are present in `src/mcp/server.ts`.

## E2E Mocked Tests

`test/e2e.test.ts` validates that configuration, registry, and pipeline components can be initialized together using temporary config state.

## Quality Gates

`scripts/quality-gates.js` provides fail-closed checks for package contract, documentation presence, privacy scanning, test isolation, MCP contract names, CLI smoke, and local CI execution.
