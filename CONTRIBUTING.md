# Contributing to Antigravity Transactional Harness

Thank you for contributing to the Antigravity transactional orchestration harness (`@dedsec-terminal/agy-mcp-server` and agent delegation skills). We welcome contributions that maintain rigor, deterministic execution, and process safety across multi-agent workflows.

---

## 1. Development Setup

### Prerequisites
* **Node.js**: Version `>= 20.0.0`
* **npm**: Version `>= 9.0.0`
* **Git**: Installed and available on your `PATH`

### Initializing the Workspace
The core MCP server resides in the `mcp/` directory:

```bash
# Navigate to the MCP server package
cd mcp

# Install dependencies
npm install

# Build the bundled CommonJS server
npm run build
```

---

## 2. Architecture & Focused Change Workflow

The repository coordinates atomic subagent execution through an MCP server interface, process lease locks, transactional git worktrees, and ledger outbox logging.

### Focused Change Workflow
1. **Targeted Scope**: Always scope changes to explicit, non-overlapping target files or module prefixes. Avoid large refactors or incidental formatting changes across unrelated files.
2. **Worktree Isolation**: Never mutate shared state directly during exploratory or agent runs. The harness uses `isolation: "worktree"` for mutating delegations. Changes must be reviewed and explicitly applied.
3. **Disjoint Concurrency**: When splitting tasks across parallel workers, ensure disjoint target paths with a hard maximum of 8 worker slots, subject to adaptive CPU/memory admission (`MAX_WORKER_SLOTS = 8`).
4. **Untrusted Worker Output**: In this architecture, worker execution claims are considered untrusted until parent verification executes automated checks.

---

## 3. Required Tests & Quality Verification

Before submitting changes, ensure all type checks and test suites pass locally.

### TypeScript Type Checking
From the `mcp/` directory:
```bash
npm run check
```
*(Runs `tsc --noEmit`)*

### MCP Test Suite
From the `mcp/` directory:
```bash
npm test
```
*(Executes ledger outbox, process leases, contracts, git artifacts, runner controller, smoke, and deterministic tests)*

### Protocol Verification
To verify MCP protocol communication independently:
```bash
npm run test:protocol
```

### Root Test Aliases
These convenience entry points import the same suites already included in `npm test`; they are not additional, orphaned tests. From the workspace root directory:
```bash
node test/leases.test.mjs
node test/ledger.test.mjs
node test/worktrees.test.mjs
```

---

## 4. Commit & Pull Request Expectations

* **Commit Format**: Use concise, conventional commit prefixes:
  * `feat:` New tools, parameters, or orchestration capabilities
  * `fix:` Bug fixes, race condition patches, error recovery
  * `test:` New test cases or test harness improvements
  * `docs:` Documentation and governance updates
  * `refactor:` Targeted refactoring with zero behavioral regression
* **Pull Request Guidelines**:
  * Keep PRs small and self-contained.
  * Provide a clear description linking relevant issues and summarizing files modified.
  * Include exact commands run for verification and their pass/fail output.
  * Ensure diffs contain no dangling debugging logs, temporary artifacts, or unrelated whitespace churn.

---

## 5. Safety Boundaries

This harness operates under trusted headless execution parameters (`--dangerously-skip-permissions` for local Antigravity CLI invocations). Because of this automated power, all contributions must strictly enforce the following safety guardrails:

* **No Secrets or Credentials**: Never log, commit, mock, or transmit API keys, authentication tokens, credentials, or private personal data.
* **No Path Traversal**: Enforce strict path resolution within the declared workspace root. Reject any relative directory traversal (`..`) or paths attempting to escape bounds.
* **No Unauthorized Processes**: Never spin up persistent unmanaged background servers, headless browsers, or destructive system commands unless explicitly authorized by the task scope.
* **Preserve Concurrent Work**: Always respect existing files and edits created by concurrent workers in the repository.

---

## 6. High-Value Contribution Areas

We particularly welcome contributions in the following domains:

* **Transactional Reliability**: Strengthening ledger outbox recovery, atomic commit operations, and lease heartbeat fault tolerance.
* **Process Runner Resilience**: Enhancing subagent process lifecycle management, timeouts, and signal handling across Windows (PowerShell/CMD) and POSIX environments.
* **MCP Tooling & Protocol Fidelity**: Extending `@modelcontextprotocol/server` endpoints and schema validation in `mcp/src/index.ts`.
* **Deterministic Test Coverage**: Adding stress tests, edge-case coverage for concurrent worktrees, and ledger replay simulations in `mcp/test/` and `test/`.
* **Skill Enhancements**: Refining instructions and contracts within `skills/delegate-to-antigravity/` for predictable multi-agent delegation.
