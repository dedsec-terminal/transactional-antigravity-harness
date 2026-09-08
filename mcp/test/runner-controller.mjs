import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  completeRun,
  exactAsyncResponse,
  getRunContext,
  persistBeforeSpawn,
  resolveRunConfig,
  retryOutbox,
  runJobAction,
} from "../../skills/delegate-to-antigravity/scripts/lib/controller.mjs";
import { runGit } from "../../skills/delegate-to-antigravity/scripts/lib/git-worktree.mjs";

async function tempRoot(prefix) { return fsp.mkdtemp(path.join(os.tmpdir(), prefix)); }

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
