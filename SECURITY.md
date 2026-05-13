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

## Reporting

If a secret is committed, rotate it immediately, remove it from history if needed, and add a guard to prevent recurrence.
