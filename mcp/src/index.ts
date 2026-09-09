#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { access, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { constants, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';

const VERSION = '1.1.0';
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_SECONDS = 300;
const RUNNER_GRACE_MS = 10_000;

type RunResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
};

type PromptFile = {
  directory: string;
  file: string;
};

export type RunnerInput = {
  prompt: string;
  cwd: string;
  mode: 'plan' | 'accept-edits';
  outputFormat: 'text' | 'json';
  timeoutSeconds: number;
  agent?: string;
  model?: string;
  targets?: string[];
  sparseCheckout?: boolean;
  isolation?: 'worktree' | 'shared';
  resumeJobId?: string;
  retentionMinutes?: number;
  jobId?: string;
  subagents?: number;
};

export type DelegateInput = RunnerInput;

function pluginRoot(): string {
  const packageRoot = path.resolve(path.dirname(process.argv[1]), '..');
  const bundledRoot = path.join(packageRoot, 'bundle');
  if (existsSync(path.join(bundledRoot, 'skills'))) return bundledRoot;
  return path.resolve(packageRoot, '..');
}

function runnerPath(): string {
  return path.join(pluginRoot(), 'skills', 'delegate-to-antigravity', 'scripts', 'agy-delegate.mjs');
}

async function runnerAvailable(): Promise<boolean> {
  try {
    await access(runnerPath(), constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function terminateProcessTree(child: ReturnType<typeof spawn>): void {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
  } else {
    child.kill('SIGTERM');
  }
}

function runProcess(command: string, args: string[], cwd: string, timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const append = (
      current: Buffer<ArrayBufferLike>,
      chunk: Buffer<ArrayBufferLike>,
    ): Buffer<ArrayBufferLike> => {
      if (current.length >= MAX_OUTPUT_BYTES) {
        truncated = true;
        return current;
      }
      const remaining = MAX_OUTPUT_BYTES - current.length;
      if (chunk.length > remaining) truncated = true;
      return Buffer.concat([current, chunk.subarray(0, remaining)]);
    };

    let timer: NodeJS.Timeout;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };

    child.stdout.on('data', (chunk: Buffer<ArrayBufferLike>) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk: Buffer<ArrayBufferLike>) => { stderr = append(stderr, chunk); });
    child.on('error', (error) => finish(() => reject(error)));

    timer = setTimeout(() => {
      timedOut = true;
      terminateProcessTree(child);
    }, timeoutMs);

    child.on('close', (exitCode) => finish(() => resolve({
      exitCode,
      stdout: stdout.toString('utf8'),
      stderr: stderr.toString('utf8'),
      timedOut,
      truncated,
    })));
  });
}

async function createPromptFile(prompt: string): Promise<PromptFile> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agy-mcp-'));
  const file = path.join(directory, 'prompt.md');
  try {
    await writeFile(file, prompt, { encoding: 'utf8', mode: 0o600 });
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return { directory, file };
}

async function validateWorkspace(cwd: string): Promise<string> {
  if (!path.isAbsolute(cwd)) throw new Error('cwd must be an absolute path');
  const resolved = path.resolve(cwd);
  const info = await stat(resolved);
  if (!info.isDirectory()) throw new Error(`Workspace is not a directory: ${resolved}`);
  return resolved;
}

function delegateArgs(input: DelegateInput, promptFile: string): string[] {
  const args = [
    runnerPath(),
    '--cwd', input.cwd,
    '--prompt-file', promptFile,
    '--mode', input.mode,
    '--output-format', input.outputFormat,
    '--timeout-seconds', String(input.timeoutSeconds),
  ];
  if (input.agent) args.push('--agent', input.agent);
  if (input.model) args.push('--model', input.model);
  if (input.targets?.length) args.push('--targets-json', JSON.stringify(input.targets));
  if (input.sparseCheckout === true) args.push('--sparse-checkout');
  if (input.isolation) args.push('--isolation', input.isolation);
  if (input.resumeJobId) args.push('--resume-job-id', input.resumeJobId);
  if (input.retentionMinutes !== undefined) args.push('--retention-minutes', String(input.retentionMinutes));
  if (input.jobId) args.push('--job-id', input.jobId);
  if (input.subagents !== undefined) args.push('--subagents', String(input.subagents));
  return args;
}

export const serializeRunnerArgs = delegateArgs;
export { delegateArgs };

function parseAgyMeta(stdout: string): Record<string, unknown> {
  const line = stdout.split(/\r?\n/).find((value) => value.startsWith('AGY_META '));
  if (!line) return {};
  try {
    const parsed = JSON.parse(line.slice('AGY_META '.length));
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch { return {};
  }
}

function failure(message: string) {
  return {
    content: [{ type: 'text' as const, text: message }],
    isError: true,
  };
}

async function runnerCheck(): Promise<RunResult> {
  return runProcess(process.execPath, [runnerPath(), '--check'], pluginRoot(), 15_000);
}

const delegateSchema = {
  prompt: z.string().min(1).max(100_000).describe('Complete bounded task prompt'),
  cwd: z.string().min(1).describe('Absolute existing workspace directory'),
  mode: z.enum(['plan', 'accept-edits']).default('accept-edits'),
  outputFormat: z.enum(['text', 'json']).default('text'),
  timeoutSeconds: z.number().int().min(1).max(1800).default(DEFAULT_TIMEOUT_SECONDS),
  agent: z.string().min(1).max(200).optional(),
  model: z.string().min(1).max(200).optional(),
  targets: z.array(z.string().min(1).max(1000)).max(1000).optional(),
  sparseCheckout: z.boolean().optional().describe(
    'Checks out only declared targets in cone mode, includes root/ancestor/same-directory files, requires targets exist at base, full default for dependencies/new paths.',
  ),
  isolation: z.enum(['worktree', 'shared']).optional(),
  resumeJobId: z.string().min(1).max(200).optional(),
  retentionMinutes: z.number().int().min(10).max(10080).optional(),
  subagents: z.number().int().min(0).max(8).optional().describe(
    'Optional subagents limit (0..8). Omission uses controller auto policy.',
  ),
};

function createServer(): McpServer {
  const server = new McpServer(
    { name: 'agy-mcp-server', version: VERSION },
    {
      instructions:
        'Use agy_check before first delegation. This trusted local harness runs Antigravity with full headless permissions. Keep tasks bounded, use disjoint ownership, and independently verify every result.',
    },
  );

  server.registerTool(
    'agy_check',
    {
      title: 'Check Antigravity Harness',
      description: 'Verify Antigravity availability and Codex asynchronous callback readiness.',
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async () => {
      if (!(await runnerAvailable())) {
        return failure(`Antigravity runner was not found at: ${runnerPath()}`);
      }
      try {
        const result = await runnerCheck();
        const text = result.stdout.trim() || result.stderr.trim() || '(runner returned no output)';
        let structuredContent: Record<string, unknown> = {
          exitCode: result.exitCode,
          timedOut: result.timedOut,
        };
        try {
          structuredContent = { ...structuredContent, ...JSON.parse(result.stdout) };
        } catch {
          // Preserve process diagnostics when the check cannot return JSON.
        }
        return {
          content: [{ type: 'text', text }],
          structuredContent,
          isError: result.timedOut || result.exitCode !== 0,
        };
      } catch (error) {
        return failure(`Failed to run Antigravity check: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  );

  server.registerTool(
    'agy_delegate',
    {
      title: 'Delegate to Antigravity',
      description: 'Run one bounded prompt through the authorized Antigravity headless runner and return its verified process result.',
      inputSchema: z.object(delegateSchema),
      annotations: {
        readOnlyHint: false,
        openWorldHint: true,
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    async ({ prompt, cwd, mode, outputFormat, timeoutSeconds, agent, model, targets, sparseCheckout, isolation, resumeJobId, retentionMinutes, subagents }) => {
      if (!(await runnerAvailable())) return failure(`Antigravity runner was not found at: ${runnerPath()}`);
      let resolvedCwd: string;
      try {
        resolvedCwd = await validateWorkspace(cwd);
      } catch (error) {
        return failure(error instanceof Error ? error.message : String(error));
      }

      if (isolation === 'shared' && mode === 'accept-edits') return failure("Unsafe isolation: explicit 'shared' isolation is rejected for mutating 'accept-edits' mode.");
      const jobId = resumeJobId || randomUUID();
      const promptFile = await createPromptFile(prompt);
      try {
        const args = delegateArgs(
          { prompt, cwd: resolvedCwd, mode, outputFormat, timeoutSeconds, agent, model, targets, sparseCheckout, isolation, resumeJobId, retentionMinutes, jobId, subagents },
          promptFile.file,
        );
        const result = await runProcess(
          process.execPath,
          args,
          resolvedCwd,
          timeoutSeconds * 1000 + RUNNER_GRACE_MS,
        );
        const sections = [result.stdout.trim()];
        if (result.stderr.trim()) sections.push(`stderr:\n${result.stderr.trim()}`);
        if (result.truncated) sections.push('[Output truncated at 2 MiB]');
        if (result.timedOut) sections.push(`[Timed out after ${timeoutSeconds} seconds]`);
        return {
          content: [{
            type: 'text',
            text: sections.filter(Boolean).join('\n\n') || '(Antigravity returned no output)',
          }],
          structuredContent: {
            jobId,
            attempt: parseAgyMeta(result.stdout).attempt ?? 1,
            isolation: parseAgyMeta(result.stdout).isolation ?? isolation ?? (mode === 'plan' ? 'shared' : 'worktree'),
            initialState: parseAgyMeta(result.stdout).initialState ?? 'running',
            exitCode: result.exitCode,
            timedOut: result.timedOut,
            truncated: result.truncated,
            mode,
            cwd: resolvedCwd,
          },
          isError: result.timedOut || result.exitCode !== 0,
        };
      } catch (error) {
        return failure(`Failed to run Antigravity: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        await rm(promptFile.directory, { recursive: true, force: true });
      }
    },
  );

  server.registerTool(
    'agy_delegate_async',
    {
      title: 'Delegate to Antigravity Asynchronously',
      description: 'Dispatch a bounded Antigravity task in the background and notify a Codex task with a lean completion summary.',
      inputSchema: z.object({
        ...delegateSchema,
        notifyThread: z.string()
          .min(1)
          .max(200)
          .refine((value) => !/[\r\n\u0000]/.test(value), 'notifyThread must be a single-line identifier'),
      }),
      annotations: {
        readOnlyHint: false,
        openWorldHint: true,
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    async ({ prompt, cwd, mode, outputFormat, timeoutSeconds, agent, model, targets, sparseCheckout, isolation, resumeJobId, retentionMinutes, notifyThread, subagents }) => {
      if (!(await runnerAvailable())) return failure(`Antigravity runner was not found at: ${runnerPath()}`);
      let resolvedCwd: string;
      try {
        resolvedCwd = await validateWorkspace(cwd);
        const check = await runnerCheck();
        if (check.exitCode !== 0 || check.timedOut) {
          return failure(check.stderr.trim() || 'Antigravity callback preflight failed');
        }
        const readiness = JSON.parse(check.stdout) as { codexCallbackAvailable?: boolean };
        if (!readiness.codexCallbackAvailable) {
          return failure('Codex CLI was not found; asynchronous callback dispatch is unavailable.');
        }
      } catch (error) {
        return failure(error instanceof Error ? error.message : String(error));
      }

      if (isolation === 'shared') return failure("Unsafe isolation: explicit 'shared' isolation is rejected for asynchronous execution.");
      const jobId = resumeJobId || randomUUID();
      const promptFile = await createPromptFile(prompt);
      const args = delegateArgs(
        { prompt, cwd: resolvedCwd, mode, outputFormat, timeoutSeconds, agent, model, targets, sparseCheckout, isolation, resumeJobId, retentionMinutes, jobId, subagents },
        promptFile.file,
      );
      args.push('--notify-thread', notifyThread, '--cleanup-prompt-file', '--async');
      let result: RunResult;
      try {
        // The runner persists the job, prompt, attempt, callback identity, and
        // worktree before it returns this acceptance response.
        result = await runProcess(process.execPath, args, resolvedCwd, 30_000);
      } catch (error) {
        await rm(promptFile.directory, { recursive: true, force: true });
        return failure(`Failed to dispatch Antigravity: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (result.timedOut || result.exitCode !== 0) {
        await rm(promptFile.directory, { recursive: true, force: true });
        return failure(result.stderr.trim() || 'Antigravity async acceptance failed');
      }
      const firstLine = result.stdout.split(/\r?\n/).find(Boolean) ?? '';
      let dispatched: { status: string; thread: string };
      try { dispatched = JSON.parse(firstLine) as { status: string; thread: string }; }
      catch { return failure('Antigravity async acceptance returned malformed JSON'); }
      const metadata = parseAgyMeta(result.stdout);
      return {
        content: [{ type: 'text', text: JSON.stringify(dispatched) }],
        structuredContent: { ...dispatched, jobId: metadata.jobId ?? jobId, attempt: metadata.attempt ?? 1, isolation: metadata.isolation ?? isolation ?? 'worktree', initialState: metadata.initialState ?? 'running' },
      };
    },
  );

  server.registerTool('agy_job', {
    title: 'Manage Antigravity Job',
    description: 'Inspect or transition a transactional Antigravity job, or view bounded safe lifecycle events via args.limit (default50).',
    inputSchema: z.object({
      action: z.enum(['status', 'list', 'cancel', 'reconcile', 'apply', 'finalize', 'activity']),
      jobId: z.string().min(1).max(200).optional(),
      args: z.record(z.string(), z.unknown()).optional(),
    }),
    annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: true, idempotentHint: false },
  }, async ({ action, jobId, args: jobArgs }) => {
    if (!(await runnerAvailable())) return failure(`Antigravity runner was not found at: ${runnerPath()}`);
    if (!['list', 'reconcile'].includes(action) && !jobId) return failure(`jobId is required for ${action}`);
    try {
      const payload = JSON.stringify({ ...(jobArgs ?? {}), ...(jobId ? { jobId } : {}) });
      const result = await runProcess(process.execPath, [runnerPath(), '--job-action', action, '--job-args-json', payload], pluginRoot(), 30_000);
      const text = result.stdout.trim() || result.stderr.trim() || '(runner returned no output)';
      return { content: [{ type: 'text', text }], structuredContent: { action, jobId, exitCode: result.exitCode, artifactPaths: parseAgyMeta(result.stdout).artifactPaths ?? [] }, isError: result.exitCode !== 0 || result.timedOut };
    } catch (error) { return failure(`Failed to manage Antigravity job: ${error instanceof Error ? error.message : String(error)}`); }
  });

  return server;
}

void serveStdio(createServer);
console.error(`agy MCP server ${VERSION} running on stdio`);
