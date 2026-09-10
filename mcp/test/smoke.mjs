import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createJob, createAttempt } from '../../skills/delegate-to-antigravity/scripts/lib/ledger.mjs';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const here = path.dirname(fileURLToPath(import.meta.url));
const tsServerPath = path.resolve(here, '../src/index.ts');
const distServerPath = path.resolve(here, '../dist/server.cjs');
const nodeMajor = Number(process.versions.node.split('.')[0]);
const useTs = nodeMajor >= 22 && fs.existsSync(tsServerPath);
const serverArgs = useTs
  ? ['--experimental-strip-types', '--no-warnings', tsServerPath]
  : [distServerPath];

const protocolOnly = process.argv.includes('--protocol-only');
const asyncThreadIndex = process.argv.indexOf('--async-thread');
const asyncThread = asyncThreadIndex >= 0 ? process.argv[asyncThreadIndex + 1] : undefined;
const asyncCwdIndex = process.argv.indexOf('--async-cwd');
const asyncCwd = asyncCwdIndex >= 0 ? process.argv[asyncCwdIndex + 1] : undefined;
if (asyncThread && !asyncCwd) throw new Error('--async-thread requires --async-cwd');

const isLiveAsync = process.argv.includes('--async-live');
const callbackLog = (asyncThread && !isLiveAsync)
  ? (process.env.AGY_MCP_TEST_CALLBACK_FILE || path.resolve(asyncCwd, 'async-callback-log.json'))
  : process.env.AGY_MCP_TEST_CALLBACK_FILE;
if (callbackLog) {
  process.env.AGY_MCP_TEST_CALLBACK_FILE = callbackLog;
}

const protocolStateRoot = protocolOnly ? await fsp.mkdtemp(path.join(os.tmpdir(), 'agy-protocol-state-')) : null;
const transport = new StdioClientTransport({ command: process.execPath, args: serverArgs, env: { ...process.env, ...(protocolStateRoot ? { AGY_STATE_ROOT: protocolStateRoot } : {}) } });
const client = new Client({ name: 'agy-mcp-smoke-test', version: '1.0.0' });

try {
  await client.connect(transport);
  const tools = await client.listTools();
  assert.deepEqual(
    tools.tools.map((tool) => tool.name).sort(),
    ['agy_check', 'agy_delegate', 'agy_delegate_async', 'agy_job'],
  );

  const delegatedTool = tools.tools.find((tool) => tool.name === 'agy_delegate');
  const asyncTool = tools.tools.find((tool) => tool.name === 'agy_delegate_async');
  assert.deepEqual(delegatedTool.inputSchema.properties.mode.enum, ['plan', 'accept-edits']);
  assert.equal(delegatedTool.inputSchema.properties.mode.default, 'accept-edits');
  assert.equal(delegatedTool.inputSchema.properties.timeoutSeconds.default, 300);
  assert.deepEqual(delegatedTool.inputSchema.properties.isolation.enum, ['worktree', 'shared']);
  assert.equal(delegatedTool.inputSchema.properties.retentionMinutes.minimum, 10);
  assert.equal(delegatedTool.inputSchema.properties.retentionMinutes.maximum, 10080);
  assert.ok(delegatedTool.inputSchema.properties.targets);
  assert.equal(delegatedTool.inputSchema.properties.subagents.type, 'integer');
  assert.equal(delegatedTool.inputSchema.properties.subagents.minimum, 0);
  assert.equal(delegatedTool.inputSchema.properties.subagents.maximum, 8);
  assert.match(delegatedTool.inputSchema.properties.subagents.description, /controller auto policy/i);
  assert.equal(asyncTool.inputSchema.properties.subagents.type, 'integer');
  assert.equal(asyncTool.inputSchema.properties.subagents.minimum, 0);
  assert.equal(asyncTool.inputSchema.properties.subagents.maximum, 8);
  assert.ok(asyncTool.inputSchema.required.includes('notifyThread'));

  if (protocolOnly) {
    const job = await createJob(protocolStateRoot, { prompt: 'protocol fixture' });
    const attempt = await createAttempt(protocolStateRoot, job.jobId);
    const status = await client.callTool({ name: 'agy_job', arguments: { action: 'status', jobId: job.jobId } });
    assert.notEqual(status.isError, true);
    assert.equal(status.structuredContent.state.lifecycle, 'running');
    assert.equal(status.structuredContent.attempts[0].attemptId, attempt.attemptId);
    assert.equal(status.structuredContent.attempts[0].artifactPaths.patch, path.join(attempt.attemptDir, 'changes.patch'));
    const list = await client.callTool({ name: 'agy_job', arguments: { action: 'list' } });
    assert.notEqual(list.isError, true);
    assert.equal(list.structuredContent.jobs.length, 1);
    const cancel = await client.callTool({ name: 'agy_job', arguments: { action: 'cancel', jobId: job.jobId } });
    assert.equal(cancel.structuredContent.reason, 'no_active_worker');
    const collect = await client.callTool({ name: 'agy_job', arguments: { action: 'collect' } });
    assert.notEqual(collect.isError, true);
    assert.equal(collect.structuredContent.action, 'collect');
    assert.equal(collect.structuredContent.dryRun, true);
    assert.deepEqual(collect.structuredContent.collected, []);
    assert.ok(collect.structuredContent.skipped.some(item => item.jobId === job.jobId));
    await fsp.access(path.join(protocolStateRoot, 'jobs', job.jobId, 'state.json'));
    const invalidCollect = await client.callTool({ name: 'agy_job', arguments: {
      action: 'collect', args: { evidenceRetentionMs: -1 },
    } });
    assert.equal(invalidCollect.isError, true);
  }

  if (!protocolOnly) {
    const check = await client.callTool({ name: 'agy_check', arguments: {} });
    assert.notEqual(check.isError, true);
    const checkResult = JSON.parse(check.content[0].text);
    assert.equal(checkResult.available, true);
    assert.equal(checkResult.codexCallbackAvailable, true);
    assert.match(checkResult.executable, /agy\.exe$/i);

    const delegated = await client.callTool({
      name: 'agy_delegate',
      arguments: {
        prompt: 'Reply with exactly: AGY_MCP_OK. Do not inspect or modify files.',
        cwd: path.resolve(here, '../..'),
        mode: 'plan',
        timeoutSeconds: 180,
      },
    });
    assert.notEqual(delegated.isError, true);
    assert.match(delegated.content[0].text, /AGY_MCP_OK/);

    if (asyncThread) {
      const asyncOutput = path.join(path.resolve(asyncCwd), 'async-smoke-output.txt');
      await fsp.unlink(asyncOutput).catch(() => {});
      if (callbackLog) await fsp.unlink(callbackLog).catch(() => {});

      const asyncResult = await client.callTool({
        name: 'agy_delegate_async',
        arguments: {
          prompt: [
            `Create ${asyncOutput} containing exactly AGY_ASYNC_OK followed by one newline.`,
            'Do not inspect any unrelated path and do not run commands.',
            'Return exactly these three single-line fields:',
            `### Files Changed: ${asyncOutput}`,
            '### Summary: Wrote the asynchronous smoke-test artifact.',
            '### Verification: async-smoke-output.txt contains AGY_ASYNC_OK.',
          ].join('\n'),
          cwd: path.resolve(asyncCwd),
          notifyThread: asyncThread,
          mode: 'accept-edits',
          timeoutSeconds: 180,
        },
      });
      assert.notEqual(asyncResult.isError, true);
      const dispatched = JSON.parse(asyncResult.content[0].text);
      assert.deepEqual(dispatched, { status: 'dispatched_async', thread: asyncThread });

      const deadline = Date.now() + 15_000;
      let artifactDone = false;
      let callbackDone = false;
      let callbackPayload = null;

      while (Date.now() < deadline) {
        if (!artifactDone) {
          try {
            const content = await fsp.readFile(asyncOutput, 'utf8');
            if (content === 'AGY_ASYNC_OK\n' || content.trim() === 'AGY_ASYNC_OK') {
              artifactDone = true;
            }
          } catch {}
        }
        if (!callbackDone) {
          if (callbackLog) {
            try {
              const raw = await fsp.readFile(callbackLog, 'utf8');
              callbackPayload = JSON.parse(raw);
              callbackDone = true;
            } catch {}
          } else {
            callbackDone = true;
          }
        }
        if (artifactDone && callbackDone) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      assert.ok(artifactDone, `Expected output artifact ${asyncOutput} was not created`);
      const artifactContent = await fsp.readFile(asyncOutput, 'utf8');
      assert.equal(artifactContent, 'AGY_ASYNC_OK\n');

      const expectedCallback = [
        `### Files Changed: ${asyncOutput}`,
        '### Summary: [Untrusted Antigravity worker report] Wrote the asynchronous smoke-test artifact.',
        '### Verification: async-smoke-output.txt contains AGY_ASYNC_OK.',
      ].join('\n');
      if (callbackPayload) {
        assert.equal(callbackPayload.thread, asyncThread);
        assert.equal(callbackPayload.message, expectedCallback);

        if (callbackPayload.promptFile) {
          let promptFileExists = true;
          try {
            await fsp.stat(callbackPayload.promptFile);
          } catch (err) {
            if (err && err.code === 'ENOENT') promptFileExists = false;
          }
          assert.equal(promptFileExists, false, 'Temporary prompt file was not cleaned up');
        }
        if (callbackPayload.promptDir) {
          let promptDirExists = true;
          try {
            await fsp.stat(callbackPayload.promptDir);
          } catch (err) {
            if (err && err.code === 'ENOENT') promptDirExists = false;
          }
          assert.equal(promptDirExists, false, 'Temporary prompt directory was not cleaned up');
        }
      }

      await fsp.unlink(asyncOutput).catch(() => {});
      if (callbackLog) await fsp.unlink(callbackLog).catch(() => {});
    }
  }
  console.error('MCP smoke test passed');
} finally {
  await client.close();
  if (protocolStateRoot) await fsp.rm(protocolStateRoot, { recursive: true, force: true });
}
