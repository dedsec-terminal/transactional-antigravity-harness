import { spawn, spawnSync } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";

/**
 * Normalizes and parses various date representations from OS/CIM queries or JSON.
 * Handles ISO-8601, DMTF WMI strings, /Date(millis)/ format, and Unix epochs.
 */
export function parseProcessDate(val) {
  if (val == null) return null;
  if (typeof val === "number") return val;
  const str = String(val).trim();
  if (!str) return null;

  // Handle PowerShell JSON /Date(1788790678626)/
  const wcfMatch = /\/Date\((\d+)\)\//.exec(str);
  if (wcfMatch) {
    return Number(wcfMatch[1]);
  }

  // Handle WMI/CIM DMTF format: 20260907141758.626000+330
  const dmtfMatch = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.(\d{3,6})([+-]\d+)?$/.exec(str);
  if (dmtfMatch) {
    const [, y, m, d, h, min, s, frac, tz] = dmtfMatch;
    const ms = frac.slice(0, 3).padEnd(3, "0");
    // DMTF offsets are signed minutes, not HHMM.
    const iso = `${y}-${m}-${d}T${h}:${min}:${s}.${ms}Z`;
    const parsed = Date.parse(iso) - Number(tz || 0) * 60_000;
    if (!Number.isNaN(parsed)) return parsed;
  }

  const parsed = Date.parse(str);
  if (!Number.isNaN(parsed)) return parsed;

  return str;
}

/**
 * Compares two process creation dates with configurable tolerance in milliseconds.
 */
export function compareProcessDates(date1, date2, toleranceMs = 2000) {
  if (date1 === date2) return true;
  const p1 = parseProcessDate(date1);
  const p2 = parseProcessDate(date2);
  if (typeof p1 === "number" && typeof p2 === "number") {
    return Math.abs(p1 - p2) <= toleranceMs;
  }
  return String(date1).trim() === String(date2).trim();
}

/**
 * Compares two executable paths or names, case-insensitively on Windows.
 */
export function compareExecutables(exe1, exe2, platform = process.platform) {
  if (!exe1 || !exe2) return false;
  const s1 = String(exe1).trim();
  const s2 = String(exe2).trim();
  if (s1 === s2) return true;

  if (platform === "win32") {
    // A basename match is unsafe: a different directory can contain a
    // different executable with the same name. Require canonical absolute
    // paths and compare the complete identity case-insensitively.
    const canonical = (value) => {
      const normalized = String(value).trim().replace(/\\/g, "/");
      if (!path.win32.isAbsolute(normalized)) return null;
      return path.win32.normalize(normalized).toLowerCase();
    };
    const c1 = canonical(s1);
    const c2 = canonical(s2);
    return Boolean(c1 && c2 && c1 === c2);
  }
  return false;
}

/**
 * Compares two process command lines, normalizing whitespace and quotes.
 */
export function compareCommandLines(cmd1, cmd2) {
  if (!cmd1 || !cmd2) return false;
  const s1 = String(cmd1).trim();
  const s2 = String(cmd2).trim();
  if (s1 === s2) return true;

  const normalize = (s) =>
    s
      .replace(/["']/g, "")
      .replace(/\\/g, "/")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();

  const n1 = normalize(s1);
  const n2 = normalize(s2);
  return n1 === n2;
}

/**
 * Validates all recorded fields (pid, creationTime, executable, commandLine)
 * against a live probed process identity.
 *
 * Never permits execution if identity is absent, incomplete, or mismatched.
 */
export function validateProcessIdentity(recordedIdentity, liveIdentity, options = {}) {
  const platform = options.platform || process.platform;
  const toleranceMs = options.toleranceMs ?? (platform === "win32" ? 2000 : 0);

  if (!recordedIdentity) {
    return {
      matches: false,
      reason: "recorded_identity_missing",
      details: { recordedIdentity, liveIdentity },
    };
  }
  if (!liveIdentity) {
    return {
      matches: false,
      reason: "live_identity_missing",
      details: { recordedIdentity, liveIdentity },
    };
  }

  // 1. PID match
  const recPid = Number(recordedIdentity.pid);
  const livePid = Number(liveIdentity.pid);
  if (!recPid || !livePid || recPid !== livePid) {
    return {
      matches: false,
      reason: "pid_mismatch",
      details: { expectedPid: recPid, actualPid: livePid },
    };
  }

  // 2. Creation time match
  if (!recordedIdentity.creationTime || !liveIdentity.creationTime) {
    return {
      matches: false,
      reason: "creation_time_missing",
      details: {
        expectedCreationTime: recordedIdentity.creationTime,
        actualCreationTime: liveIdentity.creationTime,
      },
    };
  }
  if (!compareProcessDates(recordedIdentity.creationTime, liveIdentity.creationTime, toleranceMs)) {
    return {
      matches: false,
      reason: "creation_time_mismatch",
      details: {
        expectedCreationTime: recordedIdentity.creationTime,
        actualCreationTime: liveIdentity.creationTime,
      },
    };
  }

  // 3. Executable match
  if (!recordedIdentity.executable || !liveIdentity.executable) {
    return {
      matches: false,
      reason: "executable_missing",
      details: {
        expectedExecutable: recordedIdentity.executable,
        actualExecutable: liveIdentity.executable,
      },
    };
  }
  if (!compareExecutables(recordedIdentity.executable, liveIdentity.executable, platform)) {
    return {
      matches: false,
      reason: "executable_mismatch",
      details: {
        expectedExecutable: recordedIdentity.executable,
        actualExecutable: liveIdentity.executable,
      },
    };
  }

  // 4. Command line match
  if (!recordedIdentity.commandLine || !liveIdentity.commandLine) {
    return {
      matches: false,
      reason: "command_line_missing",
      details: {
        expectedCommandLine: recordedIdentity.commandLine,
        actualCommandLine: liveIdentity.commandLine,
      },
    };
  }
  if (!(platform === "win32"
    ? compareCommandLines(recordedIdentity.commandLine, liveIdentity.commandLine)
    : recordedIdentity.commandLine === liveIdentity.commandLine)) {
    return {
      matches: false,
      reason: "command_line_mismatch",
      details: {
        expectedCommandLine: recordedIdentity.commandLine,
        actualCommandLine: liveIdentity.commandLine,
      },
    };
  }

  return { matches: true, reason: "ok", identity: liveIdentity };
}

export function isIdentityMatch(recorded, live, options = {}) {
  return validateProcessIdentity(recorded, live, options).matches;
}

/**
 * Default command runner executing child processes asynchronously with a strict timeout.
 */
export function defaultCommandRunner({
  command,
  args,
  timeoutMs = 5000,
  windowsHide = true,
  cwd,
  env,
}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: env || process.env,
      windowsHide,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    child.stdout.on("data", (d) => {
      stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString("utf8");
    });

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (process.platform === "win32") {
          spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
            windowsHide: true,
            stdio: "ignore",
          });
        } else {
          child.kill("SIGKILL");
        }
      } catch {}
    }, timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({
        exitCode,
        stdout,
        stderr,
        timedOut,
      });
    });
  });
}

/**
 * Queries process identity.
 * On Windows, runs a bounded PowerShell child to query CIM Win32_Process.
 * Supports injectable commandRunner and platform for deterministic testing.
 */
export async function queryProcessIdentity(pid, options = {}) {
  const targetPid = Number(pid);
  if (!Number.isSafeInteger(targetPid) || targetPid <= 0) {
    return { running: false, identity: null, reason: "invalid_pid" };
  }

  const platform = options.platform || process.platform;
  const commandRunner = options.commandRunner || defaultCommandRunner;

  if (platform === "win32") {
    const psScript = `Get-CimInstance Win32_Process -Filter "ProcessId = ${targetPid}" | Select-Object ProcessId, CreationDate, ExecutablePath, CommandLine | ConvertTo-Json -Compress`;
    const timeoutMs = options.timeoutMs ?? 5000;

    try {
      const res = await commandRunner({
        command: "powershell.exe",
        args: ["-NoProfile", "-NonInteractive", "-Command", psScript],
        timeoutMs,
        windowsHide: true,
      });

      if (res.timedOut || (res.exitCode != null && res.exitCode !== 0)) {
        return { running: true, identity: null, reason: "probe_failed" };
      }
      const stdout = res.stdout ? res.stdout.trim() : "";
      if (!stdout || stdout === "null") {
        return { running: false, identity: null };
      }

      let data;
      try {
        data = JSON.parse(stdout);
      } catch {
        return { running: true, identity: null, reason: "unparseable_output" };
      }

      if (!data || Number(data.ProcessId) !== targetPid) {
        return { running: true, identity: null, reason: "unparseable_output" };
      }

      let creationTime = null;
      if (data.CreationDate) {
        const parsedMs = parseProcessDate(data.CreationDate);
        if (typeof parsedMs === "number") {
          creationTime = new Date(parsedMs).toISOString();
        } else {
          creationTime = String(data.CreationDate);
        }
      }

      return {
        running: true,
        identity: {
          pid: Number(data.ProcessId),
          creationTime,
          executable: data.ExecutablePath || "",
          commandLine: data.CommandLine || "",
        },
      };
    } catch (err) {
      return { running: true, identity: null, reason: "probe_failed", error: err.message };
    }
  } else {
    // ESRCH proves absence. Permission/probe errors do not: keep ownership
    // ambiguous so a failed probe can never authorize reclaim or termination.
    try { process.kill(targetPid, 0); }
    catch (err) {
      if (err.code === "ESRCH") return { running: false, identity: null };
    }
    try {
      if (platform === "linux") {
        const proc = `/proc/${targetPid}`;
        const stat = await fsp.readFile(`${proc}/stat`, "utf8");
        const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
        if (fields[0] === "Z" || fields[0] === "X") return { running: false, identity: null };
        const startTicks = fields[19]; // field 22, after pid and (comm)
        const [bootId, executable, argv] = await Promise.all([
          fsp.readFile("/proc/sys/kernel/random/boot_id", "utf8"),
          fsp.readlink(`${proc}/exe`),
          fsp.readFile(`${proc}/cmdline`),
        ]);
        const after = await fsp.readFile(`${proc}/stat`, "utf8");
        if (after.slice(after.lastIndexOf(")") + 2).trim().split(/\s+/)[19] !== startTicks) {
          return { running: true, identity: null, reason: "process_changed_during_probe" };
        }
        // A boot-scoped kernel start token is exact and independent of clock
        // changes, scheduling delay, or date comparison tolerance.
        return { running: true, identity: {
          pid: targetPid,
          creationTime: `linux:${bootId.trim()}:${startTicks}`,
          executable,
          commandLine: argv.toString("utf8").replace(/\0/g, " ").trim(),
        } };
      }
      if (platform !== "darwin") return { running: true, identity: null, reason: "unsupported_platform" };
      // Query columns separately: executable paths may contain spaces.
      const query = async (column) => {
        const res = await commandRunner({ command: "ps", args: ["-ww", "-p", String(targetPid), "-o", `${column}=`],
          env: { ...process.env, LC_ALL: "C", TZ: "UTC" }, timeoutMs: options.timeoutMs ?? 2000 });
        if (res.timedOut || (res.exitCode != null && res.exitCode !== 0) || !res.stdout?.trim()) throw new Error("ps probe failed");
        return res.stdout.trim();
      };
      const state = await query("stat");
      if (state.startsWith("Z")) return { running: false, identity: null };
      const started = await query("lstart");
      const [executable, commandLine] = await Promise.all([query("comm"), query("args")]);
      if (started !== await query("lstart")) throw new Error("process changed during probe");
      const date = Date.parse(`${started} UTC`);
      if (!Number.isFinite(date)) throw new Error("invalid process start time");
      return { running: true, identity: { pid: targetPid, creationTime: new Date(date).toISOString(), executable, commandLine } };
    } catch (err) {
      try { process.kill(targetPid, 0); }
      catch (probe) { if (probe.code === "ESRCH") return { running: false, identity: null }; }
      return { running: true, identity: null, reason: "probe_failed", error: err.message };
    }
  }
}

/**
 * Writes a cancellation marker file to disk before graceful termination.
 */
export async function writeCancellationMarker(markerPath, data = {}) {
  if (!markerPath) return null;
  await fsp.mkdir(path.dirname(markerPath), { recursive: true });
  const payload = {
    requestedAt: new Date().toISOString(),
    pid: data.pid,
    reason: data.reason || "cancelled",
    ...data,
  };
  await fsp.writeFile(markerPath, JSON.stringify(payload, null, 2), "utf8");
  return markerPath;
}

/**
 * Reads a cancellation marker file if present.
 */
export async function readCancellationMarker(markerPath) {
  if (!markerPath) return null;
  try {
    const raw = await fsp.readFile(markerPath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Terminates a process tree with full identity verification:
 * 1. Writes cancellation marker if specified.
 * 2. Probes live process identity and verifies against recorded identity.
 *    NEVER kills if identity is absent or mismatched.
 * 3. Sends graceful signal (SIGTERM/SIGINT).
 * 4. Bounded wait for graceful stop.
 * 5. If still alive, re-verifies identity, then executes verified force-tree-kill (taskkill /PID /T /F on Windows).
 * 6. Verifies termination.
 */
export async function terminateProcess(options = {}) {
  const {
    pid,
    identity,
    cancellationMarkerPath,
    gracePeriodMs = 1500,
    pollIntervalMs = 50,
    commandRunner = defaultCommandRunner,
    platform = process.platform,
    signal = "SIGTERM",
    child = null,
    events = null,
  } = options;

  const targetPid = Number(pid);
  if (!Number.isSafeInteger(targetPid) || targetPid <= 0) {
    return { stopped: false, reason: "invalid_pid" };
  }

  // 1. Write cancellation marker
  if (cancellationMarkerPath) {
    try {
      await writeCancellationMarker(cancellationMarkerPath, {
        pid: targetPid,
        action: "terminate",
      });
      events?.push({ type: "cancellation_marker_written", path: cancellationMarkerPath });
    } catch (err) {
      events?.push({ type: "cancellation_marker_error", error: err.message });
    }
  }

  // 2. Query initial live identity and validate BEFORE any kill attempt
  const initialProbe = await queryProcessIdentity(targetPid, { commandRunner, platform });
  if (!initialProbe.running) {
    events?.push({ type: "already_dead", pid: targetPid });
    return { stopped: true, alreadyDead: true, reason: "process_not_running" };
  }

  if (!identity) {
    events?.push({ type: "identity_absent_kill_blocked", pid: targetPid });
    return {
      stopped: false,
      blocked: true,
      reason: "identity_absent",
      message: "Refusing to stop process because recorded identity is absent",
    };
  }

  const initialValidation = validateProcessIdentity(identity, initialProbe.identity, { platform });
  if (!initialValidation.matches) {
    events?.push({
      type: "identity_mismatch_kill_blocked",
      pid: targetPid,
      reason: initialValidation.reason,
      details: initialValidation.details,
    });
    return {
      stopped: false,
      blocked: true,
      reason: "identity_mismatch",
      validation: initialValidation,
      message: `Refusing to stop process because identity mismatched: ${initialValidation.reason}`,
    };
  }

  // 3. Graceful signal
  events?.push({ type: "graceful_signal_sent", pid: targetPid, signal });
  try {
    if (platform !== "win32") {
      try { process.kill(-targetPid, signal); }
      catch { process.kill(targetPid, signal); }
    } else if (child && typeof child.kill === "function") {
      child.kill(signal);
    } else {
      process.kill(targetPid, signal);
    }
  } catch {}

  const pollRunning = async () => {
    if (platform === "win32" && process.platform === "win32" && commandRunner === defaultCommandRunner) {
      try { process.kill(targetPid, 0); return true; }
      catch (err) { return err.code !== "ESRCH"; }
    }
    return (await queryProcessIdentity(targetPid, { commandRunner, platform })).running;
  };

  // 4. Bounded wait for graceful termination
  const startTime = Date.now();
  while (Date.now() - startTime < gracePeriodMs) {
    await new Promise((r) => setTimeout(r, pollIntervalMs));
    if (!await pollRunning()) {
      events?.push({
        type: "graceful_stop_verified",
        pid: targetPid,
        durationMs: Date.now() - startTime,
      });
      return { stopped: true, method: "graceful", pid: targetPid };
    }
  }

  // 5. Force kill requested. Re-verify identity before force kill
  const preForceProbe = await queryProcessIdentity(targetPid, { commandRunner, platform });
  if (!preForceProbe.running) {
    events?.push({ type: "graceful_stop_verified_late", pid: targetPid });
    return { stopped: true, method: "graceful", pid: targetPid };
  }

  const preForceValidation = validateProcessIdentity(identity, preForceProbe.identity, { platform });
  if (!preForceValidation.matches) {
    events?.push({
      type: "identity_mismatch_force_kill_blocked",
      pid: targetPid,
      reason: preForceValidation.reason,
    });
    return {
      stopped: false,
      blocked: true,
      reason: "identity_mismatch_during_force_kill",
      validation: preForceValidation,
    };
  }

  // Execute verified force-tree-kill
  events?.push({ type: "force_tree_kill_initiated", pid: targetPid });
  if (platform === "win32") {
    try {
      await commandRunner({
        command: "taskkill",
        args: ["/PID", String(targetPid), "/T", "/F"],
        timeoutMs: 5000,
        windowsHide: true,
      });
    } catch {}
  } else {
    try {
      process.kill(-targetPid, "SIGKILL");
    } catch {
      try {
        process.kill(targetPid, "SIGKILL");
      } catch {}
    }
  }

  // 6. Verify process termination
  const postKillDeadline = Date.now() + 2000;
  while (Date.now() < postKillDeadline) {
    await new Promise((r) => setTimeout(r, pollIntervalMs));
    if (!await pollRunning()) {
      events?.push({ type: "force_kill_verified", pid: targetPid });
      return { stopped: true, method: "force_tree_kill", pid: targetPid };
    }
  }

  events?.push({ type: "force_kill_failed_still_running", pid: targetPid });
  return {
    stopped: false,
    reason: "force_kill_timeout",
    error: "Process still running after verified force kill",
    pid: targetPid,
  };
}

export const terminateProcessTree = terminateProcess;

/**
 * Spawns a detached worker process suitable for background / detached controllers
 * WITHOUT shell command interpolation (shell: false).
 */
export async function spawnDetachedWorker(options = {}) {
  const {
    command,
    args = [],
    cwd = process.cwd(),
    env = process.env,
    stdio = "ignore",
    windowsHide = true,
  } = options;

  if (!command) {
    throw new Error("Command is required to spawn detached worker");
  }

  const child = spawn(command, args, {
    cwd,
    env,
    stdio,
    detached: true,
    windowsHide,
    shell: false, // Critical: explicitly false, no shell interpolation
  });

  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });

  const pid = child.pid;
  const probe = await queryProcessIdentity(pid);
  const identity = probe.identity;

  child.unref();

  return {
    child,
    pid,
    identity,
  };
}

/**
 * Wrapper class managing process lifecycle and supervision.
 */
export class WindowsProcessSupervisor {
  constructor(options = {}) {
    this.platform = options.platform || process.platform;
    this.commandRunner = options.commandRunner || defaultCommandRunner;
    this.toleranceMs = options.toleranceMs ?? (this.platform === "win32" ? 2000 : 0);
    if (typeof options.queryProcessIdentity === "function") {
      this._customQueryProcessIdentity = options.queryProcessIdentity;
    } else if (typeof options.processProbe === "function") {
      this._customQueryProcessIdentity = options.processProbe;
    }
  }

  async queryProcessIdentity(pid, opts = {}) {
    if (this._customQueryProcessIdentity) {
      return this._customQueryProcessIdentity(pid, opts);
    }
    return queryProcessIdentity(pid, {
      commandRunner: this.commandRunner,
      platform: this.platform,
      ...opts,
    });
  }

  validateProcessIdentity(recorded, live, opts = {}) {
    return validateProcessIdentity(recorded, live, {
      platform: this.platform,
      toleranceMs: this.toleranceMs,
      ...opts,
    });
  }

  async terminateProcess(opts = {}) {
    return terminateProcess({
      commandRunner: this.commandRunner,
      platform: this.platform,
      ...opts,
    });
  }

  async spawnDetachedWorker(opts = {}) {
    return spawnDetachedWorker(opts);
  }
}
