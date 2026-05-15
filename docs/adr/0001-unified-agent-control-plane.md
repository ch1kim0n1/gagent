# ADR 0001: GAgent Is The Unified Agent Control Plane

## Status

Accepted

## Context

The stack contains specialized tools for memory, skill routing, parallel execution, verification,
cognitive checks, and learning. Agents and operators need one stable surface for running tasks and
collecting evidence without learning each tool's local command shape.

## Decision

GAgent owns the unified CLI and MCP surface. It coordinates downstream stack tools, records
receipts, persists budget and run metadata, and emits observability data. Specialized tools remain
responsible for their domain logic.

## Consequences

- Operators get one command and one MCP server for common workflows.
- GAgent must degrade cleanly when an external stack tool is down.
- Receipts and audit logs become the source of truth for cross-tool execution evidence.
- GAgent must keep documentation and contracts current because downstream agents depend on it as
  the stable entry point.

## Alternatives Considered

- Directly exposing every stack tool to every agent client. This increases client complexity and
  makes cross-tool receipts harder to reason about.
- Moving all domain logic into GAgent. This reduces network hops but duplicates the specialized
  tool implementations and weakens separation of concerns.
