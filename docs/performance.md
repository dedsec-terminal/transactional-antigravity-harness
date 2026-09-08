# Performance & Token Architecture

This document details the performance characteristics, token efficiency strategies, and isolation architecture of the Transactional Antigravity Harness for Codex.

Architecture diagrams for orchestration fanout and the correction loop are maintained in [README.md](../README.md#architecture-overview).

---

## 1. Architecture Overview & Lifecycle

The harness orchestrates bounded delegation between a primary orchestrator (Codex) and headless Google Antigravity (`agy`) subagents. The architecture optimizes for token economy and state determinism: the primary agent retains exclusive authority over task decomposition, validation, and final integration, while subagents execute in isolated contexts on disk and in memory.

* **Evidence Collection & Explicit Apply**: Workers run in isolated ephemeral git worktrees. Changes are captured as hash-verified manifests and diffs (SHA-256), not cryptographically signed artifacts. The parent orchestrator is notified reactively and must explicitly apply verified patches.
* **Exact-Session Correction Loop (`resumeJobId`)**: Passing `resumeJobId` reuses the recorded conversation session and existing worktree directly (`--conversation <sessionId>`). This requires a saved session ID from a prior attempt and does not guarantee cached-token savings or eliminate repository reindexing.

---

## 2. Task Routing for Token Efficiency

* **Bounded Prompts**: Atomic tasks constrained by the Four-Pillar format (`TARGETS`, `ACTION`, `CONSTRAINTS`, `VERIFICATION`) focus subagents and minimize conversational token overhead.
* **Disjoint Concurrency (Max 4 Workers)**: Up to 4 parallel workers (`MAX_WORKER_SLOTS = 4`) target non-overlapping file paths or directory prefixes to prevent collision and rework.
* **Reactive Async Callbacks**: `codex queue` signals the orchestrator when an attempt finishes, avoiding token-costly polling loops (`agy_job status`). Delivery is best-effort and not guaranteed.
* **Shared Read-Only Plan vs Worktree Mutation**: Only synchronous planning (`agy_delegate` with `mode: "plan"`) defaults to `isolation: "shared"`, which relies on trusted read-only instructions rather than an OS-level sandbox. Asynchronous planning and mutating edits (`mode: "accept-edits"`) strictly isolate in git worktrees.
* **Opt-in Sparse Worktree Isolation (`sparseCheckout`)**: For bounded tasks targeting specific paths, callers can opt in to sparse checkout (`sparseCheckout: true`, CLI `--sparse-checkout`; default is full checkout). Under Git cone semantics, selecting a tracked file expands to its parent directory siblings, root files are present, and unrelated subtrees are absent. Targets must exist at the base commit, so callers creating new files must target an existing parent directory. Sparse checkout is recommended only for bounded self-contained edits; full checkout remains recommended for repo-wide or cross-module checks. Measured speedup is not yet claimed.
* **Exact-Session Correction Loop (`resumeJobId`)**: Passing `resumeJobId` reuses the recorded conversation session and existing worktree directly (`--conversation <sessionId>`). This requires a saved session ID from a prior attempt and does not guarantee cached-token savings or eliminate repository reindexing.

---

## 3. Sourced Architectural Comparisons

The harness combines proven patterns from modern developer tooling, relying strictly on sourced facts:

* **Disk Worktrees**: Like [Cursor Worktrees](https://cursor.com/docs/configuration/worktrees), tasks execute in dedicated git worktrees on disk to keep working changes isolated.
* **Context Window Hygiene**: Like [Claude Code Sub-agents](https://code.claude.com/docs/en/sub-agents), offloading bounded tasks to separate context windows prevents high-verbosity tool outputs from polluting parent context.
* **Untrusted Worker Principle**: Unlike workflows where agents write directly to the primary workspace, all worker outputs are treated as untrusted evidence requiring parent review, preimage checks, and explicit application.

---

## 4. Empirical Grounding & Engineering Realities

* **Filesystem Operations**: Worktree creation involves standard OS filesystem operations rather than "zero I/O". There are no guaranteed speedups, delivery guarantees, or token savings; efficiency depends on disciplined prompt scoping and parallel task execution.
* **Operational Sizing Target**: Sizing tasks to finish in under 25 seconds is an operational prompt-scoping target to resolve on single yields, not an SLA or execution speed guarantee.
* **Sparse Checkout Status**: Opt-in sparse checkout (`sparseCheckout: true`, CLI `--sparse-checkout`) is implemented using Git cone mode; full checkout remains the default. Selected tracked files expand to parent directory siblings, root files are present, and unrelated subtrees are absent. Targets must exist at base commit (use existing parent directory target when creating new files). Recommended only for bounded self-contained edits; full checkout remains recommended for repo-wide/cross-module checks. Measured speedup is not yet claimed.
* **Durable Disk Ledger**: Worker state, leases, and manifests are written to durable disk storage for crash safety and reconciliation. RAM-only defaults or failover authority expansion are not included.
* **Decoupled Controller**: Keeping the controller as a decoupled runner script preserves process boundaries; embedding it directly into the long-lived MCP server is deferred pending empirical measurement.
