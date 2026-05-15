# Changelog

All notable changes to GAgent will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Eval command with --cycles N support for statistical comparison
- Stats and drift CLI commands
- Comprehensive documentation (runbook, contract, eval)
- Production documentation set covering API usage, MCP contracts, migrations, runbooks,
  troubleshooting, security model, data flow, integration, ADRs, and generated TypeDoc API output.
- `docs:api` script and TypeDoc configuration for regenerating `docs/api`.
- Typed GBrain integration client for context search, pipeline memory writes, receipt mirroring,
  and daily tool-status pages with HTTP/MCP transports, auth, timeouts, retries, circuit breaker,
  and response validation.

### Changed
- Improved pipeline orchestration
- Enhanced tool registry management
- GAgent now primes execution with GBrain context through the typed client and degrades gracefully
  when GBrain is unavailable.

## [0.1.0] - 2026-05-13

### Added
- Unified CLI surface for the six-tool G-Stack
- Jest-based test tooling and TypeScript build checks
- Quality gates for package contracts, documentation, privacy, test isolation, MCP contracts, and CLI smoke tests
- Architecture, testing, operations, security, and contributing documentation
- MCP server with 6 operations (run, health, brain_search, stack_review, config_get, config_set)
- Pipeline orchestrator with parallel attempts
- Integration with GOrchestrator, GStack, GMirror, GToM, GLearn, and GBrain
