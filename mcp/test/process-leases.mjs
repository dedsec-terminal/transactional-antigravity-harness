import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  parseProcessDate,
  compareProcessDates,
  compareExecutables,
  compareCommandLines,
  validateProcessIdentity,
  queryProcessIdentity,
  writeCancellationMarker,
  readCancellationMarker,
  terminateProcess,
  terminateOwnedProcessTree,
  spawnDetachedWorker,
  WindowsProcessSupervisor,
} from "../../skills/delegate-to-antigravity/scripts/lib/windows-process.mjs";

import { withFileLock } from "../../skills/delegate-to-antigravity/scripts/lib/storage.mjs";

import {
  DEFAULT_MAX_SLOTS,
  acquireSlot,
  reserveSlot,
  activateReservedSlot,
  releaseSlot,
  classifyLease,
  scanLeases,
  reclaimLeases,
  getActiveCount,
  getAvailableCount,
  getCounts,
  detectOrphanProcesses,
  getSlotsDir,
  SlotLeaseManager,
} from "../../skills/delegate-to-antigravity/scripts/lib/leases.mjs";

describe("Windows Process Supervision and Max-Four Slot Leasing", () => {
  let tmpRoot;

  beforeEach(async () => {
    tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "agy-process-leases-test-"));
  });

  afterEach(async () => {
    if (tmpRoot) {
      await fsp.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
    }
  });

  describe("1. PID reuse mismatch blocks kill and reclaim", () => {
    it("never kills when PID is reused by another process with mismatched identity", async () => {
      const taskkillCalls = [];
      const recordedIdentity = {
        pid: 6100,
        creationTime: "2026-09-07T10:00:00.000Z",
        executable: "C:\\Program Files\\nodejs\\node.exe",
        commandLine: "node worker.js",
      };

      // Mock CIM query returning a different process that re-used PID 6100
      const mockRunner = async ({ command, args }) => {
        if (command === "powershell.exe") {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              ProcessId: 6100,
              CreationDate: "/Date(1788799000000)/", // Later time
              ExecutablePath: "C:\\Windows\\System32\\svchost.exe", // Different executable!
              CommandLine: "svchost.exe -k netsvcs",
            }),
            stderr: "",
          };
        }
        if (command === "taskkill") {
          taskkillCalls.push({ command, args });
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      };

      const events = [];
      const result = await terminateProcess({
        pid: 6100,
        identity: recordedIdentity,
        commandRunner: mockRunner,
        platform: "win32",
        events,
      });

      assert.equal(result.stopped, false, "Process must not be reported stopped");
      assert.equal(result.blocked, true, "Kill must be blocked");
      assert.equal(result.reason, "identity_mismatch");
      assert.equal(taskkillCalls.length, 0, "taskkill must NEVER be called on identity mismatch");

      const blockedEvent = events.find((e) => e.type === "identity_mismatch_kill_blocked");
      assert.ok(blockedEvent, "Identity mismatch event must be recorded");
    });

    it("never reclaims a slot whose owner has PID reuse mismatch and reports it as ambiguous", async () => {
      const taskkillCalls = [];
      const recordedIdentity = {
        pid: 6200,
        creationTime: "2026-09-07T08:00:00.000Z",
        executable: "C:\\Program Files\\nodejs\\node.exe",
        commandLine: "node worker.js",
      };

      const mockRunner = async ({ command, args }) => {
        if (command === "powershell.exe") {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              ProcessId: 6200,
              CreationDate: "/Date(1788799999000)/",
              ExecutablePath: "C:\\Windows\\System32\\notepad.exe",
              CommandLine: "notepad.exe text.txt",
            }),
            stderr: "",
          };
        }
        if (command === "taskkill") {
          taskkillCalls.push({ command, args });
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      };

      const supervisor = new WindowsProcessSupervisor({
        commandRunner: mockRunner,
        platform: "win32",
      });

      // Acquire slot 0 with the initial identity
      const acquireResult = await acquireSlot({
        stateRoot: tmpRoot,
        jobId: "job-mismatch",
        attemptId: "att-1",
        processIdentity: recordedIdentity,
        processSupervisor: supervisor,
      });
      assert.equal(acquireResult.acquired, true);
      assert.equal(acquireResult.slotId, 0);

      // Attempt reclamation
      const reclaimResult = await reclaimLeases({
        stateRoot: tmpRoot,
        processSupervisor: supervisor,
      });

      assert.equal(reclaimResult.reclaimed.length, 0, "No leases should be reclaimed");
      assert.equal(reclaimResult.ambiguous.length, 1, "Slot must be reported as ambiguous");
      assert.equal(reclaimResult.ambiguous[0].slotId, 0);
      assert.equal(reclaimResult.ambiguous[0].reason, "pid_reuse_mismatch");
      assert.equal(taskkillCalls.length, 0, "taskkill must not be called");

      // Verify slot file still exists on disk
      const slotFile = path.join(tmpRoot, "locks", "slots", "slot-0.json");
      const stat = await fsp.stat(slotFile);
      assert.ok(stat.isFile(), "Slot file must remain intact and not deleted");
    });
  });

  describe("2. Stale valid lease recovery", () => {
    it("reclaims slot when recorded owner process is dead", async () => {
      const recordedIdentity = {
        pid: 7100,
        creationTime: "2026-09-07T09:00:00.000Z",
        executable: "C:\\node.exe",
        commandLine: "node worker.js",
      };

      // Mock probe: process not running (empty output)
      const mockRunner = async ({ command }) => {
        if (command === "powershell.exe") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      };

      const supervisor = new WindowsProcessSupervisor({
        commandRunner: mockRunner,
        platform: "win32",
      });

      await acquireSlot({
        stateRoot: tmpRoot,
        jobId: "job-dead",
        attemptId: "att-dead",
        processIdentity: recordedIdentity,
        processSupervisor: supervisor,
      });

      const reclaimResult = await reclaimLeases({
        stateRoot: tmpRoot,
        processSupervisor: supervisor,
      });

      assert.equal(reclaimResult.reclaimed.length, 1, "Dead owner lease must be reclaimed");
      assert.equal(reclaimResult.reclaimed[0].reason, "dead_owner");
      assert.equal(reclaimResult.reclaimed[0].slotId, 0);

      // Verify slot is now available
      const available = await getAvailableCount({
        stateRoot: tmpRoot,
        processSupervisor: supervisor,
      });
      assert.equal(available, DEFAULT_MAX_SLOTS);
    });

    it("reclaims slot when active owner identity matches but lease has exceeded stale timeout", async () => {
      const taskkillCalls = [];
      const recordedIdentity = {
        pid: 7200,
        creationTime: "2026-09-07T09:00:00.000Z",
        executable: "C:\\Program Files\\nodejs\\node.exe",
        commandLine: "node worker.js",
      };

      let processAlive = true;
      const mockRunner = async ({ command, args }) => {
        if (command === "powershell.exe") {
          if (!processAlive) {
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              ProcessId: 7200,
              CreationDate: "2026-09-07T09:00:00.000Z",
              ExecutablePath: "C:\\Program Files\\nodejs\\node.exe",
              CommandLine: "node worker.js",
            }),
            stderr: "",
          };
        }
        if (command === "taskkill") {
          taskkillCalls.push({ command, args });
          processAlive = false; // Taskkill terminates it
          return { exitCode: 0, stdout: "SUCCESS", stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      };

      const supervisor = new WindowsProcessSupervisor({
        commandRunner: mockRunner,
        platform: "win32",
      });

      // Acquire slot with an acquiredAt timestamp 1 hour in the past
      const slotsDir = path.join(tmpRoot, "locks", "slots");
      await fsp.mkdir(slotsDir, { recursive: true });
      const staleLease = {
        slotId: 0,
        jobId: "job-stale",
        attemptId: "att-stale",
        pid: 7200,
        creationTime: recordedIdentity.creationTime,
        executable: recordedIdentity.executable,
        commandLine: recordedIdentity.commandLine,
        acquiredAt: new Date(Date.now() - 3600_000).toISOString(),
      };
      await fsp.writeFile(
        path.join(slotsDir, "slot-0.json"),
        JSON.stringify(staleLease, null, 2),
        "utf8"
      );

      const reclaimResult = await reclaimLeases({
        stateRoot: tmpRoot,
        staleTimeoutMs: 60_000,
        processSupervisor: supervisor,
      });

      assert.equal(reclaimResult.reclaimed.length, 1, "Stale valid lease must be reclaimed");
      assert.equal(reclaimResult.reclaimed[0].reason, "stale_owner_reclaimed");
      assert.equal(taskkillCalls.length, 1, "taskkill must be verified and executed");
      assert.deepEqual(taskkillCalls[0].args, ["/PID", "7200", "/T", "/F"]);

      // Verify slot file unlinked
      await assert.rejects(fsp.stat(path.join(slotsDir, "slot-0.json")), { code: "ENOENT" });
    });
  });

  describe("3. Four-slot contention and exhaustion", () => {
    it("enforces max default 4 slots, rejects 5th, and allows acquire after release", async () => {
      const manager = new SlotLeaseManager({
        stateRoot: tmpRoot,
        maxSlots: 4,
      });

      const identities = [
        { pid: 8001, creationTime: new Date().toISOString(), executable: "node.exe", commandLine: "node 1" },
        { pid: 8002, creationTime: new Date().toISOString(), executable: "node.exe", commandLine: "node 2" },
        { pid: 8003, creationTime: new Date().toISOString(), executable: "node.exe", commandLine: "node 3" },
        { pid: 8004, creationTime: new Date().toISOString(), executable: "node.exe", commandLine: "node 4" },
      ];

      // Acquire 4 slots
      for (let i = 0; i < 4; i += 1) {
        const res = await manager.acquire({
          jobId: `job-${i}`,
          attemptId: `att-${i}`,
          processIdentity: identities[i],
        });
        assert.equal(res.acquired, true);
        assert.equal(res.slotId, i);
      }

      // Counts: 4 active, 0 available
      assert.equal(await manager.getAvailableCount(), 0);

      // Attempt 5th acquisition -> Contention exhaustion
      const fifthAttempt = await manager.acquire({
        jobId: "job-5",
        attemptId: "att-5",
        processIdentity: {
          pid: 8005,
          creationTime: new Date().toISOString(),
          executable: "node.exe",
          commandLine: "node 5",
        },
      });

      assert.equal(fifthAttempt.acquired, false, "5th slot must be rejected");
      assert.equal(fifthAttempt.reason, "slots_exhausted");

      // Release slot 1
      const releaseRes = await manager.release({ slotId: 1, jobId: "job-1", attemptId: "att-1" });
      assert.equal(releaseRes.released, true);
      assert.equal(await manager.getAvailableCount(), 1);

      // Acquire again for job-5 -> should succeed and acquire slot 1
      const retryFifth = await manager.acquire({
        jobId: "job-5",
        attemptId: "att-5",
        processIdentity: {
          pid: 8005,
          creationTime: new Date().toISOString(),
          executable: "node.exe",
          commandLine: "node 5",
        },
      });

      assert.equal(retryFifth.acquired, true);
      assert.equal(retryFifth.slotId, 1);
      assert.equal(await manager.getAvailableCount(), 0);
    });
  });

  describe("4. Cancellation ordering", () => {
    it("executes: marker writing -> graceful signal -> bounded wait -> verified force kill -> verify exit", async () => {
      const events = [];
      const markerPath = path.join(tmpRoot, "markers", "cancel.json");
      const recordedIdentity = {
        pid: 9100,
        creationTime: "2026-09-07T12:00:00.000Z",
        executable: "C:\\Program Files\\nodejs\\node.exe",
        commandLine: "node worker.js",
      };

      let killed = false;
      const mockRunner = async ({ command, args }) => {
        if (command === "powershell.exe") {
          if (killed) {
            return { exitCode: 0, stdout: "", stderr: "" }; // Gone after taskkill
          }
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              ProcessId: 9100,
              CreationDate: "2026-09-07T12:00:00.000Z",
              ExecutablePath: "C:\\Program Files\\nodejs\\node.exe",
              CommandLine: "node worker.js",
            }),
            stderr: "",
          };
        }
        if (command === "taskkill") {
          killed = true;
          return { exitCode: 0, stdout: "SUCCESS", stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      };

      const res = await terminateProcess({
        pid: 9100,
        identity: recordedIdentity,
        cancellationMarkerPath: markerPath,
        gracePeriodMs: 60,
        pollIntervalMs: 15,
        commandRunner: mockRunner,
        platform: "win32",
        events,
      });

      assert.equal(res.stopped, true);
      assert.equal(res.method, "force_tree_kill");

      // Verify cancellation marker on disk
      const markerContent = await readCancellationMarker(markerPath);
      assert.ok(markerContent, "Cancellation marker file must exist");
      assert.equal(markerContent.pid, 9100);
      assert.equal(markerContent.action, "terminate");

      // Verify exact event ordering
      const eventTypes = events.map((e) => e.type);
      assert.deepEqual(eventTypes, [
        "cancellation_marker_written",
        "graceful_signal_sent",
        "force_tree_kill_initiated",
        "force_kill_verified",
      ]);
    });
  });

  describe("5. Orphan classification", () => {
    it("classifies active worker whose controller process died as orphan", async () => {
      const recordedIdentity = {
        pid: 9200,
        creationTime: "2026-09-07T12:00:00.000Z",
        executable: "C:\\node.exe",
        commandLine: "node worker.js",
      };

      // Worker 9200 is alive; Controller 9199 is dead (empty probe)
      const mockRunner = async ({ command, args }) => {
        if (command === "powershell.exe") {
          const script = args[3] || "";
          if (script.includes("ProcessId = 9200")) {
            return {
              exitCode: 0,
              stdout: JSON.stringify({
                ProcessId: 9200,
                CreationDate: "2026-09-07T12:00:00.000Z",
                ExecutablePath: "C:\\node.exe",
                CommandLine: "node worker.js",
              }),
              stderr: "",
            };
          }
          if (script.includes("ProcessId = 9199")) {
            return { exitCode: 0, stdout: "", stderr: "" }; // Controller dead
          }
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      };

      const supervisor = new WindowsProcessSupervisor({
        commandRunner: mockRunner,
        platform: "win32",
      });

      const lease = {
        slotId: 0,
        jobId: "job-orphan",
        attemptId: "att-orphan",
        pid: 9200,
        controllerPid: 9199,
        creationTime: recordedIdentity.creationTime,
        executable: recordedIdentity.executable,
        commandLine: recordedIdentity.commandLine,
        acquiredAt: new Date().toISOString(),
      };

      const classification = await classifyLease(lease, { processSupervisor: supervisor });
      assert.equal(classification.status, "orphan");
      assert.equal(classification.reason, "controller_dead");
      assert.equal(classification.controllerPid, 9199);
    });

    it("detects running worker processes without active leases as orphan processes", async () => {
      const recordedIdentity = {
        pid: 9500,
        creationTime: "2026-09-07T12:00:00.000Z",
        executable: "node.exe",
        commandLine: "node worker.js",
      };

      const mockRunner = async ({ command, args }) => {
        if (command === "powershell.exe") {
          const script = args?.[3] || "";
          if (script.includes("ProcessId = 9500")) {
            return {
              exitCode: 0,
              stdout: JSON.stringify({
                ProcessId: 9500,
                CreationDate: recordedIdentity.creationTime,
                ExecutablePath: recordedIdentity.executable,
                CommandLine: recordedIdentity.commandLine,
              }),
              stderr: "",
            };
          }
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      };

      const supervisor = new WindowsProcessSupervisor({
        commandRunner: mockRunner,
        platform: "win32",
      });

      const manager = new SlotLeaseManager({
        stateRoot: tmpRoot,
        maxSlots: 4,
        processSupervisor: supervisor,
      });

      // Acquire slot 0 for PID 9500
      await manager.acquire({
        jobId: "job-leased",
        attemptId: "att-leased",
        processIdentity: recordedIdentity,
      });

      const runningProcesses = [
        { pid: 9500, name: "node.exe" },
        { pid: 9501, name: "node.exe" }, // Orphan: no lease held!
      ];

      const orphans = await manager.detectOrphanProcesses(runningProcesses);
      assert.equal(orphans.length, 1);
      assert.equal(orphans[0].pid, 9501);
      assert.equal(orphans[0].reason, "running_without_active_lease");
    });
  });

  describe("6. Process spawn without shell interpolation", () => {
    it("spawns a detached process without shell command interpolation", async () => {
      const spawned = await spawnDetachedWorker({
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
        windowsHide: true,
      });

      assert.ok(spawned.pid > 0, "Spawned process must have valid PID");
      assert.equal(spawned.identity.pid, spawned.pid);
      assert.equal(spawned.identity.executable, process.execPath);
      assert.ok(spawned.identity.creationTime);
    });
  });

  describe("7. Identity validation and normalization unit checks", () => {
    it("handles Windows case-insensitive path comparisons and date formats", () => {
      const recorded = {
        pid: 1234,
        creationTime: "2026-09-07T14:17:58.626Z",
        executable: "c:\\program files\\nodejs\\node.exe",
        commandLine: '"C:\\Program Files\\nodejs\\node.exe" script.js',
      };

      const live = {
        pid: 1234,
        creationTime: "/Date(1788790678626)/",
        executable: "C:\\PROGRAM FILES\\NODEJS\\NODE.EXE",
        commandLine: 'C:\\Program Files\\nodejs\\node.exe script.js',
      };

      const validation = validateProcessIdentity(recorded, live, { platform: "win32" });
      assert.equal(validation.matches, true);
    });

    it("rejects mismatched command line", () => {
      const recorded = {
        pid: 1234,
        creationTime: "2026-09-07T14:17:58.626Z",
        executable: "node.exe",
        commandLine: "node target-script.js",
      };

      const live = {
        pid: 1234,
        creationTime: "2026-09-07T14:17:58.626Z",
        executable: "node.exe",
        commandLine: "node entirely-different-script.js",
      };

      const validation = validateProcessIdentity(recorded, live, { platform: "win32" });
      assert.equal(validation.matches, false);
      assert.equal(validation.reason, "command_line_mismatch");
    });
  });

  describe("8. Pre-spawn reservation, activation, mismatch, release", () => {
    it("reserves slot with controller identity, activates with worker identity, and releases", async () => {
      const controllerIdentity = {
        pid: 9600,
        creationTime: "2026-09-07T12:00:00.000Z",
        executable: "cmd.exe",
        commandLine: "cmd.exe /c controller",
      };
      const workerIdentity = {
        pid: 9601,
        creationTime: "2026-09-07T12:00:05.000Z",
        executable: "node.exe",
        commandLine: "node worker.js",
      };

      const reserved = await reserveSlot({
        stateRoot: tmpRoot,
        jobId: "job-reserve",
        attemptId: "att-reserve",
        controllerProcessIdentity: controllerIdentity,
      });
      assert.equal(reserved.acquired, true);
      assert.equal(reserved.slotId, 0);
      assert.equal(reserved.lease.pid, 9600);
      assert.equal(reserved.lease.controllerPid, 9600);
      assert.equal(reserved.lease.metadata?.phase, "reserved");

      const activated = await activateReservedSlot({
        stateRoot: tmpRoot,
        slotId: 0,
        nonce: reserved.lease.nonce,
        jobId: "job-reserve",
        attemptId: "att-reserve",
        workerProcessIdentity: workerIdentity,
      });
      assert.equal(activated.activated, true);
      assert.equal(activated.slotId, 0);
      assert.equal(activated.lease.pid, 9601);
      assert.equal(activated.lease.controllerPid, 9600);
      assert.equal(activated.lease.nonce, reserved.lease.nonce);
      assert.equal(activated.lease.acquiredAt, reserved.lease.acquiredAt);
      assert.equal(activated.lease.metadata?.phase, "active");

      const released = await releaseSlot({
        stateRoot: tmpRoot,
        slotId: 0,
        jobId: "job-reserve",
        attemptId: "att-reserve",
      });
      assert.equal(released.released, true);
      assert.equal(await getAvailableCount({ stateRoot: tmpRoot }), DEFAULT_MAX_SLOTS);
    });

    it("fails closed on nonce, job, attempt, and phase mismatches", async () => {
      const controllerIdentity = { pid: 9700, creationTime: "2026-09-07T12:00:00.000Z", executable: "node.exe", commandLine: "node controller.js" };
      const workerIdentity = { pid: 9701, creationTime: "2026-09-07T12:00:05.000Z", executable: "node.exe", commandLine: "node worker.js" };

      const reserved = await reserveSlot({
        stateRoot: tmpRoot,
        jobId: "job-mismatch",
        attemptId: "att-1",
        processIdentity: controllerIdentity,
      });
      assert.equal(reserved.acquired, true);

      // Nonce mismatch
      const wrongNonce = await activateReservedSlot({
        stateRoot: tmpRoot,
        slotId: reserved.slotId,
        nonce: "wrong-nonce",
        jobId: "job-mismatch",
        attemptId: "att-1",
        workerProcessIdentity: workerIdentity,
      });
      assert.equal(wrongNonce.activated, false);
      assert.equal(wrongNonce.reason, "nonce_mismatch");

      // Job/attempt mismatch
      const wrongJob = await activateReservedSlot({
        stateRoot: tmpRoot,
        slotId: reserved.slotId,
        nonce: reserved.lease.nonce,
        jobId: "wrong-job",
        attemptId: "att-1",
        workerProcessIdentity: workerIdentity,
      });
      assert.equal(wrongJob.activated, false);
      assert.equal(wrongJob.reason, "job_id_mismatch");

      // Activate successfully
      const okActivate = await activateReservedSlot({
        stateRoot: tmpRoot,
        slotId: reserved.slotId,
        nonce: reserved.lease.nonce,
        jobId: "job-mismatch",
        attemptId: "att-1",
        workerProcessIdentity: workerIdentity,
      });
      assert.equal(okActivate.activated, true);

      // Double activation fails closed because phase is active
      const doubleActivate = await activateReservedSlot({
        stateRoot: tmpRoot,
        slotId: reserved.slotId,
        nonce: reserved.lease.nonce,
        jobId: "job-mismatch",
        attemptId: "att-1",
        workerProcessIdentity: workerIdentity,
      });
      assert.equal(doubleActivate.activated, false);
      assert.equal(doubleActivate.reason, "phase_not_reserved");
    });
  });

  describe("9. Lock recovery and owned process-tree termination", () => {
    async function deadPid() {
      const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
      const pid = child.pid;
      await new Promise((resolve) => child.once("exit", resolve));
      return pid;
    }

    async function waitForExit(pid, timeoutMs = 3000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        try {
          process.kill(pid, 0);
        } catch {
          return true;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return false;
    }

    it("recovers a lock directory whose owner record was never published", async () => {
      const lockPath = path.join(tmpRoot, "locks", "unpublished.lock");
      await fsp.mkdir(lockPath, { recursive: true });

      let ran = false;
      await withFileLock(lockPath, async () => { ran = true; }, { staleMs: 0, maxWaitMs: 1000 });
      assert.equal(ran, true);
      await assert.rejects(fsp.stat(lockPath), { code: "ENOENT" });
    });

    it("recovers a dead-owner lock but never steals a live owner", async () => {
      const dead = await deadPid();
      const deadLock = path.join(tmpRoot, "locks", "dead.lock");
      await fsp.mkdir(deadLock, { recursive: true });
      await fsp.writeFile(
        path.join(deadLock, "owner.json"),
        JSON.stringify({ owner: `${dead}:dead`, pid: dead, createdAt: Date.now() }),
      );

      let deadRan = false;
      await withFileLock(deadLock, async () => { deadRan = true; }, { maxWaitMs: 2000 });
      assert.equal(deadRan, true);

      const liveLock = path.join(tmpRoot, "locks", "live.lock");
      await fsp.mkdir(liveLock, { recursive: true });
      await fsp.writeFile(
        path.join(liveLock, "owner.json"),
        JSON.stringify({ owner: `${process.pid}:live`, pid: process.pid, createdAt: Date.now() }),
      );

      let liveRan = false;
      await assert.rejects(
        withFileLock(liveLock, async () => { liveRan = true; }, { maxWaitMs: 50, staleMs: 0 }),
        /Timed out acquiring lock/,
      );
      assert.equal(liveRan, false);
      await fsp.access(path.join(liveLock, "owner.json"));
    });

    it("serializes concurrent reclaimers so only one critical section runs at a time", async () => {
      const dead = await deadPid();
      const lockPath = path.join(tmpRoot, "locks", "contended.lock");
      await fsp.mkdir(lockPath, { recursive: true });
      await fsp.writeFile(
        path.join(lockPath, "owner.json"),
        JSON.stringify({ owner: `${dead}:dead`, pid: dead, createdAt: Date.now() }),
      );

      let inSection = 0;
      let maxInSection = 0;
      const work = () => withFileLock(lockPath, async () => {
        inSection += 1;
        maxInSection = Math.max(maxInSection, inSection);
        await new Promise((resolve) => setTimeout(resolve, 40));
        inSection -= 1;
      }, { maxWaitMs: 10000 });

      await Promise.all([work(), work(), work()]);
      assert.equal(maxInSection, 1);
      await assert.rejects(fsp.stat(lockPath), { code: "ENOENT" });
    });

    it("acquires a slot whose guard lock holder crashed", async () => {
      const stateRoot = path.join(tmpRoot, "state");
      const dead = await deadPid();
      const crashedGuard = `${path.join(getSlotsDir(stateRoot), "slot-0.json")}.lock`;
      await fsp.mkdir(crashedGuard, { recursive: true });
      await fsp.writeFile(
        path.join(crashedGuard, "owner.json"),
        JSON.stringify({ owner: `${dead}:dead`, pid: dead, createdAt: Date.now() }),
      );

      const lease = await acquireSlot({
        stateRoot,
        jobId: "job-lock",
        attemptId: "att-lock",
        processIdentity: {
          pid: process.pid,
          creationTime: new Date().toISOString(),
          executable: process.execPath,
          commandLine: "node test",
        },
        maxSlots: 1,
      });
      assert.equal(lease.acquired, true);
      const released = await releaseSlot({ stateRoot, slotId: lease.slotId, jobId: "job-lock", attemptId: "att-lock" });
      assert.equal(released.released, true);
    });

    it("terminates an owned process tree that ignores SIGTERM", async (t) => {
      if (process.platform === "win32") {
        t.skip("POSIX process-group termination test");
        return;
      }
      const script = path.join(tmpRoot, "tree.mjs");
      await fsp.writeFile(script, [
        'import { spawn } from "node:child_process";',
        'process.on("SIGTERM", () => {});',
        "const grandchild = spawn(process.execPath, [\"-e\", \"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"], { stdio: \"ignore\" });",
        'process.stdout.write(JSON.stringify({ pid: process.pid, grandchild: grandchild.pid }) + "\\n");',
        'setInterval(() => {}, 1000);',
      ].join("\n"), "utf8");

      const child = spawn(process.execPath, [script], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
      try {
        const announcement = await new Promise((resolve, reject) => {
          let data = "";
          child.stdout.on("data", (chunk) => {
            data += chunk;
            if (data.includes("\n")) resolve(data.split("\n")[0]);
          });
          child.once("error", reject);
        });
        const { grandchild } = JSON.parse(announcement);

        const result = await terminateOwnedProcessTree({ child, gracePeriodMs: 500, pollIntervalMs: 50 });
        assert.equal(result.stopped, true);
        assert.equal(await waitForExit(child.pid), true, "owned child must exit");
        assert.equal(await waitForExit(grandchild), true, "grandchild must exit");
      } finally {
        try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} }
      }
    });
  });
});
