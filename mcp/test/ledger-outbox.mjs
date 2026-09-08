import test, { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

import {
  sha256,
  sha256Json,
  sha256File,
  writeJsonAtomic,
  readJson,
  appendJsonl,
  readJsonlTolerant,
  CorruptJsonlError,
  captureBoundedBuffer,
  createBoundedStreamCollector,
  MAX_STREAM_CAPTURE_BYTES,
} from '../../skills/delegate-to-antigravity/scripts/lib/storage.mjs';

import {
  LEGAL_TRANSITIONS,
  InvalidTransitionError,
  AttemptImmutableError,
  AttemptAlreadyExistsError,
  createJob,
  getJob,
  updateJobState,
  createAttempt,
  getAttempt,
  updateAttemptState,
  sealAttempt,
  evaluateJobRetention,
  collectEligibleJobs,
  checkStorageHealth,
} from '../../skills/delegate-to-antigravity/scripts/lib/ledger.mjs';

import {
  RETRY_SCHEDULE_SECONDS,
  calculateNextRetryDelaySeconds,
  enqueueOutboxRecord,
  getOutboxRecord,
  getPendingOutboxRecords,
  recordOutboxSuccess,
  recordOutboxFailure,
  hasPendingOutbox,
} from '../../skills/delegate-to-antigravity/scripts/lib/outbox.mjs';

describe('Durable Filesystem Foundation: Storage, Ledger, and Outbox', () => {
  let tmpRoot;

  beforeEach(async () => {
    tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'agy-test-ledger-'));
  });

  afterEach(async () => {
    if (tmpRoot) {
      await fsp.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  describe('1. SHA-256 Helpers', () => {
    it('computes sha256 of strings and buffers matching standard vectors', () => {
      // Empty string sha256
      const emptySha = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
      assert.equal(sha256(''), emptySha);
      assert.equal(sha256(Buffer.from('')), emptySha);

      // Known test string
      const helloSha = 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9';
      assert.equal(sha256('hello world'), helloSha);
      assert.equal(sha256(Buffer.from('hello world')), helloSha);
    });

    it('computes deterministic sha256Json regardless of object key order', () => {
      const obj1 = { b: 2, a: 1, nested: { y: 'test', x: 10 } };
      const obj2 = { nested: { x: 10, y: 'test' }, a: 1, b: 2 };
      assert.equal(sha256Json(obj1), sha256Json(obj2));

      const obj3 = { a: 1, b: 3 };
      assert.notEqual(sha256Json(obj1), sha256Json(obj3));
    });

    it('computes sha256File from streamed file content', async () => {
      const filePath = path.join(tmpRoot, 'test-file.txt');
      const content = 'antigravity sha256 streaming verification payload';
      await fsp.writeFile(filePath, content, 'utf8');

      const fileHash = await sha256File(filePath);
      const directHash = sha256(content);
      assert.equal(fileHash, directHash);
    });
  });

  describe('2. Atomic Write with Injected Retries', () => {
    it('writes atomically and fsyncs target JSON file', async () => {
      const targetPath = path.join(tmpRoot, 'atomic.json');
      const data = { ok: true, version: 1 };
      await writeJsonAtomic(targetPath, data);

      const readBack = await readJson(targetPath);
      assert.deepEqual(readBack, data);
    });

    it('retries on injected transient Windows rename failures and succeeds', async () => {
      const targetPath = path.join(tmpRoot, 'retry-atomic.json');
      const data = { successAfterRetries: true };

      let renameCalls = 0;
      const injectedRename = async (temp, dest) => {
        renameCalls++;
        if (renameCalls < 3) {
          const epermErr = new Error('EPERM: operation not permitted');
          epermErr.code = 'EPERM';
          throw epermErr;
        }
        return fsp.rename(temp, dest);
      };

      await writeJsonAtomic(targetPath, data, {
        rename: injectedRename,
        maxRetries: 5,
        baseRetryDelayMs: 5,
      });

      assert.equal(renameCalls, 3);
      const readBack = await readJson(targetPath);
      assert.deepEqual(readBack, data);
    });

    it('fails and cleans up temp file when rename retries are exhausted', async () => {
      const targetPath = path.join(tmpRoot, 'exhausted-retry.json');
      const data = { willFail: true };

      const alwaysFailRename = async () => {
        const ebusyErr = new Error('EBUSY: resource busy or locked');
        ebusyErr.code = 'EBUSY';
        throw ebusyErr;
      };

      await assert.rejects(
        () => writeJsonAtomic(targetPath, data, {
          rename: alwaysFailRename,
          maxRetries: 3,
          baseRetryDelayMs: 5,
        }),
        { code: 'EBUSY' }
      );

      // Verify no orphaned .tmp files in directory
      const files = await fsp.readdir(tmpRoot);
      const tempFiles = files.filter(f => f.endsWith('.tmp'));
      assert.equal(tempFiles.length, 0);
    });
  });

  describe('3. Transitions Across Independent Dimensions', () => {
    it('permits legal transitions in each independent dimension', async () => {
      const job = await createJob(tmpRoot, { prompt: 'transition test' });
      assert.equal(job.state.lifecycle, 'created');
      assert.equal(job.state.execution, 'pending');
      assert.equal(job.state.artifact, 'none');
      assert.equal(job.state.parentVerification, 'unverified');
      assert.equal(job.state.callback, 'none');

      // Transition lifecycle to queued
      let state = await updateJobState(tmpRoot, job.jobId, { lifecycle: 'queued' });
      assert.equal(state.lifecycle, 'queued');

      // Transition lifecycle to running and execution to dispatched
      state = await updateJobState(tmpRoot, job.jobId, {
        lifecycle: 'running',
        execution: 'dispatched',
      });
      assert.equal(state.lifecycle, 'running');
      assert.equal(state.execution, 'dispatched');

      // Transition execution to executing and artifact to pending
      state = await updateJobState(tmpRoot, job.jobId, {
        execution: 'executing',
        artifact: 'pending',
      });
      assert.equal(state.execution, 'executing');
      assert.equal(state.artifact, 'pending');

      // Transition artifact to written and parentVerification to pending
      state = await updateJobState(tmpRoot, job.jobId, {
        artifact: 'written',
        parentVerification: 'pending',
      });
      assert.equal(state.artifact, 'written');
      assert.equal(state.parentVerification, 'pending');

      // Transition parentVerification to verified and callback to pending
      state = await updateJobState(tmpRoot, job.jobId, {
        parentVerification: 'verified',
        callback: 'pending',
      });
      assert.equal(state.parentVerification, 'verified');
      assert.equal(state.callback, 'pending');

      // Complete lifecycle and callback
      state = await updateJobState(tmpRoot, job.jobId, {
        lifecycle: 'completed',
        execution: 'succeeded',
        artifact: 'verified',
        callback: 'acknowledged',
      });
      assert.equal(state.lifecycle, 'completed');
      assert.equal(state.execution, 'succeeded');
      assert.equal(state.artifact, 'verified');
      assert.equal(state.callback, 'acknowledged');
      assert.equal(state.finalized, true);
    });

    it('rejects illegal transitions with InvalidTransitionError', async () => {
      const job = await createJob(tmpRoot, { prompt: 'illegal transition test' });

      // Direct jump from created to completed without running is illegal
      await assert.rejects(
        () => updateJobState(tmpRoot, job.jobId, { lifecycle: 'completed' }),
        InvalidTransitionError
      );

      // Valid step to running
      await updateJobState(tmpRoot, job.jobId, { lifecycle: 'running' });
      // Valid step to completed
      await updateJobState(tmpRoot, job.jobId, { lifecycle: 'completed' });

      // Attempt backwards jump from completed to running
      await assert.rejects(
        () => updateJobState(tmpRoot, job.jobId, { lifecycle: 'running' }),
        InvalidTransitionError
      );

      // Transition execution from pending to succeeded
      await updateJobState(tmpRoot, job.jobId, { execution: 'succeeded' });

      // Backwards jump from terminal succeeded to pending is illegal
      await assert.rejects(
        () => updateJobState(tmpRoot, job.jobId, { execution: 'pending' }),
        InvalidTransitionError
      );
    });
  });

  describe('4. Attempt Immutability', () => {
    it('creates attempt under job directory with separate manifest/state/events', async () => {
      const job = await createJob(tmpRoot, { prompt: 'immutability test' });
      const attempt = await createAttempt(tmpRoot, job.jobId, { attemptIndex: 1 });

      assert.ok(attempt.attemptId);
      assert.equal(attempt.state.sealed, false);

      const fetched = await getAttempt(tmpRoot, job.jobId, attempt.attemptId);
      assert.equal(fetched.manifest.attemptIndex, 1);
      assert.equal(fetched.state.sealed, false);
    });

    it('prevents recreating an existing attempt ID', async () => {
      const job = await createJob(tmpRoot, { prompt: 'collision test' });
      const attempt = await createAttempt(tmpRoot, job.jobId, { attemptIndex: 1 });

      await assert.rejects(
        () => createAttempt(tmpRoot, job.jobId, { attemptId: attempt.attemptId }),
        AttemptAlreadyExistsError
      );
    });

    it('enforces immutability once attempt is sealed', async () => {
      const job = await createJob(tmpRoot, { prompt: 'seal test' });
      const attempt = await createAttempt(tmpRoot, job.jobId, { attemptIndex: 1 });

      // Active attempt can be updated
      await updateAttemptState(tmpRoot, job.jobId, attempt.attemptId, {
        execution: 'executing',
      });

      // Seal attempt
      await sealAttempt(tmpRoot, job.jobId, attempt.attemptId, {
        execution: 'succeeded',
        lifecycle: 'completed',
      });

      // Subsequent update attempts must throw AttemptImmutableError
      await assert.rejects(
        () => updateAttemptState(tmpRoot, job.jobId, attempt.attemptId, {
          execution: 'failed',
        }),
        AttemptImmutableError
      );

      // Resealing must also fail
      await assert.rejects(
        () => sealAttempt(tmpRoot, job.jobId, attempt.attemptId),
        AttemptImmutableError
      );
    });
  });

  describe('5. Append-Only JSONL & Corrupt Tail Tolerance', () => {
    it('appends and reads valid JSONL records with fsync', async () => {
      const jsonlPath = path.join(tmpRoot, 'events.jsonl');
      await appendJsonl(jsonlPath, { event: 1, msg: 'first' });
      await appendJsonl(jsonlPath, { event: 2, msg: 'second' });

      const records = await readJsonlTolerant(jsonlPath);
      assert.equal(records.length, 2);
      assert.equal(records[0].msg, 'first');
      assert.equal(records[1].msg, 'second');
      assert.equal(records.corruptTail, null);
    });

    it('tolerates and ignores only a malformed final tail', async () => {
      const jsonlPath = path.join(tmpRoot, 'tail-corrupt.jsonl');
      await appendJsonl(jsonlPath, { event: 1, valid: true });
      await appendJsonl(jsonlPath, { event: 2, valid: true });

      // Append an incomplete malformed JSON fragment as the final tail
      await fsp.appendFile(jsonlPath, '{"event": 3, "incomp', 'utf8');

      const records = await readJsonlTolerant(jsonlPath);
      assert.equal(records.length, 2);
      assert.equal(records[0].event, 1);
      assert.equal(records[1].event, 2);
      assert.equal(records.corruptTail, '{"event": 3, "incomp');

      // The original file on disk must be preserved
      const diskContent = await fsp.readFile(jsonlPath, 'utf8');
      assert.ok(diskContent.includes('{"event": 3, "incomp'));
    });

    it('throws CorruptJsonlError and preserves evidence if corruption is in the middle', async () => {
      const jsonlPath = path.join(tmpRoot, 'middle-corrupt.jsonl');
      const lines = [
        JSON.stringify({ event: 1 }),
        '<<< CORRUPT MIDDLE NON-JSON LINE >>>',
        JSON.stringify({ event: 3 }),
      ].join('\n') + '\n';

      await fsp.writeFile(jsonlPath, lines, 'utf8');

      await assert.rejects(
        () => readJsonlTolerant(jsonlPath),
        (err) => {
          assert.ok(err instanceof CorruptJsonlError);
          assert.equal(err.lineNumber, 2);
          assert.ok(err.lineContent.includes('CORRUPT MIDDLE'));
          return true;
        }
      );

      // File on disk must remain untouched (evidence preserved)
      const diskContent = await fsp.readFile(jsonlPath, 'utf8');
      assert.equal(diskContent, lines);
    });
  });

  describe('6. Bounded 2 MiB Stream Capture Truncation', () => {
    it('captures small streams completely without truncation', () => {
      const data = 'Short standard output log'.repeat(100);
      const captured = captureBoundedBuffer(data);

      assert.equal(captured.truncated, false);
      assert.equal(captured.droppedBytes, 0);
      assert.equal(captured.totalBytes, Buffer.byteLength(data));
      assert.equal(captured.content, data);
      assert.equal(captured.sha256, sha256(data));
    });

    it('truncates streams exceeding 2 MiB preserving exact head and tail with metadata', () => {
      const limit = MAX_STREAM_CAPTURE_BYTES; // 2 MiB = 2,097,152 bytes
      const totalSize = limit + 512 * 1024; // 2.5 MiB

      // Construct identifiable head and tail
      const tailPattern = 'TAIL_END_PATTERN';
      const buf = Buffer.alloc(totalSize);
      buf.fill(0x61); // 'a'
      buf.write('HEAD_START_PATTERN', 0, 'utf8');
      buf.write(tailPattern, totalSize - Buffer.byteLength(tailPattern), 'utf8');

      const captured = captureBoundedBuffer(buf, limit);

      assert.equal(captured.truncated, true);
      assert.equal(captured.totalBytes, totalSize);
      assert.equal(captured.maxBytes, limit);
      assert.equal(captured.headBytes, 1024 * 1024); // 1 MiB
      assert.equal(captured.tailBytes, 1024 * 1024); // 1 MiB
      assert.equal(captured.droppedBytes, 512 * 1024); // 0.5 MiB
      assert.equal(captured.headBytes + captured.tailBytes, limit);

      assert.ok(captured.headContent.startsWith('HEAD_START_PATTERN'));
      assert.ok(captured.tailContent.endsWith(tailPattern));
      assert.ok(captured.content.includes('[truncated 524288 bytes]'));
      assert.equal(captured.sha256, sha256(buf)); // Full stream hash
    });

    it('collects streamed chunks with bounded collector', () => {
      const limit = 1000; // Small limit for testing chunk collector
      const collector = createBoundedStreamCollector(limit);

      const chunk1 = Buffer.from('CHUNK1_HEAD_DATA_'.repeat(20)); // ~340 bytes
      const chunk2 = Buffer.from('CHUNK2_MIDDLE_DATA_'.repeat(40)); // ~760 bytes
      const chunk3 = Buffer.from('CHUNK3_TAIL_DATA_'.repeat(20)); // ~340 bytes

      collector.write(chunk1);
      collector.write(chunk2);
      collector.write(chunk3);

      const result = collector.finish();
      assert.equal(result.truncated, true);
      assert.equal(result.maxBytes, limit);
      assert.equal(result.headBytes, 500);
      assert.equal(result.tailBytes, 500);
      assert.equal(result.droppedBytes, (chunk1.length + chunk2.length + chunk3.length) - limit);
      assert.equal(result.sha256, sha256(Buffer.concat([chunk1, chunk2, chunk3])));
    });
  });

  describe('7. Outbox Keying, Hashing, and Retry Schedule', () => {
    it('keys outbox records stably by jobId+attemptId and persists sha256 hash', async () => {
      const jobId = crypto.randomUUID();
      const attemptId = crypto.randomUUID();
      const payload = { event: 'completion', status: 'SUCCESS', details: { code: 0 } };

      const record = await enqueueOutboxRecord(tmpRoot, { jobId, attemptId, payload });

      assert.equal(record.key, `${jobId}:${attemptId}`);
      assert.equal(record.jobId, jobId);
      assert.equal(record.attemptId, attemptId);
      assert.equal(record.hash, sha256Json(payload));
      assert.equal(record.attemptCount, 0);
      assert.equal(record.status, 'pending');

      const fetched = await getOutboxRecord(tmpRoot, jobId, attemptId);
      assert.deepEqual(fetched, record);
    });

    it('advances retry schedule according to [1, 2, 5, 15, 30, 60, 120, 300] seconds', async () => {
      const jobId = crypto.randomUUID();
      const attemptId = crypto.randomUUID();
      const payload = { notify: true };

      const expectedDelays = [1, 2, 5, 15, 30, 60, 120, 300];
      assert.deepEqual(RETRY_SCHEDULE_SECONDS, expectedDelays);

      await enqueueOutboxRecord(tmpRoot, { jobId, attemptId, payload });

      let baseTime = 1700000000000;

      for (let i = 0; i < expectedDelays.length; i++) {
        const expectedSec = expectedDelays[i];
        const updated = await recordOutboxFailure(tmpRoot, jobId, attemptId, new Error(`Fail ${i + 1}`), {
          now: baseTime,
          maxAttempts: 20,
        });

        assert.equal(updated.attemptCount, i + 1);
        const expectedRetryMs = baseTime + (expectedSec * 1000);
        assert.equal(Date.parse(updated.nextRetryAt), expectedRetryMs);
        assert.equal(updated.status, 'pending');
        assert.ok(updated.lastError.includes(`Fail ${i + 1}`));
      }

      // 9th failure clamps to 300 seconds
      const clamped = await recordOutboxFailure(tmpRoot, jobId, attemptId, new Error('Fail 9'), {
        now: baseTime,
        maxAttempts: 20,
      });
      assert.equal(clamped.attemptCount, 9);
      assert.equal(Date.parse(clamped.nextRetryAt), baseTime + 300 * 1000);

      // Record success
      const delivered = await recordOutboxSuccess(tmpRoot, jobId, attemptId, { now: baseTime + 1000 });
      assert.equal(delivered.status, 'delivered');
      assert.ok(delivered.deliveredAt);
    });

    it('checks pending outbox records and filters ready ones', async () => {
      const jobId = crypto.randomUUID();
      const attemptId = crypto.randomUUID();
      const now = Date.now();

      await enqueueOutboxRecord(tmpRoot, {
        jobId,
        attemptId,
        payload: { ready: true },
      }, { now: now - 1000 });

      assert.equal(await hasPendingOutbox(tmpRoot, jobId), true);

      const pending = await getPendingOutboxRecords(tmpRoot, { now });
      assert.equal(pending.length, 1);
      assert.equal(pending[0].jobId, jobId);

      await recordOutboxSuccess(tmpRoot, jobId, attemptId);
      assert.equal(await hasPendingOutbox(tmpRoot, jobId), false);
    });
  });

  describe('8. Health Checks and Retention / GC Eligibility', () => {
    it('never auto-collects active jobs', async () => {
      const job = await createJob(tmpRoot, { prompt: 'active job' });
      await updateJobState(tmpRoot, job.jobId, { lifecycle: 'running' });

      const fetched = await getJob(tmpRoot, job.jobId);
      const evalResult = evaluateJobRetention(fetched, {
        now: Date.now() + 1000000,
        retentionMs: 0,
      });

      assert.equal(evalResult.eligible, false);
      assert.ok(evalResult.reasons.includes('active'));
    });

    it('never auto-collects unfinalized jobs', async () => {
      const job = await createJob(tmpRoot, { prompt: 'unfinalized job' });
      await updateJobState(tmpRoot, job.jobId, { lifecycle: 'running' });
      await updateJobState(tmpRoot, job.jobId, {
        lifecycle: 'completed',
        finalized: false, // explicitly unfinalized
      });

      const fetched = await getJob(tmpRoot, job.jobId);
      const evalResult = evaluateJobRetention(fetched, {
        now: Date.now() + 1000000,
        retentionMs: 0,
      });

      assert.equal(evalResult.eligible, false);
      assert.ok(evalResult.reasons.includes('unfinalized'));
    });

    it('never auto-collects callback-pending jobs', async () => {
      const job = await createJob(tmpRoot, { prompt: 'callback pending job' });
      await updateJobState(tmpRoot, job.jobId, { lifecycle: 'running' });
      await updateJobState(tmpRoot, job.jobId, {
        lifecycle: 'completed',
        callback: 'pending',
      });

      const fetched = await getJob(tmpRoot, job.jobId);
      const evalResult = evaluateJobRetention(fetched, {
        now: Date.now() + 1000000,
        retentionMs: 0,
      });

      assert.equal(evalResult.eligible, false);
      assert.ok(evalResult.reasons.includes('callback_pending'));
    });

    it('never auto-collects corrupt jobs', async () => {
      const job = await createJob(tmpRoot, { prompt: 'corrupt job' });
      await updateJobState(tmpRoot, job.jobId, { lifecycle: 'running' });
      await updateJobState(tmpRoot, job.jobId, {
        lifecycle: 'completed',
        callback: 'pending',
      });
      await updateJobState(tmpRoot, job.jobId, {
        callback: 'acknowledged',
      });

      // Inject middle corruption in events.jsonl
      const eventsPath = path.join(tmpRoot, 'jobs', job.jobId, 'events.jsonl');
      await fsp.writeFile(eventsPath, '{"a":1}\nCORRUPT_MIDDLE\n{"b":2}\n', 'utf8');

      const fetched = await getJob(tmpRoot, job.jobId);
      assert.equal(fetched.corrupt, true);

      const evalResult = evaluateJobRetention(fetched, {
        now: Date.now() + 1000000,
        retentionMs: 0,
      });

      assert.equal(evalResult.eligible, false);
      assert.ok(evalResult.reasons.includes('corrupt'));
    });

    it('collects expired eligible job while preserving active, unfinalized, callback-pending, and corrupt jobs', async () => {
      const pastTime = Date.now() - 100000;
      const futureNow = Date.now();
      const retentionMs = 50000;

      // 1. Eligible job: created -> running -> completed, finalized, acknowledged, non-corrupt, old
      const eligibleJob = await createJob(tmpRoot, { prompt: 'eligible' }, { now: pastTime });
      await updateJobState(tmpRoot, eligibleJob.jobId, { lifecycle: 'running' }, { now: pastTime });
      await updateJobState(tmpRoot, eligibleJob.jobId, {
        lifecycle: 'completed',
        callback: 'pending',
      }, { now: pastTime });
      await updateJobState(tmpRoot, eligibleJob.jobId, {
        callback: 'acknowledged',
      }, { now: pastTime });

      // 2. Active job
      const activeJob = await createJob(tmpRoot, { prompt: 'active' }, { now: pastTime });
      await updateJobState(tmpRoot, activeJob.jobId, { lifecycle: 'running' }, { now: pastTime });

      // 3. Callback pending job (has pending outbox record)
      const callbackPendingJob = await createJob(tmpRoot, { prompt: 'callback' }, { now: pastTime });
      await updateJobState(tmpRoot, callbackPendingJob.jobId, { lifecycle: 'running' }, { now: pastTime });
      await updateJobState(tmpRoot, callbackPendingJob.jobId, {
        lifecycle: 'completed',
        callback: 'pending',
      }, { now: pastTime });
      await enqueueOutboxRecord(tmpRoot, {
        jobId: callbackPendingJob.jobId,
        attemptId: crypto.randomUUID(),
        payload: { test: true },
      });

      // 4. Corrupt job
      const corruptJob = await createJob(tmpRoot, { prompt: 'corrupt' }, { now: pastTime });
      await updateJobState(tmpRoot, corruptJob.jobId, { lifecycle: 'running' }, { now: pastTime });
      await updateJobState(tmpRoot, corruptJob.jobId, {
        lifecycle: 'completed',
        callback: 'pending',
      }, { now: pastTime });
      await updateJobState(tmpRoot, corruptJob.jobId, {
        callback: 'acknowledged',
      }, { now: pastTime });
      const corruptEventsPath = path.join(tmpRoot, 'jobs', corruptJob.jobId, 'events.jsonl');
      await fsp.writeFile(corruptEventsPath, '{"a":1}\nCORRUPT_MIDDLE_LINE\n{"b":2}\n', 'utf8');

      // Run GC collection
      const gcResult = await collectEligibleJobs(tmpRoot, {
        now: futureNow,
        retentionMs,
      });

      // Only eligibleJob collected
      assert.deepEqual(gcResult.collected, [eligibleJob.jobId]);

      // Verify eligible job directory is removed
      await assert.rejects(
        fsp.access(path.join(tmpRoot, 'jobs', eligibleJob.jobId)),
        { code: 'ENOENT' }
      );

      // Verify active, callback pending, and corrupt job directories STILL EXIST
      await fsp.access(path.join(tmpRoot, 'jobs', activeJob.jobId));
      await fsp.access(path.join(tmpRoot, 'jobs', callbackPendingJob.jobId));
      await fsp.access(path.join(tmpRoot, 'jobs', corruptJob.jobId));

      // Check health report
      const health = await checkStorageHealth(tmpRoot);
      assert.equal(health.healthy, true);
      assert.equal(health.totalJobs, 3);
      assert.equal(health.activeJobs, 1);
      assert.equal(health.corruptJobs, 1);
      assert.equal(health.pendingOutboxCount, 1);
    });
  });
});
