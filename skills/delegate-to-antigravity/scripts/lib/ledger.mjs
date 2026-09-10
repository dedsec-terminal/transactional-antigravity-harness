import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  resolveAgyRoot,
  ensureDir,
  generateUuid,
  writeJsonAtomic,
  readJson,
  appendJsonl,
  readJsonlTolerant,
  CorruptJsonlError,
  withFileLock,
} from './storage.mjs';
import { hasPendingOutbox, listOutboxRecords } from './outbox.mjs';

export const DEFAULT_EVIDENCE_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
export const DEFAULT_WORKTREE_RETENTION_MS = 24 * 60 * 60 * 1000;

export const LEGAL_TRANSITIONS = {
  lifecycle: {
    created: ['queued', 'running', 'failed', 'cancelled'],
    queued: ['running', 'cancelled', 'failed'],
    running: ['completed', 'failed', 'cancelled'],
    completed: [],
    failed: [],
    cancelled: [],
  },
  execution: {
    pending: ['dispatched', 'executing', 'succeeded', 'failed', 'timed_out', 'denied', 'cancelled'],
    dispatched: ['executing', 'succeeded', 'failed', 'timed_out', 'denied', 'cancelled'],
    executing: ['succeeded', 'failed', 'timed_out', 'denied', 'cancelled'],
    succeeded: [],
    failed: [],
    timed_out: [],
    denied: [],
    cancelled: [],
  },
  artifact: {
    none: ['pending', 'written', 'missing'],
    pending: ['written', 'missing', 'corrupt'],
    written: ['verified', 'corrupt', 'missing'],
    verified: [],
    missing: [],
    corrupt: [],
  },
  parentVerification: {
    unverified: ['pending', 'verified', 'failed'],
    pending: ['verified', 'failed'],
    verified: [],
    failed: [],
  },
  callback: {
    none: ['pending', 'sent', 'failed'],
    pending: ['sent', 'acknowledged', 'failed'],
    sent: ['acknowledged', 'failed', 'pending'],
    acknowledged: [],
    failed: ['pending', 'sent'],
  },
};

export const TERMINAL_STATES = {
  lifecycle: new Set(['completed', 'failed', 'cancelled']),
  execution: new Set(['succeeded', 'failed', 'timed_out', 'denied', 'cancelled']),
  artifact: new Set(['verified', 'missing', 'corrupt']),
  parentVerification: new Set(['verified', 'failed']),
  callback: new Set(['acknowledged']),
};

export const INITIAL_STATES = {
  lifecycle: 'created',
  execution: 'pending',
  artifact: 'none',
  parentVerification: 'unverified',
  callback: 'none',
};

export class InvalidTransitionError extends Error {
  constructor(dimension, fromState, toState) {
    super(`Invalid transition in dimension '${dimension}' from '${fromState}' to '${toState}'`);
    this.name = 'InvalidTransitionError';
    this.dimension = dimension;
    this.fromState = fromState;
    this.toState = toState;
  }
}

export class AttemptImmutableError extends Error {
  constructor(attemptId, reason = 'Attempt is sealed and immutable') {
    super(`Attempt '${attemptId}' is immutable: ${reason}`);
    this.name = 'AttemptImmutableError';
    this.attemptId = attemptId;
  }
}

export class AttemptAlreadyExistsError extends Error {
  constructor(attemptId) {
    super(`Attempt '${attemptId}' already exists`);
    this.name = 'AttemptAlreadyExistsError';
    this.attemptId = attemptId;
  }
}

export function validateDimensionTransition(dimension, fromState, toState) {
  if (!LEGAL_TRANSITIONS[dimension]) {
    throw new Error(`Unknown state dimension: ${dimension}`);
  }
  if (fromState === toState) {
    return true;
  }
  const allowed = LEGAL_TRANSITIONS[dimension][fromState];
  if (!allowed || !allowed.includes(toState)) {
    throw new InvalidTransitionError(dimension, fromState, toState);
  }
  return true;
}

export function applyStateTransitions(currentState, patch) {
  const dimensions = ['lifecycle', 'execution', 'artifact', 'parentVerification', 'callback'];
  const nextState = { ...currentState };

  for (const dim of dimensions) {
    if (patch[dim] !== undefined) {
      validateDimensionTransition(dim, currentState[dim], patch[dim]);
      nextState[dim] = patch[dim];
    }
  }

  for (const [key, value] of Object.entries(patch)) {
    if (!dimensions.includes(key)) {
      nextState[key] = value;
    }
  }

  if (TERMINAL_STATES.lifecycle.has(nextState.lifecycle) && patch.finalized === undefined && currentState.finalized !== true) {
    nextState.finalized = true;
  }

  return nextState;
}

export function getJobDir(root, jobId) {
  return path.join(resolveAgyRoot(root), 'jobs', jobId);
}

export function getAttemptDir(root, jobId, attemptId) {
  return path.join(getJobDir(root, jobId), 'attempts', attemptId);
}

export async function createJob(root, params = {}, options = {}) {
  const {
    generateId = generateUuid,
    now = Date.now(),
    writeAtomic = writeJsonAtomic,
  } = options;

  const jobId = params.jobId || generateId();
  const jobDir = getJobDir(root, jobId);

  try {
    await fsp.access(jobDir);
    throw new Error(`Job '${jobId}' already exists`);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  await ensureDir(jobDir);
  await ensureDir(path.join(jobDir, 'attempts'));

  const nowIso = new Date(now).toISOString();

  const manifest = {
    jobId,
    createdAt: nowIso,
    prompt: params.prompt ?? null,
    cwd: params.cwd ?? null,
    metadata: params.metadata ?? {},
  };

  const state = {
    jobId,
    lifecycle: params.lifecycle ?? INITIAL_STATES.lifecycle,
    execution: params.execution ?? INITIAL_STATES.execution,
    artifact: params.artifact ?? INITIAL_STATES.artifact,
    parentVerification: params.parentVerification ?? INITIAL_STATES.parentVerification,
    callback: params.callback ?? INITIAL_STATES.callback,
    finalized: false,
    corrupt: false,
    activeAttemptId: null,
    attemptCount: 0,
    createdAt: nowIso,
    updatedAt: nowIso,
  };

  const initialEvent = {
    id: generateId(),
    type: 'job_created',
    jobId,
    timestamp: nowIso,
    data: { manifest },
  };

  await writeAtomic(path.join(jobDir, 'manifest.json'), manifest, options);
  await writeAtomic(path.join(jobDir, 'state.json'), state, options);
  await appendJsonl(path.join(jobDir, 'events.jsonl'), initialEvent);

  return {
    jobId,
    jobDir,
    manifest,
    state,
  };
}

export async function getJob(root, jobId) {
  const jobDir = getJobDir(root, jobId);
  const manifest = await readJson(path.join(jobDir, 'manifest.json'));
  const state = await readJson(path.join(jobDir, 'state.json'));

  let events = [];
  let corrupt = false;
  let corruptError = null;

  try {
    events = await readJsonlTolerant(path.join(jobDir, 'events.jsonl'));
  } catch (err) {
    if (err instanceof CorruptJsonlError) {
      corrupt = true;
      corruptError = err.message;
    } else {
      throw err;
    }
  }

  if (corrupt) {
    state.corrupt = true;
  }

  return {
    jobId,
    jobDir,
    manifest,
    state,
    events,
    corrupt,
    corruptError,
  };
}

export async function updateJobState(root, jobId, patch, options = {}) {
  if (!options.__locked) {
    return withFileLock(path.join(getJobDir(root, jobId), '.state.lock'), () => updateJobState(root, jobId, patch, { ...options, __locked: true }));
  }
  const {
    now = Date.now(),
    reason = 'state_transition',
    eventData = {},
    generateId = generateUuid,
    writeAtomic = writeJsonAtomic,
  } = options;

  const jobDir = getJobDir(root, jobId);
  const statePath = path.join(jobDir, 'state.json');
  const currentState = await readJson(statePath);

  const nextState = applyStateTransitions(currentState, patch);
  const nowIso = new Date(now).toISOString();
  nextState.updatedAt = nowIso;

  const transitionEvent = {
    id: generateId(),
    type: 'job_state_updated',
    jobId,
    timestamp: nowIso,
    data: {
      patch,
      from: {
        lifecycle: currentState.lifecycle,
        execution: currentState.execution,
        artifact: currentState.artifact,
        parentVerification: currentState.parentVerification,
        callback: currentState.callback,
      },
      to: {
        lifecycle: nextState.lifecycle,
        execution: nextState.execution,
        artifact: nextState.artifact,
        parentVerification: nextState.parentVerification,
        callback: nextState.callback,
      },
      reason,
      ...eventData,
    },
  };

  await appendJsonl(path.join(jobDir, 'events.jsonl'), transitionEvent);
  await writeAtomic(statePath, nextState, options);
  await appendJsonl(path.join(jobDir, 'events.jsonl'), { ...transitionEvent, id: generateId(), type: 'job_state_committed', data: { transactionId: transitionEvent.id } });

  return nextState;
}

export async function createAttempt(root, jobId, params = {}, options = {}) {
  const {
    generateId = generateUuid,
    now = Date.now(),
    writeAtomic = writeJsonAtomic,
  } = options;

  const attemptId = params.attemptId || generateId();
  const attemptDir = getAttemptDir(root, jobId, attemptId);

  try {
    await fsp.access(attemptDir);
    throw new AttemptAlreadyExistsError(attemptId);
  } catch (err) {
    if (err instanceof AttemptAlreadyExistsError) throw err;
    if (err.code !== 'ENOENT') throw err;
  }

  await ensureDir(attemptDir);

  const nowIso = new Date(now).toISOString();

  const manifest = {
    attemptId,
    jobId,
    createdAt: nowIso,
    attemptIndex: params.attemptIndex ?? 1,
    metadata: params.metadata ?? {},
  };

  const state = {
    attemptId,
    jobId,
    lifecycle: params.lifecycle ?? 'running',
    execution: params.execution ?? 'pending',
    artifact: params.artifact ?? 'none',
    parentVerification: params.parentVerification ?? 'unverified',
    callback: params.callback ?? 'none',
    sealed: false,
    createdAt: nowIso,
    updatedAt: nowIso,
  };

  const attemptEvent = {
    id: generateId(),
    type: 'attempt_created',
    attemptId,
    jobId,
    timestamp: nowIso,
    data: { manifest },
  };

  await writeAtomic(path.join(attemptDir, 'manifest.json'), manifest, options);
  await writeAtomic(path.join(attemptDir, 'state.json'), state, options);
  await appendJsonl(path.join(attemptDir, 'events.jsonl'), attemptEvent);

  // Update job ledger with active attempt
  await updateJobState(
    root,
    jobId,
    {
      activeAttemptId: attemptId,
      lifecycle: 'running',
    },
    {
      reason: 'attempt_created',
      eventData: { attemptId },
      ...options,
    }
  );

  return {
    attemptId,
    attemptDir,
    manifest,
    state,
  };
}

export async function getAttempt(root, jobId, attemptId) {
  const attemptDir = getAttemptDir(root, jobId, attemptId);
  const manifest = await readJson(path.join(attemptDir, 'manifest.json'));
  const state = await readJson(path.join(attemptDir, 'state.json'));

  let events = [];
  let corrupt = false;
  let corruptError = null;

  try {
    events = await readJsonlTolerant(path.join(attemptDir, 'events.jsonl'));
  } catch (err) {
    if (err instanceof CorruptJsonlError) {
      corrupt = true;
      corruptError = err.message;
    } else {
      throw err;
    }
  }

  return {
    attemptId,
    attemptDir,
    manifest,
    state,
    events,
    corrupt,
    corruptError,
  };
}

export async function listAttempts(root, jobId) {
  const jobDir = getJobDir(root, jobId);
  const attemptsDir = path.join(jobDir, 'attempts');
  try {
    const entries = await fsp.readdir(attemptsDir, { withFileTypes: true });
    const attempts = [];
    for (const entry of entries) {
      if (entry.isDirectory()) {
        try {
          const attempt = await getAttempt(root, jobId, entry.name);
          attempts.push(attempt);
        } catch {
          // preserve unparseable attempt as an entry
          attempts.push({ attemptId: entry.name, corrupt: true });
        }
      }
    }
    return attempts;
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

export async function updateAttemptState(root, jobId, attemptId, patch, options = {}) {
  if (!options.__locked) {
    return withFileLock(path.join(getAttemptDir(root, jobId, attemptId), '.state.lock'), () => updateAttemptState(root, jobId, attemptId, patch, { ...options, __locked: true }));
  }
  const {
    now = Date.now(),
    reason = 'attempt_state_transition',
    eventData = {},
    generateId = generateUuid,
    writeAtomic = writeJsonAtomic,
  } = options;

  const attemptDir = getAttemptDir(root, jobId, attemptId);
  const statePath = path.join(attemptDir, 'state.json');
  const currentState = await readJson(statePath);

  if (currentState.sealed === true) {
    throw new AttemptImmutableError(attemptId, 'Attempt is sealed');
  }

  const nextState = applyStateTransitions(currentState, patch);
  const nowIso = new Date(now).toISOString();
  nextState.updatedAt = nowIso;

  const transitionEvent = {
    id: generateId(),
    type: 'attempt_state_updated',
    attemptId,
    jobId,
    timestamp: nowIso,
    data: {
      patch,
      reason,
      ...eventData,
    },
  };

  await appendJsonl(path.join(attemptDir, 'events.jsonl'), transitionEvent);
  await writeAtomic(statePath, nextState, options);
  await appendJsonl(path.join(attemptDir, 'events.jsonl'), { ...transitionEvent, id: generateId(), type: 'attempt_state_committed', data: { transactionId: transitionEvent.id } });

  return nextState;
}

export async function sealAttempt(root, jobId, attemptId, patch = {}, options = {}) {
  if (!options.__locked) {
    return withFileLock(path.join(getAttemptDir(root, jobId, attemptId), '.state.lock'), () => sealAttempt(root, jobId, attemptId, patch, { ...options, __locked: true }));
  }
  const {
    now = Date.now(),
    generateId = generateUuid,
    writeAtomic = writeJsonAtomic,
  } = options;

  const attemptDir = getAttemptDir(root, jobId, attemptId);
  const statePath = path.join(attemptDir, 'state.json');
  const currentState = await readJson(statePath);

  if (currentState.sealed === true) {
    throw new AttemptImmutableError(attemptId, 'Attempt is already sealed');
  }

  const nextState = applyStateTransitions(currentState, {
    ...patch,
    sealed: true,
  });

  const nowIso = new Date(now).toISOString();
  nextState.updatedAt = nowIso;

  const sealEvent = {
    id: generateId(),
    type: 'attempt_sealed',
    attemptId,
    jobId,
    timestamp: nowIso,
    data: { patch },
  };

  await appendJsonl(path.join(attemptDir, 'events.jsonl'), sealEvent);
  await writeAtomic(statePath, nextState, options);
  await appendJsonl(path.join(attemptDir, 'events.jsonl'), { ...sealEvent, id: generateId(), type: 'attempt_seal_committed', data: { transactionId: sealEvent.id } });

  return nextState;
}

function validateRetentionOptions(now, retentionMs) {
  if (!Number.isFinite(now) || !Number.isFinite(new Date(now).getTime())) {
    throw new TypeError('now must be a finite epoch timestamp in milliseconds');
  }
  if (!Number.isFinite(retentionMs) || retentionMs < 0) {
    throw new TypeError('retentionMs must be a finite non-negative number');
  }
}

export function evaluateJobRetention(job, options = {}) {
  const {
    now = Date.now(),
    retentionMs = DEFAULT_EVIDENCE_RETENTION_MS,
    hasPendingOutboxRecord = false,
  } = options;

  validateRetentionOptions(now, retentionMs);
  const reasons = [];

  const isTerminalLifecycle = TERMINAL_STATES.lifecycle.has(job.state?.lifecycle);
  if (!isTerminalLifecycle) {
    reasons.push('active');
  }

  if (job.state?.finalized !== true) {
    reasons.push('unfinalized');
  }

  const callbackState = job.state?.callback;
  if (callbackState === 'pending' || callbackState === 'sent' || hasPendingOutboxRecord) {
    reasons.push('callback_pending');
  }

  if (job.corrupt === true || job.state?.corrupt === true) {
    reasons.push('corrupt');
  }

  // Only fall back for absent timestamps, never for malformed values. Unknown
  // age must preserve evidence rather than silently bypass the retention window.
  const timestamp = job.state?.updatedAt ?? job.manifest?.createdAt;
  const updatedAtMs = typeof timestamp === 'string' ? Date.parse(timestamp) : NaN;
  if (!Number.isFinite(updatedAtMs)) {
    reasons.push('invalid_timestamp');
  } else if (now - updatedAtMs < retentionMs) {
    reasons.push('within_retention_window');
  }

  const eligible = reasons.length === 0;
  return { eligible, reasons };
}

/**
 * Explicit evidence maintenance after verified finalization. Worktrees must
 * be finalized through the controller; collection never infers ownership or
 * cleanup permission from a retention deadline.
 */
export async function collectEligibleJobs(root, options = {}) {
  const {
    now = Date.now(),
    retentionMs,
    evidenceRetentionMs = retentionMs ?? DEFAULT_EVIDENCE_RETENTION_MS,
    worktreeRetentionMs = DEFAULT_WORKTREE_RETENTION_MS,
    dryRun = false,
  } = options;

  validateRetentionOptions(now, evidenceRetentionMs);
  validateRetentionOptions(now, worktreeRetentionMs);
  if (typeof dryRun !== 'boolean') throw new TypeError('dryRun must be a boolean');

  const resolvedRoot = resolveAgyRoot(root);
  const jobsDir = path.join(resolvedRoot, 'jobs');

  let entries = [];
  try {
    entries = await fsp.readdir(jobsDir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { collected: [], skipped: [], worktrees: [] };
    }
    throw err;
  }

  // Read pending callbacks once per sweep instead of once per job.
  const pendingJobIds = new Set();
  let outboxUnavailable = false;
  try {
    for (const record of await listOutboxRecords(root, { strict: true })) {
      if (record.status === 'pending' || record.status === 'in_flight') {
        pendingJobIds.add(record.jobId);
      }
    }
  } catch {
    // An unreadable outbox cannot prove callbacks are drained. Fail closed.
    outboxUnavailable = true;
  }

  const collected = [];
  const skipped = [];
  const worktrees = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const jobId = entry.name;
    const jobDir = path.join(jobsDir, jobId);

    let job;
    try {
      job = await getJob(root, jobId);
    } catch (err) {
      // Corrupt job: preserve evidence on disk, do not delete
      job = {
        jobId,
        manifest: { jobId },
        state: { lifecycle: 'unknown', finalized: false, corrupt: true },
        corrupt: true,
      };
    }

    const evaluation = evaluateJobRetention(job, {
      now,
      retentionMs: evidenceRetentionMs,
      hasPendingOutboxRecord: outboxUnavailable || pendingJobIds.has(jobId),
    });

    if (evaluation.eligible) {
      if (dryRun) {
        collected.push(jobId);
        continue;
      }
      // Serialize against job state updates and re-read callback evidence
      // immediately before deletion. Failed reads never authorize collection.
      const deleted = await withFileLock(path.join(jobDir, '.state.lock'), async () => {
        let fresh;
        try { fresh = await getJob(root, jobId); } catch { return false; }
        const recheck = evaluateJobRetention(fresh, {
          now,
          retentionMs: evidenceRetentionMs,
          hasPendingOutboxRecord: outboxUnavailable || await hasPendingOutbox(root, jobId, { strict: true }),
        });
        if (!recheck.eligible) return false;
        await fsp.rm(jobDir, { recursive: true, force: true });
        return true;
      });
      if (deleted) collected.push(jobId);
      else skipped.push({ jobId, reasons: ['changed_during_sweep'] });
      continue;
    }

    skipped.push({ jobId, reasons: evaluation.reasons });

  }

  return { collected, skipped, worktrees };
}

export async function checkStorageHealth(root) {
  const resolvedRoot = resolveAgyRoot(root);
  const jobsDir = path.join(resolvedRoot, 'jobs');

  let totalJobs = 0;
  let activeJobs = 0;
  let finalizedJobs = 0;
  let corruptJobs = 0;

  try {
    const jobEntries = await fsp.readdir(jobsDir, { withFileTypes: true });
    for (const entry of jobEntries) {
      if (!entry.isDirectory()) continue;
      totalJobs++;
      try {
        const job = await getJob(root, entry.name);
        if (job.corrupt || job.state?.corrupt) {
          corruptJobs++;
        } else {
          if (!TERMINAL_STATES.lifecycle.has(job.state?.lifecycle)) {
            activeJobs++;
          }
          if (job.state?.finalized) {
            finalizedJobs++;
          }
        }
      } catch {
        corruptJobs++;
      }
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  let pendingOutboxCount = 0;
  try {
    const pending = await listOutboxRecords(root, { status: 'pending' });
    pendingOutboxCount = pending.length;
  } catch {
    // ignore
  }

  return {
    healthy: corruptJobs === 0,
    root: resolvedRoot,
    totalJobs,
    activeJobs,
    finalizedJobs,
    corruptJobs,
    pendingOutboxCount,
  };
}
