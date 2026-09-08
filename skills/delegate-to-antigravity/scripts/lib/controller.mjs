import fsp from "node:fs/promises";
import path from "node:path";

import { resolveAgyRoot, ensureDir, generateUuid, sha256, sha256Json, writeJsonAtomic, readJson } from "./storage.mjs";
import { createJob, createAttempt, getJob, getAttempt, getAttemptDir, listAttempts, updateJobState, updateAttemptState, sealAttempt, checkStorageHealth } from "./ledger.mjs";
import { DEFAULT_RETENTION_MINUTES, TYPED_RESULT_SCHEMA, buildFourPillarPrompt, buildCallbackMessage, normalizeTargets, parseTypedResult, resolveIsolation } from "./contracts.mjs";
import { enqueueOutboxRecord, getPendingOutboxRecords, listOutboxRecords, recordOutboxFailure, recordOutboxSuccess } from "./outbox.mjs";
import { acquireSlot, getCounts, reclaimLeases, releaseSlot } from "./leases.mjs";
import { createWorktree, finalizeWorktree, validateRepository, verifyWorktreeOwnership } from "./git-worktree.mjs";
import { captureEvidence } from "./evidence.mjs";
import { applyPatch } from "./apply.mjs";
import { terminateProcess } from "./windows-process.mjs";

export const VERSION = "1.0.0";
export const DEFAULT_TIMEOUT_SECONDS = 300;

export function sanitizeLine(value, fallback = "") {
  const text = String(value ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return (text || fallback).slice(0, 1000);
}

function parseJsonOption(value, fallback) {
  if (value === undefined) return fallback;
  return typeof value === "string" ? JSON.parse(value) : value;
}

export function resolveRunConfig(options = {}) {
  const mode = options.mode ?? "accept-edits";
  if (!["plan", "accept-edits"].includes(mode)) throw new Error(`Unsupported mode: ${mode}`);
  const asyncRun = Boolean(options.async);
  const isolation = resolveIsolation({ mode, isAsync: asyncRun, isolation: options.isolation });
  const timeoutSeconds = Number(options["timeout-seconds"] ?? options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS);
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 1800) throw new Error("--timeout-seconds must be an integer from 1 to 1800");
  const retentionMinutes = Number(options["retention-minutes"] ?? options.retentionMinutes ?? DEFAULT_RETENTION_MINUTES);
  if (!Number.isInteger(retentionMinutes) || retentionMinutes < 10 || retentionMinutes > 10080) throw new Error("--retention-minutes must be an integer from 10 to 10080");
  const targets = normalizeTargets(parseJsonOption(options["targets-json"] ?? options.targets, []));
  return { mode, async: asyncRun, isolation, timeoutSeconds, retentionMinutes, targets, outputFormat: options["output-format"] ?? options.outputFormat ?? "text" };
}

// The first line is the stable public response. MCP consumes the metadata line.
export function exactAsyncResponse(thread, metadata = {}) {
  return `${JSON.stringify({ status: "dispatched_async", thread })}\nAGY_META ${JSON.stringify(metadata)}\n`;
}

export function parseTerminalResult(stdout) {
  let terminal;
  for (const line of String(stdout ?? "").split(/\r?\n/)) {
    try {
      const event = JSON.parse(line);
      if (event?.event === "result" && event.result !== undefined) terminal = event;
    } catch {}
  }
  return terminal;
}

export function parseWorkerResult(raw) {
  const payload = raw && typeof raw === "object" && "result" in raw ? raw.result : raw;
  const candidate = payload && typeof payload === "object" && payload.structured_output
    ? payload.structured_output
    : payload && typeof payload === "object" && "response" in payload ? payload.response : payload;
  return parseTypedResult(candidate);
}

function worktreePathFor(root, repoIdentity, jobId) {
  return path.join(root, "wt", repoIdentity.id.slice(0, 8), jobId.slice(0, 8));
}

function jobMetadata(config, params, repo) {
  return { mode: config.mode, isolation: config.isolation, targets: config.targets, retentionMinutes: config.retentionMinutes, callbackThread: params.callbackThread ?? null, repoIdentity: repo?.identity ?? null, baseSha: repo?.headSha ?? null };
}

export async function persistBeforeSpawn({ root, params = {}, now = Date.now() } = {}) {
  const stateRoot = resolveAgyRoot(root);
  await ensureDir(stateRoot);
  const config = resolveRunConfig(params);
  if (!params.cwd) throw new Error("cwd is required");
  const requestedCwd = path.resolve(params.cwd);
  if (config.mode === "accept-edits" && config.targets.length === 0) throw new Error("At least one declared target is required for accept-edits mode");

  let job;
  let repo;
  let worktreePath = null;
  let attemptIndex = 1;
  let resumeSessionId = null;

  if (params.resumeJobId) {
    job = await getJob(stateRoot, params.resumeJobId);
    if (job.state.finalized || job.state.lifecycle !== "running") throw new Error(`Job ${params.resumeJobId} is finalized or not correction-capable`);
    if (job.manifest.metadata?.isolation !== "worktree" || config.isolation !== "worktree") throw new Error("Only worktree-isolated jobs can be resumed");
    if (config.mode !== job.manifest.metadata.mode) throw new Error("Resume mode does not match the recorded job mode");
    if (JSON.stringify(config.targets) !== JSON.stringify(job.manifest.metadata.targets ?? [])) throw new Error("Resume targets do not match the recorded job targets");
    repo = validateRepository(requestedCwd, { requireClean: true, expectedIdentity: job.manifest.metadata.repoIdentity });
    if (repo.repoRoot.toLowerCase() !== path.resolve(job.manifest.cwd).toLowerCase()) throw new Error("Resume workspace does not match the recorded canonical repository");
    if (repo.headSha !== job.manifest.metadata.baseSha) throw new Error("Resume repository HEAD does not match the recorded base commit");
    const attempts = await listAttempts(stateRoot, job.jobId);
    const prior = attempts.filter((item) => !item.corrupt).sort((a, b) => (a.manifest.attemptIndex ?? 0) - (b.manifest.attemptIndex ?? 0)).at(-1);
    if (!prior) throw new Error("Resume job has no valid prior attempt");
    worktreePath = prior.manifest.metadata?.worktreePath;
    await verifyWorktreeOwnership(worktreePath, { repoRoot: repo.repoRoot });
    const priorResult = await readJson(path.join(prior.attemptDir, "result.json"));
    resumeSessionId = priorResult.sessionId;
    if (!resumeSessionId) throw new Error("Prior attempt has no exact recorded Antigravity session id");
    attemptIndex = (prior.manifest.attemptIndex ?? attempts.length) + 1;
  } else {
    repo = config.isolation === "worktree" ? validateRepository(requestedCwd, { requireClean: true }) : null;
    const canonicalCwd = repo?.repoRoot ?? requestedCwd;
    job = await createJob(stateRoot, { jobId: params.jobId, cwd: canonicalCwd, prompt: null, metadata: jobMetadata(config, params, repo) }, { now });
    await updateJobState(stateRoot, job.jobId, { lifecycle: "queued" }, { now });
    if (config.isolation === "worktree") {
      worktreePath = worktreePathFor(stateRoot, repo.identity, job.jobId);
      await createWorktree({ repoRoot: repo.repoRoot, worktreePath, baseSha: repo.headSha, callerId: job.jobId });
    }
  }

  const attemptId = generateUuid();
  const executionCwd = worktreePath ?? requestedCwd;
  const attempt = await createAttempt(stateRoot, job.jobId, { attemptId, attemptIndex, metadata: { isolation: config.isolation, worktreePath, executionCwd, repoRoot: repo?.repoRoot ?? null, repoIdentity: repo?.identity ?? null, baseSha: repo?.headSha ?? job.manifest.metadata?.baseSha ?? null, targets: config.targets, resumeSessionId } }, { now });
  if (config.mode === "accept-edits") await updateAttemptState(stateRoot, job.jobId, attemptId, { artifact: "pending" }, { now });

  const prompt = String(params.prompt ?? "");
  const promptPath = path.join(attempt.attemptDir, "prompt.txt");
  await fsp.writeFile(promptPath, prompt, "utf8");
  const callbackIdentity = params.callbackThread ? sha256Json({ jobId: job.jobId, attemptId, thread: params.callbackThread }) : null;
  await writeJsonAtomic(path.join(attempt.attemptDir, "request.json"), { version: 1, jobId: job.jobId, attemptId, attemptIndex, promptPath, promptHash: sha256(prompt), callbackIdentity, callbackThread: params.callbackThread ?? null, config, executionCwd, resumeSessionId }, { now });
  return { root: stateRoot, job: await getJob(stateRoot, job.jobId), attempt: await getAttempt(stateRoot, job.jobId, attemptId), config, promptPath, executionCwd, resumeSessionId };
}

export async function getRunContext(root, jobId, attemptId) {
  const stateRoot = resolveAgyRoot(root);
  const job = await getJob(stateRoot, jobId);
  const attempt = await getAttempt(stateRoot, jobId, attemptId);
  const request = await readJson(path.join(attempt.attemptDir, "request.json"));
  return { root: stateRoot, job, attempt, request, config: request.config };
}

export function buildWorkerPrompt(request, promptText) {
  return buildFourPillarPrompt({ targets: request.config.targets, action: "Complete only the bounded task described below.", constraints: "Stay inside the assigned workspace and declared targets. No installs, servers, browsers, deployments, commits, pushes, merges, secrets, or unrelated paths unless the task explicitly authorizes them.", verification: "Run only focused checks. Return only the required typed JSON result; worker claims are untrusted until parent verification.", task: promptText });
}

export function workerSchemaArgument() { return JSON.stringify(TYPED_RESULT_SCHEMA); }

export async function recordWorkerSpawn(root, jobId, attemptId, identity) {
  const stateRoot = resolveAgyRoot(root);
  const attemptDir = getAttemptDir(stateRoot, jobId, attemptId);
  const lease = await acquireSlot({ stateRoot, jobId, attemptId, processIdentity: identity, controllerPid: process.pid, cancellationMarkerPath: path.join(attemptDir, "cancel.json") });
  if (!lease.acquired) throw new Error("All four Antigravity worker slots are occupied");
  await writeJsonAtomic(path.join(attemptDir, "worker.json"), { identity, slotId: lease.slotId, slotPath: lease.slotPath, recordedAt: new Date().toISOString() });
  await updateAttemptState(stateRoot, jobId, attemptId, { execution: "executing" });
  return lease;
}

export async function releaseWorker(root, jobId, attemptId) {
  const attemptDir = getAttemptDir(root, jobId, attemptId);
  try {
    const worker = await readJson(path.join(attemptDir, "worker.json"));
    return releaseSlot({ stateRoot: resolveAgyRoot(root), slotId: worker.slotId, jobId, attemptId });
  } catch (error) {
    if (error?.code === "ENOENT") return { released: true, missing: true };
    throw error;
  }
}

function executionState(result, protocolOkay) {
  if (result.timedOut) return "timed_out";
  if (result.permissionDenied) return "denied";
  if (result.cancelled) return "cancelled";
  return result.exitCode === 0 && protocolOkay ? "succeeded" : "failed";
}

export async function completeRun(root, jobId, attemptId, result) {
  const context = await getRunContext(root, jobId, attemptId);
  const { attempt, request } = context;
  await fsp.writeFile(path.join(attempt.attemptDir, "stdout.log"), result.stdout ?? "", "utf8");
  await fsp.writeFile(path.join(attempt.attemptDir, "stderr.log"), result.stderr ?? "", "utf8");
  let typedResult = null;
  let protocolError = null;
  try {
    const terminal = parseTerminalResult(result.stdout);
    if (!terminal) throw new Error("Antigravity returned no terminal result event");
    if (terminal.result?.status !== "SUCCESS") throw new Error(`Antigravity terminal status was ${terminal.result?.status ?? "missing"}`);
    typedResult = parseWorkerResult(terminal);
    typedResult.sessionId = terminal.session_id ?? terminal.sessionId ?? terminal.conversation_id ?? terminal.result?.session_id ?? terminal.result?.sessionId ?? terminal.result?.conversation_id ?? null;
  } catch (error) { protocolError = error instanceof Error ? error.message : String(error); }

  const execution = executionState(result, typedResult?.status === "success");
  const persistedResult = { version: 1, jobId, attemptId, execution, exitCode: result.exitCode, timedOut: Boolean(result.timedOut), truncated: Boolean(result.truncated), permissionDenied: Boolean(result.permissionDenied), protocolError, worker: typedResult, sessionId: typedResult?.sessionId ?? null, stdoutBytes: result.stdoutBytes ?? Buffer.byteLength(result.stdout ?? ""), stderrBytes: result.stderrBytes ?? Buffer.byteLength(result.stderr ?? ""), completedAt: new Date().toISOString() };
  await writeJsonAtomic(path.join(attempt.attemptDir, "result.json"), persistedResult);

  let artifactState = request.config.mode === "accept-edits" ? "missing" : "none";
  let evidence = null;
  if (request.config.mode === "accept-edits" && request.config.isolation === "worktree") {
    try {
      evidence = await captureEvidence({ worktreePath: request.executionCwd, baseSha: attempt.manifest.metadata.baseSha, declaredTargets: request.config.targets, repoRoot: attempt.manifest.metadata.repoRoot });
      await fsp.writeFile(path.join(attempt.attemptDir, "changes.patch"), evidence.patch);
      await writeJsonAtomic(path.join(attempt.attemptDir, "evidence-manifest.json"), evidence.manifest);
      await writeJsonAtomic(path.join(attempt.attemptDir, "evidence-hashes.json"), { patchHash: evidence.patchHash, manifestHash: evidence.manifestHash });
      await updateAttemptState(context.root, jobId, attemptId, { artifact: "written" });
      artifactState = "verified";
    } catch (error) {
      artifactState = "corrupt";
      await writeJsonAtomic(path.join(attempt.attemptDir, "evidence-error.json"), { message: error instanceof Error ? error.message : String(error), code: error?.code ?? null });
    }
  }

  const lifecycle = execution === "cancelled" ? "cancelled" : execution === "succeeded" ? "completed" : "failed";
  await sealAttempt(context.root, jobId, attemptId, { lifecycle, execution, artifact: artifactState, parentVerification: "pending" });
  await updateJobState(context.root, jobId, { lastAttemptId: attemptId, lastExecution: execution, lastArtifact: artifactState });
  const callbackThread = request.callbackThread;
  let callback = null;
  if (callbackThread) {
    const files = evidence?.manifest?.files ?? [];
    const fileStat = `${files.length} file(s); artifact=${path.join(attempt.attemptDir, "evidence-manifest.json")}; patch=${evidence?.patchHash?.slice(0, 8) ?? "none"}`;
    const message = buildCallbackMessage({ jobId, job: jobId, attempt: attempt.manifest.attemptIndex, execution, artifact: artifactState, claimedChangedPaths: fileStat, summary: typedResult?.summary ?? protocolError ?? "Worker produced no valid result", verification: typedResult?.verification ?? "protocol validation failed" });
    callback = { thread: callbackThread, message };
    await enqueueOutboxRecord(context.root, { jobId, attemptId, payload: callback });
    await updateJobState(context.root, jobId, { callback: "pending" });
  }
  return { ...persistedResult, evidence, artifactState, callback };
}

export async function markCallbackDelivered(root, jobId, attemptId) {
  await recordOutboxSuccess(root, jobId, attemptId);
  const job = await getJob(root, jobId);
  if (["pending", "sent"].includes(job.state.callback)) await updateJobState(root, jobId, { callback: "acknowledged" });
}

export async function markCallbackFailed(root, jobId, attemptId, error) { return recordOutboxFailure(root, jobId, attemptId, error); }

export async function retryOutbox(root, sender, now = Date.now()) {
  const stateRoot = resolveAgyRoot(root);
  const records = await getPendingOutboxRecords(stateRoot, { now });
  const results = [];
  for (const record of records) {
    try {
      await sender(record.payload, record);
      results.push(await recordOutboxSuccess(stateRoot, record.jobId, record.attemptId, { now }));
      const job = await getJob(stateRoot, record.jobId);
      if (["pending", "sent"].includes(job.state.callback)) await updateJobState(stateRoot, record.jobId, { callback: "acknowledged" }, { now });
    }
    catch (error) { results.push(await recordOutboxFailure(stateRoot, record.jobId, record.attemptId, error, { now })); }
  }
  return results;
}

async function listJobs(stateRoot) {
  const entries = await fsp.readdir(path.join(stateRoot, "jobs"), { withFileTypes: true }).catch(() => []);
  const jobs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const job = await getJob(stateRoot, entry.name);
      jobs.push({ jobId: job.jobId, lifecycle: job.state.lifecycle, lastExecution: job.state.lastExecution ?? null, lastArtifact: job.state.lastArtifact ?? null, callback: job.state.callback, activeAttemptId: job.state.activeAttemptId, finalized: job.state.finalized, updatedAt: job.state.updatedAt });
    } catch (error) { jobs.push({ jobId: entry.name, corrupt: true, error: sanitizeLine(error.message) }); }
  }
  return jobs.sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
}

async function reconcileJobs(stateRoot, options = {}) {
  const leases = await reclaimLeases({ stateRoot });
  const callbackResults = options.sender ? await retryOutbox(stateRoot, options.sender) : [];
  const recovered = [];
  for (const summary of await listJobs(stateRoot)) {
    if (summary.corrupt || !summary.activeAttemptId) continue;
    const attempt = await getAttempt(stateRoot, summary.jobId, summary.activeAttemptId).catch(() => null);
    if (!attempt || attempt.state.sealed || Date.now() - Date.parse(attempt.state.createdAt) < 30_000) continue;
    const workerPresent = await fsp.stat(path.join(attempt.attemptDir, "worker.json")).then(() => true).catch(() => false);
    if (workerPresent) continue;
    const result = await completeRun(stateRoot, summary.jobId, summary.activeAttemptId, { exitCode: null, stdout: "", stderr: "Controller process disappeared before worker identity was persisted", timedOut: false, truncated: false });
    recovered.push({ jobId: summary.jobId, attemptId: summary.activeAttemptId, execution: result.execution });
  }
  return { action: "reconcile", leases, callbacks: callbackResults, recovered };
}

export async function runJobAction(root, action, jobId, options = {}) {
  const stateRoot = resolveAgyRoot(root);
  if (action === "list") return { action, jobs: await listJobs(stateRoot) };
  if (action === "reconcile" && !jobId) return reconcileJobs(stateRoot, options);
  if (!jobId) throw new Error(`jobId is required for ${action}`);
  const job = await getJob(stateRoot, jobId);
  if (action === "status") {
    const attempts = await listAttempts(stateRoot, jobId);
    return { action, jobId, manifest: job.manifest, state: job.state, attempts: attempts.map((attempt) => ({ attemptId: attempt.attemptId, attemptIndex: attempt.manifest?.attemptIndex, state: attempt.state, artifactPaths: attempt.attemptDir ? { result: path.join(attempt.attemptDir, "result.json"), manifest: path.join(attempt.attemptDir, "evidence-manifest.json"), patch: path.join(attempt.attemptDir, "changes.patch") } : null })) };
  }
  if (action === "reconcile") return reconcileJobs(stateRoot, options);
  if (action === "cancel") {
    const attemptId = job.state.activeAttemptId;
    const attempt = await getAttempt(stateRoot, jobId, attemptId);
    if (attempt.state.sealed) return { action, jobId, cancelled: false, reason: "attempt_terminal" };
    const worker = await readJson(path.join(attempt.attemptDir, "worker.json"));
    const stopped = await terminateProcess({ pid: worker.identity.pid, identity: worker.identity, cancellationMarkerPath: path.join(attempt.attemptDir, "cancel.json") });
    if (!stopped.stopped) return { action, jobId, cancelled: false, stopped };
    await releaseWorker(stateRoot, jobId, attemptId);
    await sealAttempt(stateRoot, jobId, attemptId, { lifecycle: "cancelled", execution: "cancelled", artifact: attempt.state.artifact === "pending" ? "missing" : attempt.state.artifact, parentVerification: "pending" });
    return { action, jobId, cancelled: true, stopped };
  }
  if (action === "finalize") {
    if (job.state.finalized) return { action, jobId, finalized: true, alreadyFinalized: true };
    let activeAttempt = null;
    if (job.state.activeAttemptId) {
      activeAttempt = await getAttempt(stateRoot, jobId, job.state.activeAttemptId);
      if (!activeAttempt.state.sealed) return { action, jobId, finalized: false, blocked: true, reason: "active_attempt_running", attemptId: job.state.activeAttemptId };
    }
    const attemptId = options.attemptId ?? job.state.activeAttemptId ?? job.state.lastAttemptId;
    const attempt = (activeAttempt && attemptId === job.state.activeAttemptId) ? activeAttempt : await getAttempt(stateRoot, jobId, attemptId);
    if (!attempt.state.sealed) return { action, jobId, finalized: false, blocked: true, reason: "active_attempt_running", attemptId };
    let cleanup = { status: "not_required" };
    const worktreePath = attempt.manifest.metadata?.worktreePath;
    if (worktreePath) {
      cleanup = await finalizeWorktree(worktreePath, { repoRoot: job.manifest.cwd });
      if (cleanup.status === "pending_prune") return { action, jobId, finalized: false, cleanup };
    }
    await updateJobState(stateRoot, jobId, { lifecycle: "completed", finalized: true });
    return { action, jobId, finalized: true, cleanup };
  }
  const attemptId = options.attemptId ?? job.state.activeAttemptId ?? job.state.lastAttemptId;
  const attempt = await getAttempt(stateRoot, jobId, attemptId);
  if (action === "apply") {
    if (!attempt.state.sealed || attempt.state.execution !== "succeeded" || attempt.state.artifact !== "verified") return { action, jobId, applied: false, blocked: true, reasons: ["ATTEMPT_NOT_APPLYABLE"] };
    const targetRepo = validateRepository(options.targetRepoPath ?? job.manifest.cwd, { expectedIdentity: job.manifest.metadata.repoIdentity });
    if (targetRepo.repoRoot.toLowerCase() !== path.resolve(job.manifest.cwd).toLowerCase()) return { action, jobId, applied: false, blocked: true, reasons: ["REPOSITORY_IDENTITY_MISMATCH"] };
    const patchBuffer = await fsp.readFile(path.join(attempt.attemptDir, "changes.patch"));
    const manifest = await readJson(path.join(attempt.attemptDir, "evidence-manifest.json"));
    const hashes = await readJson(path.join(attempt.attemptDir, "evidence-hashes.json"));
    const result = await applyPatch({ targetRepoPath: targetRepo.repoRoot, patch: patchBuffer, manifest, manifestHash: hashes.manifestHash, expectedBaseSha: job.manifest.metadata.baseSha });
    if (result.success) await updateJobState(stateRoot, jobId, { appliedAttemptId: attemptId, appliedAt: result.appliedAt });
    return { action, jobId, attemptId, ...result };
  }
  throw new Error(`Unsupported job action: ${action}`);
}

export async function healthSnapshot(root) {
  const stateRoot = resolveAgyRoot(root);
  const [storage, slots, outbox] = await Promise.all([checkStorageHealth(stateRoot), getCounts({ stateRoot }), listOutboxRecords(stateRoot)]);
  return { ledger: storage, activeSlots: slots.activeCount, availableSlots: slots.availableCount, orphanCount: slots.orphanCount ?? 0, callbackBacklog: outbox.filter((record) => record.status === "pending").length, pendingPruneCount: 0 };
}

export function buildCallback(outcome) { return buildCallbackMessage({ ...outcome, parent: outcome.parent ?? "pending" }); }
