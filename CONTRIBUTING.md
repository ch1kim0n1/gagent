# Contributing to GAgent

GAgent changes should preserve the public CLI, MCP, and pipeline contracts unless the documentation and tests are updated at the same time.

## Development Flow

1. Install dependencies with `npm install`.
2. Make changes in `src/` and update tests in `test/`.
3. Run `npm run verify`.
4. Run `npm run ci:local` before release-level changes.

## Quality Requirements

- Add tests for new config, registry, pipeline, CLI, or MCP behavior.
- Keep docs aligned with implemented behavior.
- Do not commit focused tests (`it.only`, `describe.only`, `fit`, `fdescribe`).
- Do not commit secrets or private endpoints.
- Keep package scripts, docs, and MCP contracts synchronized.

## Release Checklist

- `npm run ci:local` passes.
- Changelog updated.
- README and operations docs reflect the release.
- MCP contract checks pass.
