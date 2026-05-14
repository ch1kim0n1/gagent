# GAgent Operations Guide

GAgent is the operator-facing entry point for the six-tool G-Stack. It should be installed, verified, and smoke-tested before being used as the stack control plane.

## Install

```bash
npm install
npm run build
npm link
```

## Deployment Methods

### Docker Compose
```bash
# Build and start with Docker Compose
docker-compose up -d gagent

# View logs
docker-compose logs -f gagent

# Stop
docker-compose down
```

### Kubernetes with Helm
```bash
# Install chart
helm install gagent ./helm/gagent --namespace gstack --create-namespace

# Upgrade
helm upgrade gagent ./helm/gagent --namespace gstack

# Rollback
helm rollback gagent --namespace gstack

# Uninstall
helm uninstall gagent --namespace gstack
```

### Systemd (Bare Metal)
```bash
# Create user and directories
sudo useradd -r -s /bin/false gagent
sudo mkdir -p /opt/gagent /var/lib/gagent /var/log/gagent /etc/gagent
sudo chown -R gagent:gagent /opt/gagent /var/lib/gagent /var/log/gagent

# Copy files
sudo cp -r dist/* /opt/gagent/
sudo cp deploy/systemd/gagent.service /etc/systemd/system/
sudo cp .env.example /etc/gagent/gagent.env
# Edit /etc/gagent/gagent.env with actual values

# Enable and start
sudo systemctl daemon-reload
sudo systemctl enable gagent
sudo systemctl start gagent

# Check status
sudo systemctl status gagent
sudo journalctl -u gagent -f
```

## Rollback Procedures

### Kubernetes
```bash
# View revision history
helm history gagent --namespace gstack

# Rollback to previous version
helm rollback gagent --namespace gstack

# Rollback to specific revision
helm rollback gagent <revision> --namespace gstack
```

### Docker Compose
```bash
# Rebuild with previous image tag
docker-compose down
docker-compose up -d --build gagent
```

### Systemd
```bash
# Stop service
sudo systemctl stop gagent

# Restore previous build
sudo cp -r /opt/gagent.backup/* /opt/gagent/

# Restart
sudo systemctl start gagent
```

## Verify

```bash
npm run verify
```

This runs package, documentation, privacy, test-isolation, MCP contract, TypeScript, and Jest checks.

## Local CI

```bash
npm run ci:local
```

This runs the full local gate: quality checks, typecheck, tests, build, and CLI smoke tests against `dist/cli.js`.

## Runtime Configuration

Use `.env.example` and the GAgent config file as references for tool endpoints, enabled tools, integration behavior, and pipeline thresholds.

## Health Checks

Use the CLI health command after build/link:

```bash
gagent health
```

The health check should report installed tools, configured tools, and degraded states clearly.

### Service Level Objectives (SLOs)

#### P95 Latency
- Health check: 200ms
- Tool registry query: 500ms

#### Error Rate
- Health check: < 0.1%
- Tool registry operations: < 1%

#### Uptime
- Monthly: 99.9%
- Quarterly: 99.95%

#### Alert Thresholds
- Health check failure for 1 minute
- Tool registry unavailable for 5 minutes

## Common Failure Modes

- **Tool not installed**: GAgent should report unavailable tools without crashing.
- **Bad config**: invalid config should fall back to safe defaults or fail with a clear schema error.
- **MCP mismatch**: run `npm run check:mcp-contract` to ensure MCP tool names match expected contracts.
- **CLI not built**: run `npm run build` before `npm run smoke`.

## Release Readiness

Before release, run:

```bash
npm run ci:local
```

Then confirm README, architecture, testing, operations, and changelog content reflect the actual public API.
