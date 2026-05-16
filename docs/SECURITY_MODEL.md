# GAgent Security Model

GAgent is a local control plane for agentic execution. Its main security goal is to keep task
execution auditable while preventing secrets and private task data from leaking through logs,
receipts, metrics, or MCP access.

## Trust Boundaries

| Boundary | Risk | Control |
| --- | --- | --- |
| CLI user to local process | Unauthorized task execution or unsafe flag values | Run under the intended user account; validate task, port, budget, parallelism, and secret flags before use. |
| MCP client to GAgent server | Write-tool abuse | Token authentication, read/write scope checks, token-hash permission grants, and per-token rate limits. |
| GAgent to stack tools | Downstream failure or unexpected output | Timeouts, circuit breakers, structured errors, and receipt evidence. |
| GAgent to persistence | Tampered evidence | Append-only receipts, optional HMAC signing, SQLite transactions. |
| GAgent to logs/metrics | Sensitive data leakage | PII redaction and structured logging discipline. |
| Public health endpoint | Shutdown abuse or endpoint flooding | Bearer-protected shutdown and per-client rate limits. |
| Tool detection | PATH hijacking | Generic tool detection executes only absolute binaries under the expected dot-directory. |

## Secrets And Rotation

Secrets must come from the local file-backed secret manager or a deployment secret source, never
committed config files. The file secret manager reads `GAGENT_SECRET_DIR` or defaults to
`~/.gagent/secrets`; legacy environment variables are accepted only as a fallback for migration.
Sensitive values include API keys, OAuth tokens, database URLs, receipt signing keys, and webhook
URLs. The privacy quality gate scans source and docs for obvious secrets.

Use `gagent secrets rotate <name>` to generate a new value, or pass `--value` when a deployment
system has already generated it. `gagent secrets list` prints only names, versions, timestamps, and
sources. It never prints secret values.

## Receipts And Audit Data

Receipts are operational evidence. They may include task text and model metadata, so production
deployments should:

- Store receipts in an access-controlled location.
- Enable the `receipt_signature_key` secret for tamper detection.
- Rotate signing keys through `gagent secrets rotate receipt_signature_key`.
- Avoid putting raw secrets in task prompts.
- Retain audit logs according to the deployment retention policy.

Security-relevant MCP denials and rate-limit events are written to the local JSONL audit stream
with redaction applied before persistence.

## MCP Authorization

Read-only tools can reveal operational state and should still require authenticated access in
multi-user deployments. Write tools, especially `gagent_run` and `gagent_config_set`, require
explicit write authorization.

Configure MCP auth with `gagent_mcp_token` in the secret manager. The token receives the scopes in
`GAGENT_MCP_TOKEN_SCOPES` by default. For multi-user deployments, set `GAGENT_PERMISSIONS_FILE` to
a JSON file containing SHA-256 token hashes:

```json
{
  "tokens": {
    "sha256-token-hex": ["read"],
    "sha256-admin-token-hex": ["read", "write", "admin"]
  }
}
```

The permission file narrows granted scopes; it does not expand the bootstrap scopes. Requests that
fail authentication, scope checks, or rate limits fail closed.

## Network Posture

Stack service endpoints should use local networking or mutually trusted service networks. Public
exposure of the MCP server is not recommended without a hardened auth proxy, TLS, rate limits, and
request logging.

The health server exposes `/health/live`, `/health/ready`, and `/health/shutdown`. Shutdown requires
the `health_shutdown_token` secret and all health routes share the `GAGENT_HEALTH_RATE_LIMIT_RPM`
per-client limit.

Generic stack-tool detection uses absolute binaries under `~/.<tool>/<tool>` or
`~/.<tool>/<tool>.exe` and never relies on a shell or PATH lookup for those tools.

## Failure Handling

GAgent should fail closed on validation, budget, and persistence errors. External stack failures
should degrade with explicit health/error state when possible, so operators can distinguish a
local GAgent fault from an upstream tool outage.
