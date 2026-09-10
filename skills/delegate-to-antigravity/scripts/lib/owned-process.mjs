import { spawnSync } from 'node:child_process';

/** Signal a directly owned child, spawned with detached:true on POSIX.
 * Persisted/recovered PIDs must use identity-verified terminateProcess instead.
 */
export function terminateOwnedProcessTree(child) {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true, stdio: 'ignore',
    });
  } else {
    try { process.kill(-child.pid, 'SIGTERM'); }
    catch (error) {
      if (error.code !== 'ESRCH') throw error;
      // The owned process may have already exited.
    }
  }
}
