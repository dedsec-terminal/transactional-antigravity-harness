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
  await fsp.writeFile(path.join(repo, "owned.txt"), "before\n");
  await fsp.writeFile(path.join(repo, "unrelated.txt"), "keep\n");
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
