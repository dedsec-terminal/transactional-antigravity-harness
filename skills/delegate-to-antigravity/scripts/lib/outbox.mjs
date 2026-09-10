import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  resolveAgyRoot,
  ensureDir,
  sha256Json,
  writeJsonAtomic,
  readJson,
  withFileLock,
} from './storage.mjs';

export const RETRY_SCHEDULE_SECONDS = [1, 2, 5, 15, 30, 60, 120, 300];

export function calculateNextRetryDelaySeconds(attemptCount) {
  if (attemptCount <= 0) return 0;
  const idx = Math.min(attemptCount - 1, RETRY_SCHEDULE_SECONDS.length - 1);
  return RETRY_SCHEDULE_SECONDS[idx];
}

export function getOutboxKey(jobId, attemptId) {
  return `${jobId}:${attemptId}`;
}

export function outboxKeyToFilename(jobId, attemptId) {
  const safeJob = encodeURIComponent(jobId).replace(/%/g, '_');
  const safeAttempt = encodeURIComponent(attemptId).replace(/%/g, '_');
  return `${safeJob}__${safeAttempt}.json`;
}

export function getOutboxDir(root) {
  return path.join(resolveAgyRoot(root), 'outbox');
}

export function getOutboxFilePath(root, jobId, attemptId) {
  return path.join(getOutboxDir(root), outboxKeyToFilename(jobId, attemptId));
}

export async function enqueueOutboxRecord(root, { jobId, attemptId, payload }, options = {}) {
  const {
    now = Date.now(),
    writeAtomic = writeJsonAtomic,
  } = options;

  if (!jobId || !attemptId) {
    throw new Error('Both jobId and attemptId are required for outbox record');
  }

  const outboxDir = getOutboxDir(root);
  await ensureDir(outboxDir);

  const hash = sha256Json(payload);
  const nowIso = new Date(now).toISOString();

  const record = {
    key: getOutboxKey(jobId, attemptId),
    jobId,
    attemptId,
    payload,
    hash,
    attemptCount: 0,
    nextRetryAt: nowIso,
    status: 'pending',
    lastError: null,
    createdAt: nowIso,
    updatedAt: nowIso,
  };

  const filePath = getOutboxFilePath(root, jobId, attemptId);
  return withFileLock(`${filePath}.lock`, async () => {
    const existing = await getOutboxRecord(root, jobId, attemptId);
    if (existing) {
      if (existing.hash !== hash) throw new Error(`Outbox record ${existing.key} already exists with different payload`);
      return existing;
    }
    await writeAtomic(filePath, record, options);
    return record;
  });
}

export async function getOutboxRecord(root, jobId, attemptId) {
  const filePath = getOutboxFilePath(root, jobId, attemptId);
  try {
    return await readJson(filePath);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return null;
    }
    throw err;
  }
}

export async function listOutboxRecords(root, { status, strict = false } = {}) {
  const outboxDir = getOutboxDir(root);
  try {
    const entries = await fsp.readdir(outboxDir, { withFileTypes: true });
    const records = [];
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.json') && !entry.name.startsWith('.')) {
        try {
          const rec = await readJson(path.join(outboxDir, entry.name));
          if (strict && (!rec || typeof rec.jobId !== 'string' || !['pending', 'in_flight', 'delivered', 'exhausted'].includes(rec.status))) {
            throw new Error(`Invalid outbox record: ${entry.name}`);
          }
          if (!status || rec.status === status) {
            records.push(rec);
          }
        } catch (error) {
          if (strict) throw error;
          // Ignore corrupt individual file during listing
        }
      }
    }
    return records;
  } catch (err) {
    if (err.code === 'ENOENT') {
      return [];
    }
    throw err;
  }
}

export async function getPendingOutboxRecords(root, { now = Date.now() } = {}) {
  const records = await listOutboxRecords(root, { status: 'pending' });
  return records.filter(r => Date.parse(r.nextRetryAt) <= now);
}

export async function recordOutboxSuccess(root, jobId, attemptId, options = {}) {
  const {
    now = Date.now(),
    writeAtomic = writeJsonAtomic,
  } = options;

  const filePath = getOutboxFilePath(root, jobId, attemptId);
  return withFileLock(`${filePath}.lock`, async () => {
    const record = await getOutboxRecord(root, jobId, attemptId);
    if (!record) throw new Error(`Outbox record not found for job ${jobId} attempt ${attemptId}`);
    if (record.status === 'delivered') return record;
    const nowIso = new Date(now).toISOString();
    record.status = 'delivered';
    record.deliveredAt = record.deliveredAt || nowIso;
    record.updatedAt = nowIso;
    record.lastError = null;
    await writeAtomic(filePath, record, options);
    return record;
  });
}

export async function recordOutboxFailure(root, jobId, attemptId, error, options = {}) {
  const {
    now = Date.now(),
    maxAttempts = 10,
    writeAtomic = writeJsonAtomic,
  } = options;

  const filePath = getOutboxFilePath(root, jobId, attemptId);
  return withFileLock(`${filePath}.lock`, async () => {
    const record = await getOutboxRecord(root, jobId, attemptId);
    if (!record) throw new Error(`Outbox record not found for job ${jobId} attempt ${attemptId}`);
    if (record.status === 'delivered') return record;
    const nowMs = typeof now === 'number' ? now : Date.parse(now);
    const nowIso = new Date(nowMs).toISOString();
    record.attemptCount += 1;
    const delaySec = calculateNextRetryDelaySeconds(record.attemptCount);
    record.nextRetryAt = new Date(nowMs + delaySec * 1000).toISOString();
    record.status = record.attemptCount >= maxAttempts ? 'exhausted' : 'pending';
    record.lastError = error ? (error.message || String(error)) : 'Unknown error';
    record.updatedAt = nowIso;
    await writeAtomic(filePath, record, options);
    return record;
  });
}

export async function hasPendingOutbox(root, jobId, options = {}) {
  const records = await listOutboxRecords(root, options);
  return records.some(
    r => r.jobId === jobId && (r.status === 'pending' || r.status === 'in_flight')
  );
}
