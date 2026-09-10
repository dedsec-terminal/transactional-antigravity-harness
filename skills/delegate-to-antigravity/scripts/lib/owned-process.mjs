import { spawnSync } from 'node:child_process';

/** Signal a directly owned child, spawned with detached:true on POSIX.
 * Persisted/recovered PIDs must use identity-verified terminateProcess instead.
 */
function groupRunning(pid) {
  try { process.kill(-pid, 0); }
  catch (error) { return error?.code !== 'ESRCH'; }
  // Orphaned zombies may keep a group ID allocated although no code can run.
  const probe = spawnSync('ps', ['-A', '-o', 'pgid=', '-o', 'stat='], {
    encoding: 'utf8', timeout: 1000, maxBuffer: 4 * 1024 * 1024,
  });
  if (probe.status !== 0 || probe.error) return true;
  return probe.stdout.split(/\r?\n/).some(line => {
    const [group, state] = line.trim().split(/\s+/);
    return Number(group) === pid && state && !/^[ZX]/.test(state);
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function terminateOwnedProcessTree(input = {}) {
  const options = input && typeof input.kill === 'function' ? { child: input } : input ?? {};
  const child = options.child ?? null;
  const pid = Number(options.pid ?? child?.pid ?? 0);
  const platform = options.platform ?? process.platform;
  const commandRunner = options.commandRunner;
  const gracePeriodMs = options.gracePeriodMs ?? 1500;
  const pollIntervalMs = options.pollIntervalMs ?? 50;
  if (!Number.isFinite(gracePeriodMs) || gracePeriodMs < 0 || gracePeriodMs > 10000
    || !Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0 || pollIntervalMs > 1000) {
    return { stopped: false, reason: 'invalid_timeout' };
  }
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) return { stopped: false, reason: 'invalid_pid' };
  if (platform === 'win32') {
    let result;
    try {
      result = commandRunner
        ? await commandRunner({ command: 'taskkill', args: ['/PID', String(pid), '/T', '/F'], timeoutMs: 5000, windowsHide: true })
        : spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 5000 });
    } catch (error) { return { stopped: false, reason: 'taskkill_failed', pid, error: String(error?.message ?? error) }; }
    const exitCode = result?.exitCode ?? result?.status;
    if (exitCode === 0 && !result?.timedOut) return { stopped: true, method: 'taskkill', pid };
    return { stopped: false, reason: result?.timedOut ? 'taskkill_timeout' : 'taskkill_failed', pid, exitCode };
  }
  try { process.kill(-pid, 'SIGTERM'); }
  catch (error) { if (error?.code !== 'ESRCH') return { stopped: false, reason: 'signal_failed', pid }; }
  const deadline = Date.now() + gracePeriodMs;
  while (Date.now() < deadline) {
    await sleep(pollIntervalMs);
    if (!groupRunning(pid)) return { stopped: true, method: 'graceful', pid };
  }
  try { process.kill(-pid, 'SIGKILL'); }
  catch (error) { if (error?.code !== 'ESRCH') return { stopped: false, reason: 'force_signal_failed', pid }; }
  const forceDeadline = Date.now() + Math.max(1000, gracePeriodMs);
  while (Date.now() < forceDeadline) {
    await sleep(pollIntervalMs);
    if (!groupRunning(pid)) return { stopped: true, method: 'group_sigkill', pid };
  }
  return { stopped: false, reason: 'force_kill_timeout', pid };
}
