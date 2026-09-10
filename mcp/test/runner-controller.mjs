import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  buildWorkerPrompt,
  completeRun,
  exactAsyncResponse,
  getRunContext,
  persistBeforeSpawn,
  recordWorkerSpawn,
  releaseWorker,
  reserveWorker,
  resolveRunConfig,
  retryOutbox,
  runJobAction,
} from "../../skills/delegate-to-antigravity/scripts/lib/controller.mjs";
import { readActivityEvents } from "../../skills/delegate-to-antigravity/scripts/lib/activity.mjs";
import { runGit, finalizeWorktree, verifyWorktreeOwnership } from "../../skills/delegate-to-antigravity/scripts/lib/git-worktree.mjs";
import { collectEligibleJobs } from "../../skills/delegate-to-antigravity/scripts/lib/ledger.mjs";
import { createJob, updateJobState } from "../../skills/delegate-to-antigravity/scripts/lib/ledger.mjs";
import { getActiveCount } from "../../skills/delegate-to-antigravity/scripts/lib/leases.mjs";

async function tempRoot(prefix) { return fsp.mkdtemp(path.join(os.tmpdir(), prefix)); }

test('CLI timeout warnings and fatal stderr cannot become successful attempts', async () => {
  const root = await tempRoot('agy-cli-outcome-');
  try {
    for (const [stderr, expected] of [
      ['Warning: --print-timeout expired; returning partial output.', 'timed_out'],
      ['error: model request failed', 'failed'],
    ]) {
      const prepared = await persistBeforeSpawn({ root, params: { cwd: root, mode: 'plan', prompt: 'fixture' } });
      const result = await completeRun(root, prepared.job.jobId, prepared.attempt.attemptId, {
        exitCode: 0, stdout: terminal({ status: 'success', summary: 'partial', verification: 'unverified', claimedChangedPaths: [] }),
        stderr, timedOut: false, truncated: false,
      });
      assert.equal(result.execution, expected);
    }
  } finally { await fsp.rm(root, { recursive: true, force: true }); }
});

test('collect preserves expired evidence when callback records are corrupt', async () => {
  const root = await tempRoot('agy-corrupt-outbox-');
  try {
    const old = Date.now() - 20 * 86400000;
    const job = await createJob(root, {}, { now: old });
    await updateJobState(root, job.jobId, { lifecycle: 'running' }, { now: old });
    await updateJobState(root, job.jobId, { lifecycle: 'completed' }, { now: old });
    await fsp.mkdir(path.join(root, 'outbox'));
    await fsp.writeFile(path.join(root, 'outbox', 'unknown.json'), '{malformed');
    const result = await runJobAction(root, 'collect', undefined, { dryRun: false });
    assert.deepEqual(result.collected, []);
    await fsp.access(path.join(root, 'jobs', job.jobId, 'state.json'));
    for (const options of [{ evidenceRetentionMs: false }, { retentionMs: '0' }, { dryRun: 'false' }]) {
      await assert.rejects(runJobAction(root, 'collect', undefined, options));
    }
  } finally { await fsp.rm(root, { recursive: true, force: true }); }
});

async function initRepo() {
  const repo = await tempRoot("agy-controller-repo-");
  runGit(["init"], { cwd: repo });
  runGit(["config", "user.name", "Harness Test"], { cwd: repo });
  runGit(["config", "user.email", "harness@example.invalid"], { cwd: repo });
  runGit(["config", "core.autocrlf", "false"], { cwd: repo });
  await fsp.writeFile(path.join(repo, "owned.txt"), "before\n");
  await fsp.writeFile(path.join(repo, "unrelated.txt"), "keep\n");
  await fsp.mkdir(path.join(repo, "pkg"), { recursive: true });
  await fsp.writeFile(path.join(repo, "pkg", "feature.txt"), "feature\n");
  await fsp.mkdir(path.join(repo, "subtree"), { recursive: true });
  await fsp.writeFile(path.join(repo, "subtree", "nested.txt"), "nested keep\n");
  runGit(["add", "-A"], { cwd: repo });
  runGit(["commit", "-m", "base"], { cwd: repo });
  return repo;
}

function terminal(worker, sessionId = "session-1") {
  return `${JSON.stringify({ event: "result", session_id: sessionId, result: { status: "SUCCESS", response: JSON.stringify(worker) } })}\n`;
}

test("safe defaults, retention bounds, and exact async public response", () => {
  assert.equal(resolveRunConfig({ mode: "plan" }).isolation, "shared");
  assert.equal(resolveRunConfig({ mode: "accept-edits", targets: ["a.txt"] }).isolation, "worktree");
  assert.equal(resolveRunConfig({ mode: "plan" }).sparseCheckout, false);
  assert.equal(resolveRunConfig({ mode: "accept-edits", targets: ["a.txt"] }).sparseCheckout, false);
  assert.equal(resolveRunConfig({ mode: "accept-edits", targets: ["a.txt"], sparseCheckout: true }).sparseCheckout, true);
  assert.equal(resolveRunConfig({ mode: "accept-edits", targets: ["a.txt"], "sparse-checkout": true }).sparseCheckout, true);
  assert.throws(() => resolveRunConfig({ mode: "plan", sparseCheckout: true, targets: ["a.txt"] }), /sparseCheckout requires worktree isolation/);
  assert.throws(() => resolveRunConfig({ mode: "accept-edits", isolation: "shared", sparseCheckout: true, targets: ["a.txt"] }), /sparseCheckout requires worktree isolation|Unsafe isolation/);
  assert.throws(() => resolveRunConfig({ mode: "accept-edits", sparseCheckout: true, targets: [] }), /sparseCheckout requires at least one declared target/);
  assert.throws(() => resolveRunConfig({ mode: "plan", isolation: "worktree", sparseCheckout: true, targets: [] }), /sparseCheckout requires at least one declared target/);
  assert.throws(() => resolveRunConfig({ mode: "accept-edits", targets: ["a.txt"], sparseCheckout: "not-bool" }), /--sparse-checkout must be a boolean/);
  assert.throws(() => resolveRunConfig({ mode: "accept-edits", isolation: "shared", targets: ["a.txt"] }), /Unsafe isolation/);
  assert.throws(() => resolveRunConfig({ mode: "plan", retentionMinutes: 9 }), /10 to 10080/);
  const output = exactAsyncResponse("thread-1", { jobId: "job-1", attempt: 1 });
  assert.deepEqual(JSON.parse(output.split(/\r?\n/)[0]), { status: "dispatched_async", thread: "thread-1" });
  assert.match(output.split(/\r?\n/)[1], /^AGY_META /);
});

test("retention collection validates defaults and malformed options", async () => {
  const root = await tempRoot("agy-retention-options-");
  try {
    const preview = await collectEligibleJobs(root, { dryRun: true });
    assert.deepEqual(preview, { collected: [], skipped: [], worktrees: [] });
    await assert.rejects(collectEligibleJobs(root, { evidenceRetentionMs: Number.NaN }), /finite/);
    await assert.rejects(collectEligibleJobs(root, { worktreeRetentionMs: -1 }), /non-negative/);
    await assert.rejects(collectEligibleJobs(root, { dryRun: "false" }), /boolean/);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("shared plan persists before execution and seals immutable typed result", async () => {
  const root = await tempRoot("agy-controller-state-");
  const workspace = await tempRoot("agy-controller-workspace-");
  try {
    const prepared = await persistBeforeSpawn({ root, params: { cwd: workspace, mode: "plan", prompt: "inspect", callbackThread: "thread-plan" } });
    const context = await getRunContext(root, prepared.job.jobId, prepared.attempt.attemptId);
    assert.equal(await fsp.readFile(context.request.promptPath, "utf8"), "inspect");
    assert.equal(context.attempt.state.execution, "pending");
    const completed = await completeRun(root, prepared.job.jobId, prepared.attempt.attemptId, {
      exitCode: 0,
      stdout: terminal({ status: "success", summary: "inspected", verification: "unit", diagnostics: [], claimedChangedPaths: [] }),
      stderr: "",
      timedOut: false,
      truncated: false,
    });
    assert.equal(completed.execution, "succeeded");
    const status = await runJobAction(root, "status", prepared.job.jobId);
    assert.equal(status.attempts[0].state.sealed, true);
    assert.equal(status.attempts[0].state.parentVerification, "pending");
    const delivered = [];
    await retryOutbox(root, async (payload) => delivered.push(payload), Date.now() + 1000);
    assert.equal(delivered.length, 1);
    const refreshed = await runJobAction(root, "status", prepared.job.jobId);
    assert.equal(refreshed.state.callback, "acknowledged");
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
    await fsp.rm(workspace, { recursive: true, force: true });
  }
});

test("isolated mutation captures, applies, preserves unrelated edits, and finalizes", async () => {
  const root = await tempRoot("agy-controller-state-");
  const repo = await initRepo();
  const alternate = await tempRoot("agy-controller-alternate-");
  try {
    const prepared = await persistBeforeSpawn({ root, params: { cwd: repo, mode: "accept-edits", targets: ["owned.txt"], prompt: "edit owned" } });
    assert.notEqual(prepared.executionCwd.toLowerCase(), repo.toLowerCase());
    const prematureFinalize = await runJobAction(root, "finalize", prepared.job.jobId);
    assert.deepEqual({ finalized: prematureFinalize.finalized, blocked: prematureFinalize.blocked, reason: prematureFinalize.reason }, { finalized: false, blocked: true, reason: "active_attempt_running" });
    await fsp.writeFile(path.join(prepared.executionCwd, "owned.txt"), "after\n");
    const completed = await completeRun(root, prepared.job.jobId, prepared.attempt.attemptId, {
      exitCode: 0,
      stdout: terminal({ status: "success", summary: "edited", verification: "checked", diagnostics: [], claimedChangedPaths: ["owned.txt"] }),
      stderr: "",
      timedOut: false,
      truncated: false,
    });
    assert.equal(completed.artifactState, "verified");
    assert.equal(completed.evidence.manifest.hasOutOfTarget, false);
    await fsp.rm(alternate, { recursive: true, force: true });
    runGit(["clone", repo, alternate], { cwd: path.dirname(alternate) });
    await assert.rejects(runJobAction(root, "apply", prepared.job.jobId, { targetRepoPath: alternate }), /identity mismatch/i);
    await fsp.writeFile(path.join(repo, "unrelated.txt"), "user edit\n");
    const applied = await runJobAction(root, "apply", prepared.job.jobId);
    assert.equal(applied.success, true);
    assert.equal(await fsp.readFile(path.join(repo, "owned.txt"), "utf8"), "after\n");
    assert.equal(await fsp.readFile(path.join(repo, "unrelated.txt"), "utf8"), "user edit\n");
    const finalized = await runJobAction(root, "finalize", prepared.job.jobId);
    assert.equal(finalized.finalized, true);
    await assert.rejects(fsp.stat(prepared.executionCwd), { code: "ENOENT" });
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
    await fsp.rm(repo, { recursive: true, force: true });
    await fsp.rm(alternate, { recursive: true, force: true });
  }
});

test("out-of-target evidence is preserved but blocks apply", async () => {
  const root = await tempRoot("agy-controller-state-");
  const repo = await initRepo();
  try {
    const prepared = await persistBeforeSpawn({ root, params: { cwd: repo, mode: "accept-edits", targets: ["owned.txt"], prompt: "bad edit" } });
    await fsp.writeFile(path.join(prepared.executionCwd, "unrelated.txt"), "worker escape\n");
    const completed = await completeRun(root, prepared.job.jobId, prepared.attempt.attemptId, {
      exitCode: 0,
      stdout: terminal({ status: "success", summary: "claimed", verification: "claimed", diagnostics: [], claimedChangedPaths: ["owned.txt"] }),
      stderr: "",
      timedOut: false,
      truncated: false,
    });
    assert.equal(completed.evidence.manifest.hasOutOfTarget, true);
    const applied = await runJobAction(root, "apply", prepared.job.jobId);
    assert.equal(applied.success, false);
    assert.deepEqual(applied.reasons, ["OUT_OF_TARGET_CHANGES"]);
    await assert.rejects(
      persistBeforeSpawn({ root, params: { cwd: repo, mode: "accept-edits", targets: ["unrelated.txt"], prompt: "wrong scope", resumeJobId: prepared.job.jobId } }),
      /targets do not match/,
    );
    await fsp.writeFile(path.join(repo, "owned.txt"), "new canonical commit\n");
    runGit(["add", "-A"], { cwd: repo });
    runGit(["commit", "-m", "advance head"], { cwd: repo });
    await assert.rejects(
      persistBeforeSpawn({ root, params: { cwd: repo, mode: "accept-edits", targets: ["owned.txt"], prompt: "stale base", resumeJobId: prepared.job.jobId } }),
      /HEAD does not match/,
    );
    await runJobAction(root, "finalize", prepared.job.jobId);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
    await fsp.rm(repo, { recursive: true, force: true });
  }
});

test("failed worker evidence is retained but never applyable", async () => {
  const root = await tempRoot("agy-controller-state-");
  const repo = await initRepo();
  try {
    const prepared = await persistBeforeSpawn({ root, params: { cwd: repo, mode: "accept-edits", targets: ["owned.txt"], prompt: "failing edit" } });
    await fsp.writeFile(path.join(prepared.executionCwd, "owned.txt"), "partial\n");
    const completed = await completeRun(root, prepared.job.jobId, prepared.attempt.attemptId, {
      exitCode: 0,
      stdout: terminal({ status: "failure", summary: "failed", verification: "failed", diagnostics: ["intentional"], claimedChangedPaths: ["owned.txt"] }),
      stderr: "",
      timedOut: false,
      truncated: false,
    });
    assert.equal(completed.execution, "failed");
    assert.equal(completed.artifactState, "verified");
    const applied = await runJobAction(root, "apply", prepared.job.jobId);
    assert.deepEqual({ applied: applied.applied, reasons: applied.reasons }, { applied: false, reasons: ["ATTEMPT_NOT_APPLYABLE"] });
    await runJobAction(root, "finalize", prepared.job.jobId);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
    await fsp.rm(repo, { recursive: true, force: true });
  }
});

test("finalize with old attemptId is blocked and worktree is retained while newer active attempt is unsealed", async () => {
  const root = await tempRoot("agy-controller-state-");
  const repo = await initRepo();
  try {
    const prepared = await persistBeforeSpawn({ root, params: { cwd: repo, mode: "accept-edits", targets: ["owned.txt"], prompt: "first attempt" } });
    await fsp.writeFile(path.join(prepared.executionCwd, "owned.txt"), "attempt 1 edits\n");
    const completed = await completeRun(root, prepared.job.jobId, prepared.attempt.attemptId, {
      exitCode: 0,
      stdout: terminal({ status: "success", summary: "attempt 1 done", verification: "ok", diagnostics: [], claimedChangedPaths: ["owned.txt"] }, "session-1"),
      stderr: "",
      timedOut: false,
      truncated: false,
    });
    assert.equal(completed.execution, "succeeded");

    const resumed = await persistBeforeSpawn({
      root,
      params: { cwd: repo, mode: "accept-edits", targets: ["owned.txt"], prompt: "second attempt", resumeJobId: prepared.job.jobId },
    });
    assert.equal(resumed.attempt.manifest.attemptIndex, 2);
    assert.equal(resumed.attempt.state.sealed, false);

    const status = await runJobAction(root, "status", prepared.job.jobId);
    assert.equal(status.state.activeAttemptId, resumed.attempt.attemptId);

    const blockedFinalize = await runJobAction(root, "finalize", prepared.job.jobId, { attemptId: prepared.attempt.attemptId });
    assert.deepEqual(
      { finalized: blockedFinalize.finalized, blocked: blockedFinalize.blocked, reason: blockedFinalize.reason, attemptId: blockedFinalize.attemptId },
      { finalized: false, blocked: true, reason: "active_attempt_running", attemptId: resumed.attempt.attemptId },
    );

    const worktreeStat = await fsp.stat(prepared.executionCwd);
    assert.equal(worktreeStat.isDirectory(), true);
    assert.equal(await fsp.readFile(path.join(prepared.executionCwd, "owned.txt"), "utf8"), "attempt 1 edits\n");

    const statusAfterBlocked = await runJobAction(root, "status", prepared.job.jobId);
    assert.equal(statusAfterBlocked.state.finalized, false);

    await fsp.writeFile(path.join(prepared.executionCwd, "owned.txt"), "attempt 2 edits\n");
    const completed2 = await completeRun(root, prepared.job.jobId, resumed.attempt.attemptId, {
      exitCode: 0,
      stdout: terminal({ status: "success", summary: "attempt 2 done", verification: "ok", diagnostics: [], claimedChangedPaths: ["owned.txt"] }, "session-2"),
      stderr: "",
      timedOut: false,
      truncated: false,
    });
    assert.equal(completed2.execution, "succeeded");

    const finalized = await runJobAction(root, "finalize", prepared.job.jobId, { attemptId: prepared.attempt.attemptId });
    assert.equal(finalized.finalized, true);
    await assert.rejects(fsp.stat(prepared.executionCwd), { code: "ENOENT" });
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
    await fsp.rm(repo, { recursive: true, force: true });
  }
});

test("sparse checkout defaults to false and full checkout retains unrelated subtree and supports new-file targets", async () => {
  const root = await tempRoot("agy-controller-state-");
  const repo = await initRepo();
  try {
    const prepared = await persistBeforeSpawn({
      root,
      params: { cwd: repo, mode: "accept-edits", targets: ["pkg/feature.txt"], prompt: "inspect feature" },
    });
    assert.equal(prepared.config.sparseCheckout, false);
    assert.equal(prepared.job.manifest.metadata?.sparseCheckout, false);
    assert.equal(prepared.attempt.manifest.metadata?.sparseCheckout, false);
    const context = await getRunContext(root, prepared.job.jobId, prepared.attempt.attemptId);
    assert.equal(context.config.sparseCheckout, false);

    const unrelatedStat = await fsp.stat(path.join(prepared.executionCwd, "subtree", "nested.txt"));
    assert.equal(unrelatedStat.isFile(), true);
    await runJobAction(root, "finalize", prepared.job.jobId);

    const newFileJob = await persistBeforeSpawn({
      root,
      params: { cwd: repo, mode: "accept-edits", targets: ["pkg/brand-new.txt"], prompt: "create brand-new" },
    });
    assert.equal(newFileJob.config.sparseCheckout, false);
    assert.equal(newFileJob.job.manifest.metadata?.sparseCheckout, false);
    await runJobAction(root, "finalize", newFileJob.job.jobId);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
    await fsp.rm(repo, { recursive: true, force: true });
  }
});

test("sparse true excludes unrelated subtree while missing target file throws PATH_NOT_FOUND", async () => {
  const root = await tempRoot("agy-controller-state-");
  const repo = await initRepo();
  try {
    const prepared = await persistBeforeSpawn({
      root,
      params: {
        cwd: repo,
        mode: "accept-edits",
        targets: ["pkg/feature.txt"],
        sparseCheckout: true,
        prompt: "sparse edit",
      },
    });
    assert.equal(prepared.config.sparseCheckout, true);
    assert.equal(prepared.job.manifest.metadata?.sparseCheckout, true);
    assert.equal(prepared.attempt.manifest.metadata?.sparseCheckout, true);

    const targetStat = await fsp.stat(path.join(prepared.executionCwd, "pkg", "feature.txt"));
    assert.equal(targetStat.isFile(), true);

    await assert.rejects(
      fsp.stat(path.join(prepared.executionCwd, "subtree", "nested.txt")),
      { code: "ENOENT" },
    );

    await runJobAction(root, "finalize", prepared.job.jobId);

    await assert.rejects(
      persistBeforeSpawn({
        root,
        params: {
          cwd: repo,
          mode: "accept-edits",
          targets: ["pkg/nonexistent.txt"],
          sparseCheckout: true,
          prompt: "should fail",
        },
      }),
      (err) => err.code === "PATH_NOT_FOUND" || /PATH_NOT_FOUND|not found/i.test(err.message),
    );
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
    await fsp.rm(repo, { recursive: true, force: true });
  }
});

test("resume must exactly match recorded sparseCheckout and reuse existing worktree", async () => {
  const root = await tempRoot("agy-controller-state-");
  const repo = await initRepo();
  try {
    const sparseJob = await persistBeforeSpawn({
      root,
      params: {
        cwd: repo,
        mode: "accept-edits",
        targets: ["pkg/feature.txt"],
        sparseCheckout: true,
        prompt: "sparse first attempt",
      },
    });
    await fsp.writeFile(path.join(sparseJob.executionCwd, "pkg", "feature.txt"), "updated\n");
    await completeRun(root, sparseJob.job.jobId, sparseJob.attempt.attemptId, {
      exitCode: 0,
      stdout: terminal({ status: "success", summary: "sparse attempt 1", verification: "ok", diagnostics: [], claimedChangedPaths: ["pkg/feature.txt"] }, "session-sparse-1"),
      stderr: "",
      timedOut: false,
      truncated: false,
    });

    await assert.rejects(
      persistBeforeSpawn({
        root,
        params: {
          cwd: repo,
          mode: "accept-edits",
          targets: ["pkg/feature.txt"],
          sparseCheckout: false,
          prompt: "sparse mismatch attempt",
          resumeJobId: sparseJob.job.jobId,
        },
      }),
      /Resume sparseCheckout does not match/,
    );

    const resumed = await persistBeforeSpawn({
      root,
      params: {
        cwd: repo,
        mode: "accept-edits",
        targets: ["pkg/feature.txt"],
        sparseCheckout: true,
        prompt: "sparse second attempt",
        resumeJobId: sparseJob.job.jobId,
      },
    });
    assert.equal(resumed.attempt.manifest.attemptIndex, 2);
    assert.equal(resumed.executionCwd, sparseJob.executionCwd);
    assert.equal(resumed.attempt.manifest.metadata?.sparseCheckout, true);
    assert.equal(await fsp.readFile(path.join(resumed.executionCwd, "pkg", "feature.txt"), "utf8"), "updated\n");

    await runJobAction(root, "finalize", sparseJob.job.jobId);

    const fullJob = await persistBeforeSpawn({
      root,
      params: {
        cwd: repo,
        mode: "accept-edits",
        targets: ["owned.txt"],
        prompt: "full first attempt",
      },
    });
    await completeRun(root, fullJob.job.jobId, fullJob.attempt.attemptId, {
      exitCode: 0,
      stdout: terminal({ status: "success", summary: "full attempt 1", verification: "ok", diagnostics: [], claimedChangedPaths: ["owned.txt"] }, "session-full-1"),
      stderr: "",
      timedOut: false,
      truncated: false,
    });

    await assert.rejects(
      persistBeforeSpawn({
        root,
        params: {
          cwd: repo,
          mode: "accept-edits",
          targets: ["owned.txt"],
          sparseCheckout: true,
          prompt: "full mismatch attempt",
          resumeJobId: fullJob.job.jobId,
        },
      }),
      /Resume sparseCheckout does not match/,
    );

    await runJobAction(root, "finalize", fullJob.job.jobId);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
    await fsp.rm(repo, { recursive: true, force: true });
  }
});

test("subagents config resolution and prompt constraints", () => {
  assert.equal(resolveRunConfig({ mode: "plan" }).subagents, 0);
  assert.equal(resolveRunConfig({ mode: "accept-edits", targets: ["a.txt"] }).subagents, 0);
  assert.equal(resolveRunConfig({ mode: "accept-edits", targets: ["a.txt", "b.txt"] }).subagents, 0);
  assert.equal(resolveRunConfig({ mode: "accept-edits", targets: ["a.txt", "b.txt", "c.txt"] }).subagents, 0);
  assert.equal(resolveRunConfig({ mode: "accept-edits", targets: ["1", "2", "3", "4"] }).subagents, 4);
  assert.equal(resolveRunConfig({ mode: "accept-edits", targets: ["1", "2", "3", "4", "5"] }).subagents, 4);
  assert.equal(resolveRunConfig({ mode: "accept-edits", targets: ["a.txt"], subagents: 2 }).subagents, 2);
  assert.equal(resolveRunConfig({ mode: "accept-edits", targets: ["a.txt"], "--subagents": 0 }).subagents, 0);
  assert.equal(resolveRunConfig({ mode: "accept-edits", targets: ["a.txt"], subagents: 8 }).subagents, 8);
  assert.throws(() => resolveRunConfig({ mode: "plan", subagents: -1 }), /--subagents must be an integer from 0 to 8/);
  assert.throws(() => resolveRunConfig({ mode: "plan", subagents: 9 }), /--subagents must be an integer from 0 to 8/);
  assert.throws(() => resolveRunConfig({ mode: "plan", subagents: "bad" }), /--subagents must be an integer from 0 to 8/);
  assert.throws(() => resolveRunConfig({ mode: "plan", subagents: true }), /--subagents must be an integer from 0 to 8/);

  const prompt0 = buildWorkerPrompt({ config: { targets: ["a.txt"], subagents: 0 } }, "task 0");
  assert.equal(prompt0.includes("native subagents"), false);
  assert.match(prompt0, /Explicitly prohibit reset --hard, clean -fd\/-fdx, overwrite checkout\/restore, force push, branch\/worktree deletion, canonical \.git edits\./);

  const prompt2 = buildWorkerPrompt({ config: { targets: ["a.txt", "b.txt"], subagents: 2 } }, "task 2");
  assert.match(prompt2, /May use at most 2 native subagents, assign disjoint declared-target subsets, no recursive descendants, parent returns one typed result\./);
  assert.match(prompt2, /Explicitly prohibit reset --hard, clean -fd\/-fdx, overwrite checkout\/restore, force push, branch\/worktree deletion, canonical \.git edits\./);
});

test("subagents metadata persistence, resume match enforcement, and callback linesAdded/Deleted", async () => {
  const root = await tempRoot("agy-controller-subagents-");
  const repo = await initRepo();
  try {
    const prepared = await persistBeforeSpawn({
      root,
      params: { cwd: repo, mode: "accept-edits", targets: ["owned.txt", "pkg/feature.txt"], subagents: 2, prompt: "subagent job", callbackThread: "thread-sub" },
    });
    assert.equal(prepared.config.subagents, 2);
    assert.equal(prepared.job.manifest.metadata?.subagents, 2);
    assert.equal(prepared.attempt.manifest.metadata?.subagents, 2);
    const context = await getRunContext(root, prepared.job.jobId, prepared.attempt.attemptId);
    assert.equal(context.config.subagents, 2);

    await fsp.writeFile(path.join(prepared.executionCwd, "owned.txt"), "before\nadded line\n");
    const completed = await completeRun(root, prepared.job.jobId, prepared.attempt.attemptId, {
      exitCode: 0,
      stdout: terminal({ status: "success", summary: "done", verification: "ok", diagnostics: [], claimedChangedPaths: ["owned.txt"] }),
      stderr: "",
      timedOut: false,
      truncated: false,
    });
    assert.match(completed.callback.message, /\+1\/-0/);

    await assert.rejects(
      persistBeforeSpawn({
        root,
        params: { cwd: repo, mode: "accept-edits", targets: ["owned.txt", "pkg/feature.txt"], subagents: 1, prompt: "mismatch", resumeJobId: prepared.job.jobId },
      }),
      /Resume subagents does not match the recorded job subagents/,
    );

    const resumed = await persistBeforeSpawn({
      root,
      params: { cwd: repo, mode: "accept-edits", targets: ["owned.txt", "pkg/feature.txt"], subagents: 2, prompt: "match", resumeJobId: prepared.job.jobId },
    });
    assert.equal(resumed.attempt.manifest.metadata?.subagents, 2);

    await completeRun(root, prepared.job.jobId, resumed.attempt.attemptId, {
      exitCode: 0,
      stdout: terminal({ status: "success", summary: "resumed done", verification: "ok", diagnostics: [], claimedChangedPaths: ["owned.txt"] }, "session-resumed"),
      stderr: "",
      timedOut: false,
      truncated: false,
    });

    const manifestPath = path.join(root, "jobs", prepared.job.jobId, "manifest.json");
    const manifest = JSON.parse(await fsp.readFile(manifestPath, "utf8"));
    delete manifest.metadata.subagents;
    await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

    await assert.rejects(
      persistBeforeSpawn({
        root,
        params: { cwd: repo, mode: "accept-edits", targets: ["owned.txt", "pkg/feature.txt"], subagents: 2, prompt: "legacy mismatch", resumeJobId: prepared.job.jobId },
      }),
      /Resume subagents does not match the recorded job subagents/,
    );

    const legacyResumed = await persistBeforeSpawn({
      root,
      params: { cwd: repo, mode: "accept-edits", targets: ["owned.txt", "pkg/feature.txt"], prompt: "legacy match", resumeJobId: prepared.job.jobId },
    });
    assert.equal(legacyResumed.config.subagents, 0);
    assert.equal(legacyResumed.attempt.manifest.metadata?.subagents, 0);

    await runJobAction(root, "finalize", prepared.job.jobId);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
    await fsp.rm(repo, { recursive: true, force: true });
  }
});

test("finalize survives a crash between worktree removal and the finalized state write", async () => {
  const root = await tempRoot("agy-controller-state-");
  const repo = await initRepo();
  try {
    const prepared = await persistBeforeSpawn({ root, params: { cwd: repo, mode: "accept-edits", targets: ["owned.txt"], prompt: "edit owned" } });
    await fsp.writeFile(path.join(prepared.executionCwd, "owned.txt"), "after crash\n");
    const completed = await completeRun(root, prepared.job.jobId, prepared.attempt.attemptId, {
      exitCode: 0,
      stdout: terminal({ status: "success", summary: "edited", verification: "checked", diagnostics: [], claimedChangedPaths: ["owned.txt"] }),
      stderr: "",
      timedOut: false,
      truncated: false,
    });
    assert.equal(completed.artifactState, "verified");

    // Simulate the crash: cleanup intent persisted, worktree removed, but the
    // finalized state write never happened.
    const verified = await verifyWorktreeOwnership(prepared.executionCwd, { repoRoot: repo });
    await updateJobState(root, prepared.job.jobId, {
      finalizeIntent: { worktreePath: verified.canonicalPath, marker: verified.marker, requestedAt: new Date().toISOString() },
    });
    const removed = await finalizeWorktree(prepared.executionCwd, { repoRoot: repo });
    assert.equal(removed.status, "removed");

    const retried = await runJobAction(root, "finalize", prepared.job.jobId);
    assert.equal(retried.finalized, true);
    assert.equal(retried.cleanup.reconciled, true);
    const status = await runJobAction(root, "status", prepared.job.jobId);
    assert.equal(status.state.finalized, true);
    assert.equal(status.state.finalizeIntent, null);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
    await fsp.rm(repo, { recursive: true, force: true });
  }
});

test("finalize refuses a missing worktree that was never finalized", async () => {
  const root = await tempRoot("agy-controller-state-");
  const repo = await initRepo();
  try {
    const prepared = await persistBeforeSpawn({ root, params: { cwd: repo, mode: "accept-edits", targets: ["owned.txt"], prompt: "edit owned" } });
    await fsp.writeFile(path.join(prepared.executionCwd, "owned.txt"), "after\n");
    await completeRun(root, prepared.job.jobId, prepared.attempt.attemptId, {
      exitCode: 0,
      stdout: terminal({ status: "success", summary: "edited", verification: "checked", diagnostics: [], claimedChangedPaths: ["owned.txt"] }),
      stderr: "",
      timedOut: false,
      truncated: false,
    });

    await fsp.rm(prepared.executionCwd, { recursive: true, force: true });
    await assert.rejects(
      runJobAction(root, "finalize", prepared.job.jobId),
      /WORKTREE_NOT_FOUND|not accessible/,
    );
    const status = await runJobAction(root, "status", prepared.job.jobId);
    assert.equal(status.state.finalized, false);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
    await fsp.rm(repo, { recursive: true, force: true });
  }
});

test("collect action is dry-run by default and deletes eligible evidence only when asked", async () => {
  const root = await tempRoot("agy-controller-state-");
  try {
    const old = Date.now() - 20 * 24 * 60 * 60 * 1000;
    const job = await createJob(root, { prompt: "expired" }, { now: old });
    await updateJobState(root, job.jobId, { lifecycle: "running" }, { now: old });
    await updateJobState(root, job.jobId, { lifecycle: "completed" }, { now: old });

    const dryRun = await runJobAction(root, "collect");
    assert.equal(dryRun.dryRun, true);
    assert.ok(dryRun.collected.includes(job.jobId));
    await fsp.access(path.join(root, "jobs", job.jobId));

    const applied = await runJobAction(root, "collect", undefined, { dryRun: false });
    assert.equal(applied.dryRun, false);
    assert.ok(applied.collected.includes(job.jobId));
    await assert.rejects(fsp.access(path.join(root, "jobs", job.jobId)), { code: "ENOENT" });
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("adaptive reservation activates before execution and cleans up failed persistence", async () => {
  const root = await tempRoot("agy-capacity-");
  const repo = await tempRoot("agy-capacity-repo-");
  const sample = {
    logicalCpuCount: 8,
    totalMemoryBytes: 16 * 1024 ** 3,
    freeMemoryBytes: 12 * 1024 ** 3,
    cpuUtilizationRatio: 0.1,
  };
  const controller = { pid: process.pid, creationTime: new Date().toISOString(), executable: "node", commandLine: "node test" };
  try {
    const prepared = await persistBeforeSpawn({ root, params: { cwd: repo, mode: "plan", prompt: "capacity" } });
    const reserved = await reserveWorker(root, prepared.job.jobId, prepared.attempt.attemptId, controller, { sampleSystemCapacity: () => sample });
    assert.equal(reserved.acquired, true);

    const worker = { ...controller, executable: "agy" };
    const activated = await recordWorkerSpawn(root, prepared.job.jobId, prepared.attempt.attemptId, worker);
    assert.equal(activated.acquired, true);
    const record = JSON.parse(await fsp.readFile(path.join(prepared.attempt.attemptDir, "worker.json"), "utf8"));
    assert.equal(record.phase, "active");
    assert.equal(record.identity.executable, "agy");
    assert.deepEqual((await readActivityEvents(path.join(root, "jobs", prepared.job.jobId))).map(({ phase }) => phase), ["accepted", "preparing", "running"]);
    await releaseWorker(root, prepared.job.jobId, prepared.attempt.attemptId);

    const failed = await persistBeforeSpawn({ root, params: { cwd: repo, mode: "plan", prompt: "cleanup" } });
    await fsp.mkdir(path.join(failed.attempt.attemptDir, "worker.json"));
    await assert.rejects(() => reserveWorker(root, failed.job.jobId, failed.attempt.attemptId, controller, { sampleSystemCapacity: () => sample }));
    assert.equal(await getActiveCount({ stateRoot: root, maxSlots: 8 }), 0);

    await assert.rejects(
      () => reserveWorker(root, failed.job.jobId, failed.attempt.attemptId, controller, { sampleSystemCapacity: () => sample, activeWorkers: 8 }),
      (error) => error.code === "CAPACITY_EXHAUSTED",
    );
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
    await fsp.rm(repo, { recursive: true, force: true });
  }
});
