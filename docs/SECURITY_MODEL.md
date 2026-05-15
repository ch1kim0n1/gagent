# GAgent Security Model

GAgent is a local control plane for agentic execution. Its main security goal is to keep task
execution auditable while preventing secrets and private task data from leaking through logs,
receipts, metrics, or MCP access.

## Trust Boundaries

| Boundary | Risk | Control |
| --- | --- | --- |
| CLI user to local process | Unauthorized task execution | Run under the intended user account; rely on OS permissions. |
| MCP client to GAgent server | Write-tool abuse | Host wrapper must authenticate callers and grant write scope deliberately. |
| GAgent to stack tools | Downstream failure or unexpected output | Timeouts, circuit breakers, structured errors, and receipt evidence. |
| GAgent to persistence | Tampered evidence | Append-only receipts, optional HMAC signing, SQLite transactions. |
| GAgent to logs/metrics | Sensitive data leakage | PII redaction and structured logging discipline. |

## Secrets

Secrets must come from environment variables or secret stores, never committed config files.
Sensitive values include API keys, OAuth tokens, database URLs, receipt signing keys, and webhook
URLs. The privacy quality gate scans source and docs for obvious secrets.

## Receipts And Audit Data

Receipts are operational evidence. They may include task text and model metadata, so production
deployments should:

- Store receipts in an access-controlled location.
- Enable `RECEIPT_SIGNATURE_KEY` for tamper detection.
- Rotate signing keys through deployment secrets.
- Avoid putting raw secrets in task prompts.
- Retain audit logs according to the deployment retention policy.

## MCP Authorization

Read-only tools can reveal operational state and should still require authenticated access in
multi-user deployments. Write tools, especially `gagent_run` and `gagent_config_set`, must require
explicit write authorization.

## Network Posture

Stack service endpoints should use local networking or mutually trusted service networks. Public
exposure of the MCP server is not recommended without a hardened auth proxy, TLS, rate limits, and
request logging.

## Failure Handling

GAgent should fail closed on validation, budget, and persistence errors. External stack failures
should degrade with explicit health/error state when possible, so operators can distinguish a
local GAgent fault from an upstream tool outage.
