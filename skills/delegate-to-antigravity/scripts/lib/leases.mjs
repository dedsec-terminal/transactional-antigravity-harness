import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import {
  WindowsProcessSupervisor,
  queryProcessIdentity,
  validateProcessIdentity,
  terminateProcess,
} from "./windows-process.mjs";

export const DEFAULT_MAX_SLOTS = 4;
export const DEFAULT_STALE_TIMEOUT_MS = 300_000; // 5 minutes

async function withSlotLock(slotPath, fn) {
  const lockPath = `${slotPath}.lock`;
  try {
    const nonce = crypto.randomUUID();
    await fsp.writeFile(lockPath, nonce, { flag: "wx", encoding: "utf8" });
    try {
      return await fn(nonce);
    } finally {
      try {
        const current = await fsp.readFile(lockPath, "utf8");
        if (current === nonce) await fsp.unlink(lockPath);
      } catch (err) { if (err.code !== "ENOENT") throw err; }
    }
  } catch (err) {
    if (err.code === "EEXIST") return { locked: true };
    throw err;
  }
}

async function guardedUnlink(slotPath, expectedLease) {
  return withSlotLock(slotPath, async () => {
    let current;
    try { current = JSON.parse(await fsp.readFile(slotPath, "utf8")); }
    catch (err) { if (err.code === "ENOENT") return { released: true, alreadyReleased: true }; throw err; }
    if (expectedLease && current.nonce !== expectedLease.nonce) {
      return { released: false, reason: "lease_changed", lease: current };
    }
    await fsp.unlink(slotPath);
    return { released: true, lease: current };
  });
}

/**
 * Returns the resolved slots directory path under stateRoot: locks/slots
 */
export function getSlotsDir(stateRoot) {
  if (!stateRoot) {
    throw new Error("stateRoot is required to determine slots directory");
  }
  return path.join(stateRoot, "locks", "slots");
}

/**
 * Acquires a cross-process slot lease using atomic exclusive file creation (flag 'wx').
 * Ensures slot file includes jobId, attemptId, pid, creationTime, executable, commandLine, acquiredAt.
 */
export async function acquireSlot(options = {}) {
  const {
    stateRoot,
    jobId,
    attemptId,
    processIdentity,
    maxSlots = DEFAULT_MAX_SLOTS,
    controllerPid,
    cancellationMarkerPath,
    autoReclaim = false,
    staleTimeoutMs = DEFAULT_STALE_TIMEOUT_MS,
    processSupervisor,
    metadata,
  } = options;

  if (!stateRoot) throw new Error("stateRoot is required to acquire a slot lease");
  if (!jobId) throw new Error("jobId is required to acquire a slot lease");
  if (!attemptId) throw new Error("attemptId is required to acquire a slot lease");
  if (!processIdentity || !processIdentity.pid) {
    throw new Error("processIdentity with pid is required to acquire a slot lease");
  }

  const pid = Number(processIdentity.pid);
  const creationTime = processIdentity.creationTime || new Date().toISOString();
  const executable = processIdentity.executable || "";
  const commandLine = processIdentity.commandLine || "";

  const slotsDir = getSlotsDir(stateRoot);
  await fsp.mkdir(slotsDir, { recursive: true });

  if (autoReclaim) {
    try {
      await reclaimLeases({
        stateRoot,
        maxSlots,
        staleTimeoutMs,
        processSupervisor,
      });
    } catch {}
  }

  // Iterate slots 0 .. maxSlots - 1 attempting atomic exclusive create
  for (let slotId = 0; slotId < maxSlots; slotId += 1) {
    const slotPath = path.join(slotsDir, `slot-${slotId}.json`);
    const leaseData = {
      nonce: crypto.randomUUID(),
      slotId,
      jobId,
      attemptId,
      pid,
      creationTime,
      executable,
      commandLine,
      acquiredAt: new Date().toISOString(),
      ...(controllerPid ? { controllerPid: Number(controllerPid) } : {}),
      ...(cancellationMarkerPath ? { cancellationMarkerPath } : {}),
      ...(metadata ? { metadata } : {}),
    };

    try {
      const result = await withSlotLock(slotPath, async () => {
        await fsp.writeFile(slotPath, JSON.stringify(leaseData, null, 2), {
        flag: "wx",
        encoding: "utf8",
        });
        return true;
      });
      if (result?.locked) continue;
      return {
        acquired: true,
        slotId,
        slotPath,
        lease: leaseData,
      };
    } catch (err) {
      if (err.code === "EEXIST") {
        // Slot already held, check next slot
        continue;
      }
      throw err;
    }
  }

  return {
    acquired: false,
    reason: "slots_exhausted",
    maxSlots,
  };
}

/**
 * Releases an acquired slot by removing its lease file.
 * Verifies jobId/attemptId ownership unless force is true.
 */
export async function releaseSlot(options = {}) {
  const {
    stateRoot,
    slotId,
    slotPath: customSlotPath,
    jobId,
    attemptId,
    force = false,
  } = options;

  if (!stateRoot && !customSlotPath) {
    throw new Error("stateRoot or slotPath is required to release a slot");
  }

  const slotPath =
    customSlotPath || path.join(getSlotsDir(stateRoot), `slot-${slotId}.json`);

  let raw;
  try {
    raw = await fsp.readFile(slotPath, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") {
      return { released: true, alreadyReleased: true, slotId };
    }
    throw err;
  }

  let lease;
  try {
    lease = JSON.parse(raw);
  } catch {
    lease = null;
  }

  if (!force && lease) {
    if (jobId && lease.jobId !== jobId) {
      return { released: false, reason: "job_id_mismatch", slotId, lease };
    }
    if (attemptId && lease.attemptId !== attemptId) {
      return { released: false, reason: "attempt_id_mismatch", slotId, lease };
    }
  }

  if (!force && !lease?.nonce) {
    return { released: false, reason: "lease_nonce_missing", slotId, lease };
  }
  const result = await guardedUnlink(slotPath, force ? null : lease);
  return { ...result, slotId };
}

/**
 * Classifies an individual lease based on live probe results.
 * Possible statuses:
 * - 'corrupt': lease JSON invalid or missing required identity fields.
 * - 'dead': worker process is verified not running.
 * - 'ambiguous': process is running with lease PID, but identity mismatched (PID reuse!).
 * - 'orphan': worker process is running and identity matches, but its controller process is dead.
 * - 'stale': worker process is running and identity matches, but acquiredAt exceeded stale timeout.
 * - 'active': worker process is running and identity matches, alive and healthy.
 */
export async function classifyLease(lease, options = {}) {
  const {
    processSupervisor = new WindowsProcessSupervisor(),
    staleTimeoutMs = DEFAULT_STALE_TIMEOUT_MS,
  } = options;

  if (
    !lease ||
    typeof lease !== "object" ||
    !lease.jobId ||
    !lease.attemptId ||
    !lease.pid ||
    !lease.creationTime ||
    !lease.executable ||
    !lease.commandLine
  ) {
    return {
      status: "corrupt",
      reason: "missing_required_fields",
      lease,
    };
  }

  const workerProbe = await processSupervisor.queryProcessIdentity(lease.pid);
  if (!workerProbe.running) {
    return {
      status: "dead",
      reason: "process_not_running",
      lease,
    };
  }

  // Worker is running: validate identity against recorded lease
  const validation = processSupervisor.validateProcessIdentity(
    lease,
    workerProbe.identity
  );
  if (!validation.matches) {
    // CRITICAL: PID was recycled by another process!
    return {
      status: "ambiguous",
      reason: "pid_reuse_mismatch",
      validation,
      liveIdentity: workerProbe.identity,
      lease,
    };
  }

  // Identity matches! Check for orphan status (controller dead while worker alive)
  if (lease.controllerPid) {
    const controllerProbe = await processSupervisor.queryProcessIdentity(
      lease.controllerPid
    );
    if (!controllerProbe.running) {
      return {
        status: "orphan",
        reason: "controller_dead",
        controllerPid: lease.controllerPid,
        lease,
        liveIdentity: workerProbe.identity,
      };
    }
  }

  // Check for stale timeout
  if (staleTimeoutMs && lease.acquiredAt) {
    const ageMs = Date.now() - new Date(lease.acquiredAt).getTime();
    if (ageMs > staleTimeoutMs) {
      return {
        status: "stale",
        reason: "stale_timeout_exceeded",
        ageMs,
        lease,
        liveIdentity: workerProbe.identity,
      };
    }
  }

  return {
    status: "active",
    lease,
    liveIdentity: workerProbe.identity,
  };
}

/**
 * Scans all slot leases under locks/slots.
 * Reports active, stale, dead, ambiguous, orphans, and available slots.
 */
export async function scanLeases(options = {}) {
  const {
    stateRoot,
    maxSlots = DEFAULT_MAX_SLOTS,
    processSupervisor = new WindowsProcessSupervisor(),
    staleTimeoutMs = DEFAULT_STALE_TIMEOUT_MS,
  } = options;

  if (!stateRoot) throw new Error("stateRoot is required to scan leases");

  const slotsDir = getSlotsDir(stateRoot);
  try {
    await fsp.mkdir(slotsDir, { recursive: true });
  } catch {}

  const slots = [];
  const active = [];
  const stale = [];
  const dead = [];
  const ambiguous = [];
  const orphans = [];
  const corrupt = [];
  const freeSlots = [];

  for (let slotId = 0; slotId < maxSlots; slotId += 1) {
    const slotPath = path.join(slotsDir, `slot-${slotId}.json`);
    let raw;
    try {
      raw = await fsp.readFile(slotPath, "utf8");
    } catch (err) {
      if (err.code === "ENOENT") {
        freeSlots.push(slotId);
        slots.push({ slotId, status: "free", slotPath });
        continue;
      }
      throw err;
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      const item = { slotId, status: "corrupt", slotPath, error: "invalid_json" };
      corrupt.push(item);
      slots.push(item);
      continue;
    }

    const classification = await classifyLease(parsed, {
      processSupervisor,
      staleTimeoutMs,
    });

    const item = {
      slotId,
      slotPath,
      ...classification,
    };
    slots.push(item);

    switch (classification.status) {
      case "active":
        active.push(item);
        break;
      case "stale":
        stale.push(item);
        break;
      case "dead":
        dead.push(item);
        break;
      case "ambiguous":
        ambiguous.push(item);
        break;
      case "orphan":
        orphans.push(item);
        break;
      case "corrupt":
        corrupt.push(item);
        break;
      default:
        break;
    }
  }

  return {
    maxSlots,
    slots,
    active,
    stale,
    dead,
    ambiguous,
    orphans,
    corrupt,
    freeSlots,
    activeCount: active.length,
    availableCount: freeSlots.length,
  };
}

/**
 * Reclaims slot leases:
 * - Scans and reclaims ONLY identity-verified stale/dead owners.
 * - For ambiguous leases (PID reuse mismatch): NEVER kills, NEVER reclaims!
 *   Reports ambiguous leases in output.
 * - For orphans (worker alive, controller dead): terminates verified worker and reclaims slot.
 */
export async function reclaimLeases(options = {}) {
  const {
    stateRoot,
    maxSlots = DEFAULT_MAX_SLOTS,
    staleTimeoutMs = DEFAULT_STALE_TIMEOUT_MS,
    processSupervisor = new WindowsProcessSupervisor(),
    reclaimDead = true,
    reclaimStale = true,
    reclaimOrphans = true,
  } = options;

  const scan = await scanLeases({
    stateRoot,
    maxSlots,
    processSupervisor,
    staleTimeoutMs,
  });

  const reclaimed = [];
  const blocked = [];
  const ambiguous = [...scan.ambiguous];

  // 1. Reclaim dead owners (process verified not running)
  if (reclaimDead) {
    for (const item of scan.dead) {
      try {
        const result = await guardedUnlink(item.slotPath, item.lease);
        if (result.released) reclaimed.push({
          slotId: item.slotId,
          reason: "dead_owner",
          lease: item.lease,
        });
        else blocked.push({ slotId: item.slotId, reason: result.reason || "slot_locked" });
      } catch (err) {
        if (err.code !== "ENOENT") {
          blocked.push({
            slotId: item.slotId,
            reason: "unlink_failed",
            error: err.message,
          });
        }
      }
    }
  }

  // 2. Reclaim stale owners (verified matching identity, past timeout)
  if (reclaimStale) {
    for (const item of scan.stale) {
      const stopResult = await processSupervisor.terminateProcess({
        pid: item.lease.pid,
        identity: item.lease,
        cancellationMarkerPath: item.lease.cancellationMarkerPath,
      });

      if (stopResult.stopped) {
        try {
          const result = await guardedUnlink(item.slotPath, item.lease);
          if (result.released) reclaimed.push({
            slotId: item.slotId,
            reason: "stale_owner_reclaimed",
            lease: item.lease,
            stopResult,
          });
          else blocked.push({ slotId: item.slotId, reason: result.reason || "slot_locked" });
        } catch (err) {
          if (err.code !== "ENOENT") {
            blocked.push({
              slotId: item.slotId,
              reason: "unlink_failed",
              error: err.message,
            });
          }
        }
      } else {
        blocked.push({
          slotId: item.slotId,
          reason: "stop_failed",
          stopResult,
          lease: item.lease,
        });
      }
    }
  }

  // 3. Reclaim orphan owners (worker matching identity, controller dead)
  if (reclaimOrphans) {
    for (const item of scan.orphans) {
      const stopResult = await processSupervisor.terminateProcess({
        pid: item.lease.pid,
        identity: item.lease,
        cancellationMarkerPath: item.lease.cancellationMarkerPath,
      });

      if (stopResult.stopped) {
        try {
          const result = await guardedUnlink(item.slotPath, item.lease);
          if (result.released) reclaimed.push({
            slotId: item.slotId,
            reason: "orphan_owner_reclaimed",
            lease: item.lease,
            stopResult,
          });
          else blocked.push({ slotId: item.slotId, reason: result.reason || "slot_locked" });
        } catch (err) {
          if (err.code !== "ENOENT") {
            blocked.push({
              slotId: item.slotId,
              reason: "unlink_failed",
              error: err.message,
            });
          }
        }
      } else {
        blocked.push({
          slotId: item.slotId,
          reason: "stop_failed",
          stopResult,
          lease: item.lease,
        });
      }
    }
  }

  // Note: ambiguous leases are untouched. They block reclaim/kill by design.

  const finalScan = await scanLeases({
    stateRoot,
    maxSlots,
    processSupervisor,
    staleTimeoutMs,
  });

  return {
    reclaimed,
    ambiguous,
    blocked,
    activeCount: finalScan.activeCount,
    availableCount: finalScan.availableCount,
    maxSlots,
  };
}

/**
 * Returns the current count of active leases.
 */
export async function getActiveCount(options = {}) {
  const scan = await scanLeases(options);
  return scan.activeCount;
}

/**
 * Returns the current count of available slots.
 */
export async function getAvailableCount(options = {}) {
  const scan = await scanLeases(options);
  return scan.availableCount;
}

/**
 * Returns complete counts for active, available, ambiguous, stale, dead, and max slots.
 */
export async function getCounts(options = {}) {
  const scan = await scanLeases(options);
  return {
    maxSlots: scan.maxSlots,
    activeCount: scan.activeCount,
    availableCount: scan.availableCount,
    ambiguousCount: scan.ambiguous.length,
    staleCount: scan.stale.length,
    deadCount: scan.dead.length,
    orphanCount: scan.orphans.length,
  };
}

/**
 * Detects orphan processes: running processes that match worker criteria
 * but hold NO valid lease in any slot.
 */
export async function detectOrphanProcesses(options = {}) {
  const {
    stateRoot,
    runningProcesses = [],
    maxSlots = DEFAULT_MAX_SLOTS,
    processSupervisor = new WindowsProcessSupervisor(),
  } = options;

  const scan = await scanLeases({
    stateRoot,
    maxSlots,
    processSupervisor,
  });

  const leasedPids = new Set(
    scan.slots
      .filter(
        (s) =>
          s.lease &&
          s.status !== "free" &&
          s.status !== "dead" &&
          s.status !== "ambiguous" &&
          s.status !== "corrupt"
      )
      .map((s) => Number(s.lease.pid))
  );

  const orphanProcesses = [];
  for (const proc of runningProcesses) {
    const pid = Number(proc.pid);
    if (!leasedPids.has(pid)) {
      orphanProcesses.push({
        pid,
        process: proc,
        reason: "running_without_active_lease",
      });
    }
  }

  return orphanProcesses;
}

/**
 * High-level manager coordinating cross-process slot leasing and worker supervision.
 */
export class SlotLeaseManager {
  constructor(options = {}) {
    this.stateRoot = options.stateRoot;
    this.maxSlots = options.maxSlots ?? DEFAULT_MAX_SLOTS;
    this.staleTimeoutMs = options.staleTimeoutMs ?? DEFAULT_STALE_TIMEOUT_MS;
    this.processSupervisor =
      options.processSupervisor ||
      new WindowsProcessSupervisor({
        commandRunner: options.commandRunner,
        platform: options.platform,
        toleranceMs: options.toleranceMs,
        queryProcessIdentity:
          options.queryProcessIdentity || options.processProbe,
      });
  }

  async acquire(options = {}) {
    return acquireSlot({
      stateRoot: this.stateRoot,
      maxSlots: this.maxSlots,
      staleTimeoutMs: this.staleTimeoutMs,
      processSupervisor: options.processSupervisor || this.processSupervisor,
      ...options,
    });
  }

  async release(options = {}) {
    return releaseSlot({
      stateRoot: this.stateRoot,
      ...options,
    });
  }

  async scan(options = {}) {
    return scanLeases({
      stateRoot: this.stateRoot,
      maxSlots: this.maxSlots,
      staleTimeoutMs: this.staleTimeoutMs,
      processSupervisor: options.processSupervisor || this.processSupervisor,
      ...options,
    });
  }

  async reclaim(options = {}) {
    return reclaimLeases({
      stateRoot: this.stateRoot,
      maxSlots: this.maxSlots,
      staleTimeoutMs: this.staleTimeoutMs,
      processSupervisor: options.processSupervisor || this.processSupervisor,
      ...options,
    });
  }

  async getActiveCount(options = {}) {
    return getActiveCount({
      stateRoot: this.stateRoot,
      maxSlots: this.maxSlots,
      processSupervisor: options.processSupervisor || this.processSupervisor,
      staleTimeoutMs: this.staleTimeoutMs,
      ...options,
    });
  }

  async getAvailableCount(options = {}) {
    return getAvailableCount({
      stateRoot: this.stateRoot,
      maxSlots: this.maxSlots,
      processSupervisor: options.processSupervisor || this.processSupervisor,
      staleTimeoutMs: this.staleTimeoutMs,
      ...options,
    });
  }

  async getCounts(options = {}) {
    return getCounts({
      stateRoot: this.stateRoot,
      maxSlots: this.maxSlots,
      processSupervisor: options.processSupervisor || this.processSupervisor,
      staleTimeoutMs: this.staleTimeoutMs,
      ...options,
    });
  }

  async detectOrphanProcesses(runningProcesses, options = {}) {
    return detectOrphanProcesses({
      stateRoot: this.stateRoot,
      runningProcesses,
      maxSlots: this.maxSlots,
      processSupervisor: options.processSupervisor || this.processSupervisor,
      ...options,
    });
  }
}
