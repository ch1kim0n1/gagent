# GAgent Architecture

GAgent is the unified control plane for the six-tool G-Stack. It coordinates configuration, tool discovery, command routing, pipeline execution, and MCP exposure without owning the domain logic of the individual tools.

## Core Components

## Configuration Manager

`src/config/manager.ts` owns the persisted GAgent configuration. It loads a user config file when available, validates it with Zod, and falls back to safe defaults for all six tools: `gbrain`, `gstack`, `gorchestrator`, `gmirror`, `gtom`, and `glearn`.

## Tool Registry

`src/tools/registry.ts` is the tool discovery and execution boundary. It detects installed tools, stores registered tool metadata, checks availability, and provides command execution wrappers for delegated tool calls.

## Pipeline Orchestrator

`src/pipeline/orchestrator.ts` describes and executes multi-stage G-Stack flows. The canonical flow is:

1. Prime GBrain with task context.
2. Execute work through GStack or dispatch parallel attempts through GOrchestrator.
3. Verify outputs with GMirror when requested.
4. Check decision authenticity with GToM when requested.
5. Select a winner and record results to GBrain.
6. Capture learning signal in GLearn when requested.

## CLI Layer

`src/cli.ts` exposes human-facing commands for initialization, health checks, pipeline runs, config management, sync, and MCP serving. CLI commands should remain thin and delegate behavior to the config, registry, and pipeline layers.

## MCP Layer

`src/mcp/server.ts` exposes GAgent as an MCP server. It provides tools for pipeline execution, health checks, GBrain search, GStack review, and configuration get/set operations.

## Design Constraints

- GAgent should orchestrate tools, not duplicate their internals.
- Public CLI and MCP contracts must be kept in sync with tests and docs.
- Tool failures should degrade gracefully where possible and fail loudly where correctness is at risk.
- Configuration defaults must be safe and explicit.
