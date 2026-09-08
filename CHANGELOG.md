# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0] - 2026-09-08

### Added
- Transactional worktree isolation.
- Durable ledger, evidence collection, and outbox event streaming.
- Bounded leases and process supervision.
- Typed worker results with structured status validation.
- Explicit apply, finalize, and reconcile lifecycle stages.
- Async callbacks for event-driven orchestration.
- Task resume via conversation identifiers.
- Model Context Protocol (MCP) tools integration.
- Deterministic unit and integration test coverage.

### Fixed
- Project-registration pollution fix preventing cross-task state leaks.

[Unreleased]: https://github.com/dedsec-terminal/transactional-antigravity-harness/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/dedsec-terminal/transactional-antigravity-harness/releases/tag/v1.0.0
