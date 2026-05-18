# GAgent v0.5.0 — Production Hardening

**Date:** 2026-05-18
**Migration:** 0.1.0 → 0.5.0

## What's New

### Container hardening
- `Dockerfile` drops privileges via `chown -R node:node /app` + `USER node`.
- `HEALTHCHECK` directive calls `http://localhost:3004/health/live` via `node -e`
  with explicit `.on('error', ...)` handling.
- `docker-compose.yml` services declare resource limits:
  - `gagent`, `gbrain`, optional `gmirror`/`gtom`/`glearn`:
    `mem_limit: 512m`, `mem_reservation: 256m`, `cpus: 1.0`
  - `gorchestrator`: `mem_limit: 768m`, `mem_reservation: 384m`, `cpus: 1.5`

### HTTP security headers
- `src/core/public-health-server.ts` sets a helmet-equivalent header set on every
  response: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
  `Referrer-Policy: no-referrer`, `Strict-Transport-Security: max-age=31536000;
  includeSubDomains`, `Content-Security-Policy: default-src 'none';
  frame-ancestors 'none'`, `Cache-Control: no-store`.

### Test-coverage enforcement
- `jest.config.js` declares `coverageThreshold`:
  - `src/core/**/*.ts`: 85% lines/statements/functions, 75% branches
  - global: 70% lines/statements/functions, 60% branches

### Static security analysis
- `eslint-plugin-security@^3.0.1` added as a dev dependency.

### Version
- `package.json` `version` field bumped from `0.1.0` → `0.5.0`.

## Migration from 0.1.0

No breaking API changes. `ExecutionRequest`/`ExecutionReceipt` shape, HMAC-SHA256
signing, SQLite `agent_runs` schema, JSONL receipt format, and CLI commands
(`eval`, `replay`, `regress`, `trend`, `drift`, `cost`) are all unchanged.

Operational notes:
1. **Re-build the image** (`USER node` requires chown at build time).
2. **Mounted volumes** must be writable by uid 1000 (`node`).
3. **`~/.gagent/gagent.db`** — if a previous deploy ran as root, the SQLite
   file may not be writable by uid 1000. `chown -R 1000:1000 ~/.gagent` on
   the host before starting the new container.
4. **HSTS** is sent on all responses.

## Verification

```bash
docker compose build
docker compose up -d
docker inspect gagent --format '{{.Config.User}}'         # → node
docker inspect gagent --format '{{.State.Health.Status}}' # → healthy
curl -sI http://localhost:3004/health/live | \
  grep -iE 'x-content-type|x-frame|referrer|strict-transport|content-security'
npm run test:coverage   # threshold gate active
```

## Known Limitations
- `npm audit` not recorded for this release — run before external publish.
- `eslint-plugin-security` installed but not yet enabled in ESLint config.
- DYAD daemon mode, PII redaction pipeline, ethical-refusal classifier, and
  cost hard gate are tracked in `CLAUDE.md` as follow-up work — not part of
  v0.5.0.
