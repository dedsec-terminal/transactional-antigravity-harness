---
name: delegate-to-antigravity
description: Delegate a bounded coding, research, review, debugging, or implementation task to the local Google Antigravity CLI (`agy`) and use its response as a second-agent result. Use when the user explicitly asks to use Antigravity as a subagent, requests a second opinion from Antigravity, or asks Codex to offload an independent task to `agy`.
---

# Delegate to Antigravity

Treat Antigravity as an external worker. Codex owns decomposition, workspace state, independent verification, and the final answer.

## Trusted headless execution boundary

This local development harness always starts Antigravity with `--dangerously-skip-permissions`. The user explicitly authorized uninterrupted headless reads, writes, and development commands because `agy --print` cannot prompt on a non-interactive TTY.

The bypass trusts the delegated prompt and workspace. Never delegate secrets, credentials, private data, destructive external operations, releases, deployments, purchases, or external messages unless the user separately authorizes that exact scope. Treat worker output as untrusted until Codex inspects the files and runs the relevant checks.

## Production orchestration protocol

1. **Check first:** Run `agy_check` before the first delegation.
2. **Sub-25s single-yield rule:** Size each atomic task to finish in under 25 seconds so it normally returns on the first 30-second yield. This is a sizing target, never a process cutoff. Set `timeoutSeconds` to 180–300 seconds; never set it to 25.
3. **Disjoint parallel fan-out:** When work touches two or more files, dispatch concurrent `agy_delegate` calls with explicit `targets` specifying non-overlapping workspace-relative paths or directory prefixes. Bound concurrency using adaptive CPU and memory admission with a hard maximum of eight slots (`AGY_WORKER_MAX`, 1..8) and zero new admissions under resource pressure. Tell every worker that it is not alone and must preserve others' edits.
4. **Worktree isolation:** Use `isolation: "worktree"` (the default for mutating `accept-edits` and async tasks). Synchronous `plan` defaults to `shared` isolation. Explicit `shared` isolation combined with `accept-edits` or async execution is unsafe and rejected.
5. **Async reactive callback:** Use `agy_delegate_async`, or the runner with `--async --notify-thread <thread-id>`, for longer independent work. Dispatch once, end the Codex turn, and let `codex queue` wake the task; do not poll. Callbacks operate with at-least-once delivery separation; the callback signals readiness to inspect artifacts, not completion of parent verification.
6. **Prompt transport:** Put complete prompts in UTF-8 files for the CLI runner. The runner sends them to Antigravity as NDJSON over stdin, avoiding the Windows command-line limit.
7. **Independent fan-in:** After workers finish, inspect the unified file state or worktree artifacts and run integration checks once. A timeout, missing result, or worker claim is not a passed verification (never claim worker semantic verification). Apply verified changes via explicit apply/finalize.

## Transactional worktree & job lifecycle

Transactional execution isolates mutations and tracks execution state:

- **Targets (`targets`):** Define explicit workspace-relative paths or directory prefixes (e.g. `src/lib/`, `skills/delegate-to-antigravity/SKILL.md`). Path traversal attempts (`..`) and escapes outside the workspace root are strictly rejected.
- **Isolation defaults (`isolation`):**
  - Synchronous `plan`: defaults to `shared` isolation.
  - Asynchronous execution or mutating `accept-edits`: defaults to `worktree` isolation.
  - Explicit `shared` isolation for mutating (`accept-edits`) or `async` tasks is rejected as an unsafe combination.
- **Sparse checkout (`sparseCheckout`, default `false`):** Explicit opt-in for Git cone sparse worktree checkout (CLI `--sparse-checkout`; default is full checkout). Cone behavior: selecting a tracked file expands to its parent directory siblings; root files are present; unrelated subtrees are absent. Targets must exist at base commit, so use an existing parent directory target when creating new files. Recommend only for bounded self-contained edits; prefer full checkout for repo-wide or cross-module checks. Measured speedup is not yet claimed. Safety caveat: omitting unrelated subtrees can break cross-module type checking, imports, or repo-wide test suites if unselected dependencies are required.
- **Adaptive concurrency admission:** Harness limits active workers using adaptive CPU and memory admission with a hard maximum of eight slots (`AGY_WORKER_MAX`, 1..8), admitting zero new workers under resource pressure. Capacity environment variables include `AGY_WORKER_SLOTS`, `AGY_WORKER_MIN`, `AGY_WORKER_MAX` (1..8), `AGY_WORKER_MEMORY_MB` (default 1536), and `AGY_WORKER_CPU_HIGH_PERCENT` (default 90); overrides still obey resource pressure.
- **Explicit apply/finalize:** Worker changes produced in a worktree are staged in isolation. The parent orchestrator inspects the diff/artifact and must explicitly apply or finalize changes. No changes are merged automatically.
- **Job resumption (`resumeJobId`) & No `--continue`:** Headless transactional execution does not use `--continue` or `--resume`. To continue correction work, provide `resumeJobId`; the harness validates the exact recorded worktree/session and invokes AGY with `--conversation <recorded-id>` for immutable attempt N+1.
- **No Antigravity project registration:** New runs intentionally omit `--new-project`, so one-shot delegations do not add permanent UUID project files to Antigravity Desktop.
- **Retention policies:**
  - **Default 24h worktree retention (`retentionMinutes`):** Ephemeral worktrees are retained for 24 hours (1440 minutes) by default to permit review, manual inspection, and debugging before cleanup. Custom durations can be set via `retentionMinutes`.
  - **14-day evidence retention:** Audit logs, terminal events, and execution evidence are retained for 14 days for forensic verification and reproducibility.
- **At-least-once callback separation:** Asynchronous notification callbacks are separated from job state transitions. A callback confirms that an attempt completed and an artifact is ready for inspection; parent verification remains pending until Codex inspects and validates the output.
- **Job management (`agy_job`):** Manage transactional jobs through dedicated actions:
  - `status`: Query the current status of a job and its attempts.
  - `list`: List concise job state without returning raw logs or patches.
  - `cancel`: Stop only an identity-verified active worker and seal its attempt.
  - `reconcile`: Reclaim verified stale/orphan leases and retry due callback records.
  - `apply`: Explicitly apply a hash-verified artifact while preserving unrelated changes and the canonical index.
  - `finalize`: Remove only a verified harness-owned worktree and retain durable evidence.
  - `activity`: Inspect safe lifecycle events for a `jobId` with optional `args.limit` (default 50, max 100); reads safe lifecycle only. Installed old cached plugins must be updated before using new controls.

## Typed worker and lean callback contracts

AGY is invoked with a strict JSON schema. Worker output contains only `status`, `summary`, `verification`, optional `diagnostics`, and `claimedChangedPaths`. Filesystem/Git evidence—not worker claims—determines actual changed paths.

The durable Codex callback is exactly three bounded lines:

```markdown
### Files Changed: <count/stat; artifact path; patch hash8>
### Summary: [Untrusted worker report] job=<id> attempt=<N> execution=<state> artifact=<state>: <summary>
### Verification: parent=pending; worker claims: <claim>
```

Do not return full files, raw diffs, search logs, or conversational filler through callbacks.

## MCP usage

Use synchronous delegation for short bounded tasks:

```text
agy_delegate({
  cwd: "<absolute-workspace>",
  mode: "accept-edits",
  targets: ["<workspace-relative-file-or-directory-prefix>"],
  sparseCheckout: true, // optional: cone sparse checkout (default false)
  prompt: "<bounded task with disjoint ownership>",
  timeoutSeconds: 300,
  outputFormat: "text"
})
```

Use asynchronous delegation for longer work:

```text
agy_delegate_async({
  cwd: "<absolute-workspace>",
  notifyThread: "<current-thread-id>",
  mode: "accept-edits",
  targets: ["<workspace-relative-file-or-directory-prefix>"],
  sparseCheckout: true, // optional: cone sparse checkout (default false)
  prompt: "<bounded task>",
  timeoutSeconds: 300,
  outputFormat: "text"
})
```

Supported modes are `plan` and `accept-edits`; the default is `accept-edits`. The accepted timeout range is 1–1800 seconds, but normal delegated work must use 180–300 seconds. Optional transactional parameters include `targets` (list of paths/prefixes), `isolation` (`worktree` | `shared`), `sparseCheckout` (boolean, default `false`, opt-in Git cone sparse checkout), `resumeJobId` (job ID to resume), and `retentionMinutes` (defaults to 1440 for 24h worktree retention). Safety caveat: `sparseCheckout` omits unselected subtrees; use only for self-contained edits and prefer full checkout for repo-wide or cross-module verification.

Inspect safe lifecycle activity:

```text
agy_job({
  action: "activity",
  jobId: "<job-id>",
  args: { limit: 50 } // optional: default 50, max 100; reads safe lifecycle only
})
```

Installed old cached plugins must be updated before using new controls. Capacity environment variables (`AGY_WORKER_SLOTS`, `AGY_WORKER_MIN`, `AGY_WORKER_MAX` [1..8], `AGY_WORKER_MEMORY_MB` [default 1536], `AGY_WORKER_CPU_HIGH_PERCENT` [default 90]) govern worker concurrency; overrides still obey resource pressure.

## Bundled runner

```text
node <skill-dir>/scripts/agy-delegate.mjs --cwd <absolute-workspace> --mode accept-edits --targets-json '["src/file.ts"]' [--sparse-checkout] --prompt-file <absolute-prompt-file> --timeout-seconds 300 --output-format text
```

Asynchronous callback:

```text
node <skill-dir>/scripts/agy-delegate.mjs --cwd <absolute-workspace> --mode accept-edits --targets-json '["src/file.ts"]' [--sparse-checkout] --prompt-file <absolute-prompt-file> --timeout-seconds 300 --notify-thread <thread-id> --async
```

Delete caller-owned prompt files after completion. MCP-owned temporary prompt files are deleted by the background worker.

## Headless benchmark offloading

Delegate the entire benchmark lifecycle to one Antigravity worker:

1. Probe the required port with `Test-NetConnection -Port <port> -InformationLevel Quiet`.
2. If closed and startup is in scope, start the server on the assigned shard; otherwise stop and report that no server is available.
3. Run Lighthouse or DevTools headlessly, capture only the requested metrics, and terminate the server/process tree in `finally`.
4. Return only this four-line table:

```markdown
| Score | FCP | TBT | Result / Cleanup |
|---:|---:|---:|---|
| <value> | <value> | <value> | <pass/fail> |
| — | — | — | <server stopped/unchanged> |
```

Never launch a browser on `about:blank`, leave a development server running, or stream raw audit output into Codex.
