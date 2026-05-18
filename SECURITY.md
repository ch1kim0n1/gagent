# GAgent Security

GAgent coordinates multiple tools and should treat configuration, task payloads, and tool outputs as potentially sensitive.

## Security Principles

- Do not hardcode credentials, tokens, API keys, or private endpoints.
- Keep `.env.example` safe and non-secret.
- Treat all delegated tool output as untrusted until validated.
- Prefer explicit allowlists for tool IDs and command routing.
- Fail closed on MCP contract drift and malformed configuration.

## Checks

Run the privacy/security gate:

```bash
npm run check:privacy
```

Run all quality gates:

```bash
npm run check:all
```

## Secret Rotation

Rotate secrets regularly using the CLI:

```bash
# Rotate auth secret used for JWT token signing
gagent secrets rotate gagent_auth_secret

# Rotate MCP bootstrap token
gagent secrets rotate gagent_mcp_token

# Rotate health shutdown token
gagent secrets rotate health_shutdown_token

# List all secrets
gagent secrets list
```

Secrets are stored in `GAGENT_SECRET_DIR` (default: `~/.gagent/secrets/`). Each rotation increments the version and records the timestamp. Rotate auth secrets:
- Immediately if compromised or suspected compromise
- On a regular schedule (e.g., quarterly) for production deployments
- Before deploying to new environments

After rotating `gagent_auth_secret`, restart the MCP server to use the new signing key. After rotating `gagent_mcp_token`, update any clients using the bootstrap token.

## Reporting

If a secret is committed, rotate it immediately, remove it from history if needed, and add a guard to prevent recurrence.
