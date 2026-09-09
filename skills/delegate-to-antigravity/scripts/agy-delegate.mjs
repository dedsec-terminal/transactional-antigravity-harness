#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { access, readFile, rmdir, stat, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";

import { classifyOutcome } from "./agy-outcome.mjs";
import {
  buildWorkerPrompt,
  completeRun,
  exactAsyncResponse,
  getRunContext,
  healthSnapshot,
  markCallbackDelivered,
  markCallbackFailed,
  persistBeforeSpawn,
  recordWorkerSpawn,
  releaseWorker,
  reserveWorker,
  resolveRunConfig,
  runJobAction,
  workerSchemaArgument,
} from "./lib/controller.mjs";
import {
  DEFAULT_MAX_WORKERS,
  recommendWorkerCapacity,
  sampleSystemCapacity,
} from "./lib/system-capacity.mjs";
import { queryProcessIdentity } from "./lib/windows-process.mjs";
import { createBoundedStreamCollector } from "./lib/storage.mjs";

const VERSION = "1.0.0";
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_PROMPT_CHARS = 100_000;
const DEFAULT_TIMEOUT_SECONDS = 300;
const WRAPPER_GRACE_MS = 5_000;
const QUEUE_TIMEOUT_MS = 30_000;
const CALLBACK_FIELD_CHARS = 1_000;

let activeChild;
let handlingSignal = false;

function fail(message, exitCode = 2) {
  process.stderr.write(`${message}\n`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (["--check", "--help", "--async", "--cleanup-prompt-file", "--internal-run", "--sparse-checkout"].includes(key)) {
      options[key.slice(2)] = true;
      continue;
    }
    if (!key.startsWith("--")) fail(`Unexpected argument: ${key}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) fail(`Missing value for ${key}`);
    options[key.slice(2)] = value;
    index += 1;
  }
  return options;
}

async function isExecutable(candidate) {
  try {
    await access(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function pathEntries() {
  return (process.env.PATH ?? "")
    .split(path.delimiter)
    .map((entry) => entry.replace(/^"|"$/g, ""))
    .filter(Boolean);
}

async function findAgy() {
  const names = process.platform === "win32" ? ["agy.exe", "agy"] : ["agy"];
  for (const directory of pathEntries()) {
    for (const name of names) {
      const candidate = path.join(directory, name);
      if (await isExecutable(candidate)) return candidate;
    }
  }
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    const candidate = path.join(process.env.LOCALAPPDATA, "agy", "bin", "agy.exe");
    if (await isExecutable(candidate)) return candidate;
  }
  return undefined;
}

function whereCandidates(name) {
  if (process.platform !== "win32") return [];
  const result = spawnSync("where.exe", [name], {
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0 || !result.stdout) return [];
  return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

async function nativeCodexCandidate(candidate) {
  if (path.extname(candidate).toLowerCase() !== ".exe") return undefined;
  if (!(await isExecutable(candidate))) return undefined;
  return { command: candidate, prefixArgs: [], displayPath: candidate };
}

async function npmShimCodexCandidate(candidate) {
  if (![".cmd", ".ps1", ""].includes(path.extname(candidate).toLowerCase())) return undefined;
  const script = path.join(path.dirname(candidate), "node_modules", "@openai", "codex", "bin", "codex.js");
  if (!(await isExecutable(script))) return undefined;
  return { command: process.execPath, prefixArgs: [script], displayPath: script };
}

async function findCodex() {
  if (process.platform === "win32") {
    const discovered = whereCandidates("codex");
    for (const candidate of discovered) {
      const resolved = await nativeCodexCandidate(candidate);
      if (resolved) return resolved;
    }
    for (const directory of pathEntries()) {
      const resolved = await nativeCodexCandidate(path.join(directory, "codex.exe"));
      if (resolved) return resolved;
    }
    for (const candidate of discovered) {
      const resolved = await npmShimCodexCandidate(candidate);
      if (resolved) return resolved;
    }
    if (process.env.APPDATA) {
      const npmRoot = path.join(process.env.APPDATA, "npm", "node_modules", "@openai", "codex");
      const vendor = path.join(
        npmRoot,
        "node_modules",
        "@openai",
        "codex-win32-x64",
        "vendor",
        "x86_64-pc-windows-msvc",
        "bin",
        "codex.exe",
      );
      const native = await nativeCodexCandidate(vendor);
      if (native) return native;
      const script = path.join(npmRoot, "bin", "codex.js");
      if (await isExecutable(script)) {
        return { command: process.execPath, prefixArgs: [script], displayPath: script };
      }
    }
    return undefined;
  }

  for (const directory of pathEntries()) {
    const candidate = path.join(directory, "codex");
    if (await isExecutable(candidate)) {
      return { command: candidate, prefixArgs: [], displayPath: candidate };
    }
  }
  return undefined;
}

function terminateProcessTree(child) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
  } else {
    child.kill("SIGTERM");
  }
}

function installSignalHandlers() {
  for (const [signal, exitCode] of [["SIGINT", 130], ["SIGTERM", 143]]) {
    process.once(signal, () => {
      if (handlingSignal) return;
      handlingSignal = true;
      terminateProcessTree(activeChild);
      process.exit(exitCode);
    });
  }
}

function run(command, args, cwd, timeoutMs, stdinText, onSpawn) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    activeChild = child;
    const stdoutCollector = createBoundedStreamCollector(MAX_OUTPUT_BYTES);
    const stderrCollector = createBoundedStreamCollector(MAX_OUTPUT_BYTES);
    let timedOut = false;
    let settled = false;

    let timer;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (activeChild === child) activeChild = undefined;
      callback();
    };

    child.stdout.on("data", (chunk) => { stdoutCollector.write(chunk); });
    child.stderr.on("data", (chunk) => { stderrCollector.write(chunk); });
    child.stdin.on("error", (error) => {
      if (error.code !== "EPIPE") finish(() => reject(error));
    });
    child.on("error", (error) => finish(() => reject(error)));
    child.on("spawn", async () => {
      try {
        if (onSpawn) await onSpawn(child);
        child.stdin.end(stdinText ?? "");
      } catch (error) {
        terminateProcessTree(child);
        finish(() => reject(error));
      }
    });

    timer = setTimeout(() => {
      timedOut = true;
      terminateProcessTree(child);
    }, timeoutMs);

    child.on("close", (exitCode) => finish(() => {
      const stdoutCapture = stdoutCollector.finish();
      const stderrCapture = stderrCollector.finish();
      resolve({
        exitCode,
        stdout: stdoutCapture.content,
        stderr: stderrCapture.content,
        stdoutBytes: stdoutCapture.totalBytes,
        stderrBytes: stderrCapture.totalBytes,
        stdoutCapture,
        stderrCapture,
        timedOut,
        truncated: stdoutCapture.truncated || stderrCapture.truncated,
      });
    }));

  });
}

async function stableProcessIdentity(pid) {
  let last;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    last = await queryProcessIdentity(pid);
    if (last.running && last.identity?.creationTime && last.identity?.executable && last.identity?.commandLine) return last.identity;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Unable to record complete process identity for PID ${pid}: ${last?.reason || last?.error || "unknown"}`);
}

function parseTerminalResult(stdout) {
  let terminal;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event?.event === "result" && event.result) terminal = event.result;
    } catch {
      // Ignore non-JSON progress lines; the terminal result is authoritative.
    }
  }
  return terminal;
}

function sanitizeLine(value, fallback) {
  const normalized = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return (normalized || fallback).slice(0, CALLBACK_FIELD_CHARS);
}

function extractHeading(response, heading) {
  const prefix = `### ${heading}:`;
  const line = String(response ?? "").split(/\r?\n/).find((candidate) => candidate.trim().startsWith(prefix));
  return line ? line.trim().slice(prefix.length).trim() : "";
}

function leanSummary(outcome) {
  const response = outcome.response ?? "";
  const files = sanitizeLine(extractHeading(response, "Files Changed"), "not reported");
  const reportedSummary = extractHeading(response, "Summary");
  const fallbackSummary = outcome.ok
    ? response
    : outcome.error || outcome.stderr || `Antigravity failed with exit code ${outcome.exitCode ?? "unknown"}`;
  const summary = sanitizeLine(reportedSummary || fallbackSummary, "no summary returned");
  const reportedVerification = extractHeading(response, "Verification");
  const verification = sanitizeLine(
    reportedVerification || `${outcome.status ?? "UNKNOWN"}; exit code ${outcome.exitCode ?? "unknown"}`,
    "not reported",
  );
  return [
    `### Files Changed: ${files}`,
    `### Summary: [Untrusted Antigravity worker report] ${summary}`,
    `### Verification: ${verification}`,
  ].join("\n");
}

async function queueCallback(codex, thread, message, cwd) {
  const args = [...codex.prefixArgs, "queue", "--thread", thread, "--message", message];
  const result = await run(codex.command, args, cwd, QUEUE_TIMEOUT_MS);
  if (result.timedOut) throw new Error("codex queue timed out after 30 seconds");
  if (result.exitCode !== 0) {
    throw new Error(`codex queue failed with exit code ${result.exitCode}: ${result.stderr.trim()}`);
  }
}

async function cleanupPromptFile(promptPath) {
  const parent = path.dirname(promptPath);
  const tempRoot = path.resolve(os.tmpdir());
  if (path.dirname(parent) !== tempRoot || !path.basename(parent).startsWith("agy-mcp-")) {
    throw new Error("--cleanup-prompt-file is restricted to agy-mcp-* directories under the system temp directory");
  }
  await unlink(promptPath).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
  await rmdir(parent).catch((error) => {
    if (!["ENOENT", "ENOTEMPTY"].includes(error.code)) throw error;
  });
}

async function spawnDetached(args, cwd) {
  const child = spawn(process.execPath, args, {
    cwd,
    env: process.env,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  child.unref();
}

installSignalHandlers();
const options = parseArgs(process.argv.slice(2));

if (options.help) {
  process.stdout.write(
    "Usage: agy-delegate.mjs --check | --job-action ACTION [--job-args-json JSON] | --cwd PATH --prompt-file PATH [--targets-json JSON] [--mode plan|accept-edits] [--isolation shared|worktree] [--sparse-checkout] [--resume-job-id ID] [--notify-thread ID --async]\n",
  );
  process.exit(0);
}

const stateRoot = process.env.AGY_STATE_ROOT || undefined;

if (options["job-action"]) {
  try {
    const args = options["job-args-json"] ? JSON.parse(options["job-args-json"]) : {};
    const codex = options["job-action"] === "reconcile" ? await findCodex() : null;
    const sender = codex ? (payload) => queueCallback(codex, payload.thread, payload.message, process.cwd()) : undefined;
    const result = await runJobAction(stateRoot, options["job-action"], args.jobId, { ...args, sender });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exit(0);
  } catch (error) { fail(error instanceof Error ? error.message : String(error), 1); }
}

const executable = await findAgy();
if (!executable) fail("Antigravity CLI was not found. Install and authenticate the official `agy` CLI first.", 1);

if (options.check) {
  const codex = await findCodex();
  const health = await healthSnapshot(stateRoot).catch((error) => ({ error: sanitizeLine(error.message) }));
  let capacity = null;
  try {
    const sample = await sampleSystemCapacity();
    capacity = recommendWorkerCapacity(sample, { activeWorkers: health?.activeSlots ?? 0 });
  } catch {
    // Keep --check available even if capacity sampling or recommendation fails.
  }
  const checkPayload = {
    available: true,
    executable,
    runnerVersion: VERSION,
    codexCallbackAvailable: Boolean(codex),
    codexExecutable: codex?.displayPath ?? null,
    isolationDefaults: { syncPlan: "shared", syncAcceptEdits: "worktree", async: "worktree" },
    ...(capacity
      ? {
          capacity,
          recommendedSlots: capacity.recommendedSlots,
          availableSlots: capacity.availableSlots,
          maxWorkers: DEFAULT_MAX_WORKERS,
        }
      : {
          capacity: null,
          maxWorkers: DEFAULT_MAX_WORKERS,
        }),
    stateRoot: process.env.AGY_STATE_ROOT || null,
    // Preserved for compatibility: health.availableSlots means physical lease capacity,
    // top-level availableSlots is load admission.
    health,
  };
  process.stdout.write(`${JSON.stringify(checkPayload)}\n`);
  process.exit(0);
}

const notifyThread = options["notify-thread"];
if (notifyThread && (notifyThread.length > 200 || /[\r\n\u0000]/.test(notifyThread))) fail("--notify-thread must be a single-line identifier of at most 200 characters");
if (options.async && !notifyThread) fail("--async requires --notify-thread");
const asyncCodex = options.async ? await findCodex() : null;
if (options.async && !asyncCodex) fail("Codex CLI was not found; asynchronous callback dispatch is unavailable.", 1);

let context;
let prompt;
if (options["internal-run"]) {
  if (!options["job-id"] || !options["attempt-id"]) fail("--internal-run requires --job-id and --attempt-id");
  context = await getRunContext(stateRoot, options["job-id"], options["attempt-id"]).catch((error) => fail(error.message, 1));
  prompt = await readFile(context.request.promptPath, "utf8");
} else {
  if (!options.cwd) fail("--cwd is required");
  const workspace = path.resolve(options.cwd);
  try { if (!(await stat(workspace)).isDirectory()) fail(`Workspace is not a directory: ${workspace}`); }
  catch { fail(`Workspace is not accessible: ${workspace}`); }
  if (!options["prompt-file"]) fail("--prompt-file is required");
  const originalPromptPath = path.resolve(options["prompt-file"]);
  try { prompt = await readFile(originalPromptPath, "utf8"); }
  catch { fail(`Prompt file is not readable: ${originalPromptPath}`); }
  if (!prompt.trim()) fail("Prompt must not be empty");
  if (prompt.length > MAX_PROMPT_CHARS) fail(`Prompt exceeds ${MAX_PROMPT_CHARS} characters`);
  try {
    context = await persistBeforeSpawn({ root: stateRoot, params: { ...options, cwd: workspace, prompt, callbackThread: notifyThread, resumeJobId: options["resume-job-id"], jobId: options["job-id"] } });
    context = await getRunContext(context.root, context.job.jobId, context.attempt.attemptId);
  } catch (error) { fail(`Failed to persist delegation: ${error instanceof Error ? error.message : String(error)}`, 1); }
  if (options["cleanup-prompt-file"]) await cleanupPromptFile(originalPromptPath).catch((error) => fail(`Failed to clean up the temporary prompt: ${error.message}`, 1));

  if (options.async) {
    const childArgs = [process.argv[1], "--internal-run", "--job-id", context.job.jobId, "--attempt-id", context.attempt.attemptId];
    if (options.agent) childArgs.push("--agent", options.agent);
    if (options.model) childArgs.push("--model", options.model);
    try { await spawnDetached(childArgs, context.request.executionCwd); }
    catch (error) {
      const failure = await completeRun(context.root, context.job.jobId, context.attempt.attemptId, { exitCode: null, stdout: "", stderr: error instanceof Error ? error.message : String(error), timedOut: false, truncated: false });
      if (failure.callback && asyncCodex) {
        try {
          await queueCallback(asyncCodex, failure.callback.thread, failure.callback.message, context.request.executionCwd);
          await markCallbackDelivered(context.root, context.job.jobId, context.attempt.attemptId);
        } catch (callbackError) { await markCallbackFailed(context.root, context.job.jobId, context.attempt.attemptId, callbackError).catch(() => {}); }
      }
      fail(`Failed to dispatch Antigravity asynchronously: ${error instanceof Error ? error.message : String(error)}`, 1);
    }
    process.stdout.write(exactAsyncResponse(notifyThread, { jobId: context.job.jobId, attempt: context.attempt.manifest.attemptIndex, isolation: context.config.isolation, initialState: "running" }));
    process.exit(0);
  }
}

const runConfig = context.config;
const outputFormat = runConfig.outputFormat;
if (!["text", "json"].includes(outputFormat)) fail(`Unsupported output format: ${outputFormat}`);
const executionCwd = context.request.executionCwd;
const agyArgs = ["--input-format", "stream-json", "--output-format", "stream-json", "--mode", runConfig.mode, "--dangerously-skip-permissions", "--print-timeout", `${runConfig.timeoutSeconds}s`, "--json-schema", workerSchemaArgument()];
if (context.request.resumeSessionId) {
  agyArgs.push("--conversation", context.request.resumeSessionId);
}
if (options.agent) agyArgs.push("--agent", options.agent);
agyArgs.push("--model", options.model || "gemini-3.8-flash-high");

let result;
try {
  const controllerIdentity = await stableProcessIdentity(process.pid);
  const reservation = await reserveWorker(context.root, context.job.jobId, context.attempt.attemptId, controllerIdentity);
  if (reservation && (reservation.acquired === false || reservation.reserved === false || reservation.success === false)) {
    throw new Error(reservation.reason || reservation.error || "Failed to reserve worker slot");
  }
  const boundedPrompt = `HARNESS WORKSPACE BOUNDARY: ${executionCwd}\n${buildWorkerPrompt(context.request, prompt)}`;
  const input = `${JSON.stringify({ event: "user", message: { content: boundedPrompt } })}\n`;
  result = await run(executable, agyArgs, executionCwd, runConfig.timeoutSeconds * 1000 + WRAPPER_GRACE_MS, input, async (child) => {
    const identity = await stableProcessIdentity(child.pid);
    await recordWorkerSpawn(context.root, context.job.jobId, context.attempt.attemptId, identity);
  });
} catch (error) {
  result = { exitCode: null, stdout: "", stderr: error instanceof Error ? error.message : String(error), timedOut: false, truncated: false };
}

const terminal = parseTerminalResult(result.stdout);
const classified = classifyOutcome(result, terminal);
result.permissionDenied = classified.permissionDenied;
let completed;
try { completed = await completeRun(context.root, context.job.jobId, context.attempt.attemptId, result); }
finally { await releaseWorker(context.root, context.job.jobId, context.attempt.attemptId).catch(() => {}); }

if (completed.callback) {
  const codex = await findCodex();
  if (codex) {
    try {
      await queueCallback(codex, completed.callback.thread, completed.callback.message, executionCwd);
      await markCallbackDelivered(context.root, context.job.jobId, context.attempt.attemptId);
    } catch (error) { await markCallbackFailed(context.root, context.job.jobId, context.attempt.attemptId, error).catch(() => {}); }
  }
}

if (result.stderr) process.stderr.write(result.stderr);
if (result.truncated) process.stderr.write("\nOutput was truncated at 2 MiB.\n");
if (outputFormat === "json") process.stdout.write(`${JSON.stringify(completed.worker ?? { status: "failure", diagnostics: [completed.protocolError] })}\n`);
else if (completed.worker?.summary) process.stdout.write(completed.worker.summary);

if (completed.execution === "timed_out") fail(`Antigravity timed out after ${runConfig.timeoutSeconds} seconds`, 124);
if (completed.execution === "denied") fail("Antigravity soft-denied a required tool in headless mode; delegation was not completed.", 126);
if (completed.execution !== "succeeded") fail(completed.protocolError || `Antigravity failed with exit code ${result.exitCode ?? "unknown"}.`, result.exitCode || 1);
process.exit(0);
