# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Add explicit, dry-run-first evidence retention maintenance through `agy_job collect`.
- Record verified finalize intent so interrupted worktree cleanup can be retried safely.
- Extend CI coverage to Node 20 and 24 on Windows, Linux, and macOS.

### Fixed
- Bound owned-process teardown with POSIX group escalation and report Windows termination failures.
- Reject AGY 1.1.28+ zero-exit timeout warnings and fatal CLI diagnostics as incomplete execution.
- Replace fabricated POSIX identities with Linux boot-scoped kernel start tokens and macOS process start/executable/argv probes; fail closed on query errors.
- Parse DMTF timezone offsets as signed minutes; use shared POSIX process-group teardown for directly owned children.
- Publish slot leases atomically, recover provably dead directory-lock owners, and report legacy locks/corrupt leases as blocked capacity.
- Align slot defaults with the eight-worker cap; cache process probes per scan and use cheap Windows liveness checks during termination waits.
- Require manifest hashes before patch application; preserve replacement common-directory lock owners on release.
- Return structured job-action data and a clear no-active-worker cancellation result; derive storage health from corruption counts.
- Bound output copying using chunk accumulation and a circular tail buffer; remove the redundant full health scan from async dispatch.
- Use the Antigravity CLI's configured model by default; document agent/model and the currently unenforced retention policy.
- Run CI on Windows, Linux and macOS, check committed bundle drift, and update GitHub Actions via Dependabot.
- Preserve job evidence during retention cleanup when timestamps are missing or malformed.
- Reject invalid cleanup clocks and negative or non-finite retention windows before scanning the ledger.
- Add regression coverage for retention boundaries, future timestamps, creation-time fallback, and dry-run/destructive cleanup safety.

## [1.1.0] - 2026-09-10

### Added
- Opt-in sparse checkout.
- Adaptive CPU/memory pre-spawn reservations (hardmax 8).
- Safe bounded activity through agy_job.
- Bounded native subagent prompt controls.
- Callback added/deleted line counts.
- Mermaid/sourced architecture docs.
- Note: Native Codex cards not provided and no measured speedup claim.

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

[Unreleased]: https://github.com/dedsec-terminal/transactional-antigravity-harness/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/dedsec-terminal/transactional-antigravity-harness/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/dedsec-terminal/transactional-antigravity-harness/releases/tag/v1.0.0
