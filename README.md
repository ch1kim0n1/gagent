# GAgent — Unified CLI for the Six-Tool Agent Stack

A single entry point for GBrain, GStack, GOrchestrator, GMirror, GToM, and GLearn. Designed for Claude Code, Cursor, OpenClaw, and other coding agents.

## Quick Start

```bash
# Install
git clone https://github.com/garrytan/gagent.git && cd gagent && ./install

# Initialize full stack
gagent init

# Check health across all tools
gagent health

# Run a task through the full pipeline
gagent run "implement user authentication" --parallel 5 --verify --learn
```

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    GAgent CLI                           │
│              (unified entry point)                      │
├─────────┬─────────┬─────────┬─────────┬─────────┬───────┤
│ GBrain  │ GStack  │GOrchest │ GMirror │  GToM   │ GLearn│
│ (memory)│ (skills)│(parallel│(testing)│(cognitive│(meta) │
│         │         │ execute)│         │ defense)│       │
└────┬────┴────┬────┴────┬────┴────┬────┴────┬────┴───┬───┘
     │         │         │         │         │        │
     └─────────┴─────────┴─────────┴─────────┴────────┘
                    Shared GBrain Bus
```

## Command Structure

### Core Commands

| Command | Description |
|---------|-------------|
| `gagent init` | Initialize all six tools, detect existing installs, configure integration |
| `gagent health` | Health check across all tools with composite score |
| `gagent run <task>` | Execute task through full pipeline with options |
| `gagent sync` | Sync state across all tools, resolve drift |
| `gagent config` | Unified configuration management |
| `gagent serve` | Start MCP server for Claude Code integration |

### Tool-Specific Commands (Passthrough)

| Command | Delegates To |
|---------|--------------|
| `gagent brain <cmd>` | `gbrain <cmd>` |
| `gagent stack <cmd>` | `gstack-*` binaries |
| `gagent orc <cmd>` | `gorchestrator <cmd>` |
| `gagent mirror <cmd>` | `gmirror <cmd>` |
| `gagent tom <cmd>` | `gtom <cmd>` |
| `gagent learn <cmd>` | `glearn <cmd>` |

### Pipeline Commands

| Command | What It Does |
|---------|--------------|
| `gagent run <task> --parallel N` | GOrchestrator dispatches N attempts |
| `gagent run <task> --verify` | GMirror tests each output |
| `gagent run <task> --cognitive-check` | GToM validates decision authenticity |
| `gagent run <task> --learn` | GLearn captures patterns for refinement |
| `gagent run <task> --full` | All stages: parallel → verify → check → learn |

## Claude Code Integration

### MCP Server

```json
{
  "mcpServers": {
    "gagent": {
      "command": "gagent",
      "args": ["serve"]
    }
  }
}
```

### Exposed Tools

- `gagent_run` — Execute task with pipeline options
- `gagent_health` — Check system status
- `gagent_brain_search` — Query GBrain
- `gagent_stack_review` — Run GStack review
- `gagent_orc_dispatch` — Parallel dispatch
- `gagent_mirror_test` — Synthetic user testing
- `gagent_tom_assess` — Cognitive assessment
- `gagent_learn_patterns` — Pattern extraction

### Skill Routing (GStack Style)

```
/run <task>              # Single attempt via GStack
/run-parallel <task>     # GOrchestrator best-of-N
/run-verified <task>     # Parallel + GMirror verification
/run-safe <task>         # Verified + GToM authenticity check
/run-smart <task>        # Full pipeline with GLearn capture
```

## Configuration

### Unified Config (`~/.gagent/config.json`)

```json
{
  "version": "1.0.0",
  "tools": {
    "gbrain": {
      "enabled": true,
      "path": "~/.gbrain",
      "engine": "pglite",
      "mcp_registered": true
    },
    "gstack": {
      "enabled": true,
      "path": "~/.claude/skills/gstack",
      "skills": ["office-hours", "review", "ship", "qa"]
    },
    "gorchestrator": {
      "enabled": true,
      "path": "~/.gorchestrator",
      "max_parallel": 5,
      "default_attempts": 3
    },
    "gmirror": {
      "enabled": true,
      "path": "~/.gmirror",
      "synthetic_users": 50,
      "modes": ["change-test", "pre-build", "shadow"]
    },
    "gtom": {
      "enabled": true,
      "path": "~/.gtom",
      "ice_enabled": true
    },
    "glearn": {
      "enabled": true,
      "path": "~/.glearn",
      "cadence": "nightly"
    }
  },
  "integration": {
    "event_bus": "gbrain",
    "shared_memory": true,
    "cross_tool_sync": true
  },
  "agents": {
    "claude_code": {
      "mcp_enabled": true,
      "skill_routing": true
    },
    "cursor": {
      "mcp_enabled": false
    }
  }
}
```

## Data Flow

```
1. Task Enters (gagent run)
   ↓
2. GBrain primed (context lookup)
   ↓
3. GOrchestrator dispatches N attempts
   ↓
4. Each attempt runs through GStack skills
   ↓
5. GMirror tests outputs (synthetic users)
   ↓
6. GToM validates authenticity
   ↓
7. Winner selected, written to GBrain
   ↓
8. GLearn captures pattern (async)
```

## Installation Detection

`gagent init` probes for existing installs:

```bash
# GBrain
test -d ~/.gbrain && test -f ~/.bun/bin/gbrain

# GStack
test -d ~/.claude/skills/gstack

# Others (not yet built)
test -d ~/.gorchestrator/bin/gorchestrator || echo "needs build"
```

Auto-links discovered tools, prompts to build missing ones.

## Development

### Adding a New Tool

1. Create tool wrapper in `src/tools/<name>.ts`
2. Add config schema to `src/config/schema.ts`
3. Register commands in `src/cli/router.ts`
4. Add MCP tools to `src/mcp/server.ts`

### Testing

```bash
gagent test --integration    # Full stack integration
gagent test --unit           # Unit tests only
gagent test --e2e            # End-to-end pipeline
```

## License

MIT — same as GBrain and GStack
