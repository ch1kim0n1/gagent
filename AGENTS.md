# Agent Guidance for GAgent

GAgent is the orchestration surface for the G-Stack. Agents working in this repo should keep changes small, contract-aware, and verified.

## Rules

- Preserve CLI and MCP tool names unless intentionally changing public contracts.
- Update tests and docs with any public behavior change.
- Prefer adding behavior in `src/config`, `src/tools`, or `src/pipeline` rather than embedding logic in `src/cli.ts`.
- Run `npm run verify` after edits.
- Run `npm run ci:local` before release-level changes.

## Contract Surfaces

- CLI: `src/cli.ts`
- MCP: `src/mcp/server.ts`
- Config schema: `src/config/manager.ts`
- Tool registry: `src/tools/registry.ts`
- Pipeline: `src/pipeline/orchestrator.ts`
