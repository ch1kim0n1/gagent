# Embedding GAgent In Other Projects

GAgent can be embedded as a CLI dependency, an MCP server, or a TypeScript library.

## CLI Integration

Install and build the package, then call the compiled CLI:

```bash
npm install
npm run build
node ./dist/cli.js run "refactor the auth module" --parallel 3 --verify
```

For CI jobs, prefer explicit `node ./dist/cli.js` calls over a global `npm link` so the invoked
version is tied to the checked-out commit.

## MCP Integration

Add the server to the host agent configuration:

```json
{
  "mcpServers": {
    "gagent": {
      "command": "node",
      "args": ["./dist/cli.js", "serve"],
      "env": {
        "GAGENT_DB_PATH": "./.gagent/gagent.db"
      }
    }
  }
}
```

Grant write access only to trusted callers. `gagent_run` can trigger shell work through downstream
tools, so it should be treated as an execution capability.

## TypeScript Integration

```ts
import { Pipeline } from './dist/pipeline/orchestrator.js';
import { ToolRegistry } from './dist/tools/registry.js';
import { GAgentConfig } from './dist/config/manager.js';

const registry = new ToolRegistry();
const config = new GAgentConfig();
const pipeline = new Pipeline(registry, config);

const result = await pipeline.execute({
  task: 'summarize recent failures',
  parallel: 1,
  verify: false,
  cognitiveCheck: false,
  learn: false,
  dryRun: false,
});
```

Library callers are responsible for initializing configuration and protecting secrets in the host
process.

## Required Runtime State

- Writable SQLite path.
- Writable receipt and audit directories.
- Network access to configured stack endpoints when those tools are enabled.
- Optional receipt signing key if tamper detection is required.

## Compatibility Guidance

Pin the package version for production integrations. New optional output fields may appear in minor
versions, but required MCP input fields and existing CLI flags should remain compatible within a
major version.
