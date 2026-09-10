import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseProcessDate, compareProcessDates, queryProcessIdentity, validateProcessIdentity, terminateProcess } from '../../skills/delegate-to-antigravity/scripts/lib/windows-process.mjs';
import { acquireSlot, classifyLease, getCounts, reclaimLeases, scanLeases } from '../../skills/delegate-to-antigravity/scripts/lib/leases.mjs';
import { createJob, createAttempt } from '../../skills/delegate-to-antigravity/scripts/lib/ledger.mjs';
import { runJobAction } from '../../skills/delegate-to-antigravity/scripts/lib/controller.mjs';
import { acquireCommonDirLock } from '../../skills/delegate-to-antigravity/scripts/lib/git-worktree.mjs';
import { terminateOwnedProcessTree } from '../../skills/delegate-to-antigravity/scripts/lib/owned-process.mjs';
import { withFileLock } from '../../skills/delegate-to-antigravity/scripts/lib/storage.mjs';

async function root(t) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'agy-reliability-'));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  return directory;
}

const identity = { pid: process.pid, creationTime: '2026-09-10T00:00:00Z', executable: process.execPath, commandLine: 'test' };
const supervisor = {
  queryProcessIdentity: async () => ({ running: true, identity }),
  validateProcessIdentity: () => ({ matches: true }),
};

test('stale live nonce owners and malformed owner records remain protected', async (t) => {
  const directory = await root(t);
  for (const [name, record] of [
    ['owner-12345678-abcd.json', JSON.stringify({ owner: 'live-main-owner', pid: process.pid })],
    ['owner.json', '{malformed'],
  ]) {
    const lock = path.join(directory, name + '.lock');
    await fsp.mkdir(lock);
    const ownerPath = path.join(lock, name);
    await fsp.writeFile(ownerPath, record);
    const old = new Date(Date.now() - 180000);
    await fsp.utimes(lock, old, old);
    await assert.rejects(withFileLock(lock, () => assert.fail('protected lock stolen'), {
      maxWaitMs: 30, retryDelayMs: 5, staleMs: 0,
    }), /Timed out acquiring lock/);
    assert.equal(await fsp.readFile(ownerPath, 'utf8'), record);
  }
});

test('DMTF signed offsets are minutes and preserve comparison tolerance', () => {
  for (const [offset, expected] of [
    ['+330', '2026-09-07T08:47:58.626Z'],
    ['-300', '2026-09-07T19:17:58.626Z'],
    ['+000', '2026-09-07T14:17:58.626Z'],
  ]) {
    const dmtf = `20260907141758.626000${offset}`;
    assert.equal(parseProcessDate(dmtf), Date.parse(expected));
    assert.equal(compareProcessDates(dmtf, Date.parse(expected) + 1000), true);
    assert.equal(compareProcessDates(dmtf, Date.parse(expected) + 3000), false);
  }
});

test('owned Windows cleanup reports command failures and timeouts', async () => {
  for (const response of [{ exitCode: 1 }, { exitCode: 0, timedOut: true }, { status: null }]) {
    const result = await terminateOwnedProcessTree({ pid: 123456, platform: 'win32', commandRunner: async () => response });
    assert.equal(result.stopped, false);
  }
  const thrown = await terminateOwnedProcessTree({ pid: 123456, platform: 'win32', commandRunner: async () => { throw new Error('denied'); } });
  assert.equal(thrown.stopped, false);
  const success = await terminateOwnedProcessTree({ pid: 123456, platform: 'win32', commandRunner: async () => ({ exitCode: 0 }) });
  assert.equal(success.stopped, true);
});

test('owned cleanup kills a surviving grandchild after its parent exits', {
  skip: process.platform === 'win32', timeout: 15000,
}, async (t) => {
  const script = `const {spawn}=require('node:child_process');
    const c=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{}); console.log('ready'); setInterval(()=>{},1000)"],{stdio:['ignore','pipe','ignore']});
    c.stdout.once('data',()=>console.log(c.pid)); setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ['-e', script], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} });
  const [data] = await once(child.stdout, 'data');
  const grandchild = Number(data.toString().trim());
  assert.ok(grandchild > 0);
  const result = await terminateOwnedProcessTree({ child, gracePeriodMs: 150 });
  assert.equal(result.stopped, true);
  assert.equal((await queryProcessIdentity(child.pid)).running, false);
  assert.equal((await queryProcessIdentity(grandchild)).running, false);
});

test('failed Windows probes never authorize dead-owner reclaim', async () => {
  for (const response of [{ stdout: 'garbage' }, { stdout: '', exitCode: 1 }, { stdout: '', timedOut: true }]) {
    const probe = await queryProcessIdentity(process.pid, { platform: 'win32', commandRunner: async () => response });
    assert.equal(probe.running, true);
    assert.equal(probe.identity, null);
  }
  const probe = await queryProcessIdentity(process.pid, { platform: 'win32', commandRunner: async () => { throw new Error('CIM unavailable'); } });
  assert.equal(probe.running, true);
  assert.equal(probe.identity, null);
});

test('macOS ps parsing preserves executable paths with spaces and real start time', async () => {
  const columns = { stat: 'S', lstart: 'Thu Sep 10 12:34:56 2026', comm: '/Applications/Node Runtime/node', args: '/Applications/Node Runtime/node worker.js' };
  const commandRunner = async ({ command, args, env }) => {
    assert.equal(command, 'ps');
    assert.equal(env.LC_ALL, 'C');
    return { stdout: columns[args.at(-1).slice(0, -1)], exitCode: 0 };
  };
  const probe = await queryProcessIdentity(process.pid, { platform: 'darwin', commandRunner });
  assert.deepEqual(probe.identity, { pid: process.pid, creationTime: '2026-09-10T12:34:56.000Z', executable: columns.comm, commandLine: columns.args });
});

test('real POSIX process identity stays stable, leases count as active, and cancellation works', {
  skip: !['linux', 'darwin'].includes(process.platform), timeout: 15000,
}, async (t) => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  t.after(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} });
  await once(child, 'spawn');
  const first = await queryProcessIdentity(child.pid);
  assert.equal(first.running, true);
  assert.ok(first.identity?.commandLine);
  await new Promise(resolve => setTimeout(resolve, 50));
  const second = await queryProcessIdentity(child.pid);
  assert.deepEqual(first.identity, second.identity);
  assert.equal(validateProcessIdentity(first.identity, second.identity).matches, true);
  assert.equal(validateProcessIdentity({ ...first.identity, executable: `/wrong/${path.basename(first.identity.executable)}` }, second.identity).matches, false);
  const blocked = await terminateProcess({ pid: child.pid, identity: { ...first.identity, creationTime: 'wrong' } });
  assert.equal(blocked.blocked, true);
  const stateRoot = await root(t);
  const acquired = await acquireSlot({ stateRoot, jobId: 'live', attemptId: 'one', processIdentity: first.identity });
  assert.equal((await classifyLease(acquired.lease)).status, 'active');
  assert.equal((await getCounts({ stateRoot })).activeCount, 1);
  const result = await terminateProcess({ pid: child.pid, identity: first.identity, gracePeriodMs: 1000 });
  assert.equal(result.stopped, true);
  const reclaimed = await reclaimLeases({ stateRoot });
  assert.equal(reclaimed.reclaimed.length, 1);
});

test('dead controller directory locks recover and concurrent acquisition publishes one complete lease', async (t) => {
  const stateRoot = await root(t);
  const slots = path.join(stateRoot, 'locks', 'slots');
  const lock = path.join(slots, 'slot-0.json.lock');
  await fsp.mkdir(lock, { recursive: true });
  const exited = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  const deadPid = exited.pid;
  await once(exited, 'exit');
  await fsp.writeFile(path.join(lock, 'owner.json'), JSON.stringify({ owner: 'dead-owner', pid: deadPid, createdAt: Date.now() }));
  // Recover first, then stress concurrent publishers against the same slot.
  const acquired = await acquireSlot({ stateRoot, jobId: 'first', attemptId: 'one', processIdentity: identity, maxSlots: 1 });
  assert.equal(acquired.acquired, true);
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => acquireSlot({ stateRoot, jobId: `racer-${i}`, attemptId: 'one', processIdentity: identity, maxSlots: 1 })));
  assert.equal(results.filter(result => result.acquired).length, 0);
  const stored = JSON.parse(await fsp.readFile(acquired.slotPath, 'utf8'));
  assert.equal(stored.nonce, acquired.lease.nonce);
  assert.deepEqual((await fsp.readdir(slots)).filter(name => name.endsWith('.tmp')), []);
});

test('legacy locks and corrupt leases are visible, blocked, and never silently reclaimed', async (t) => {
  const stateRoot = await root(t);
  const slots = path.join(stateRoot, 'locks', 'slots');
  await fsp.mkdir(slots, { recursive: true });
  await fsp.writeFile(path.join(slots, 'slot-0.json.lock'), 'legacy-nonce');
  await fsp.writeFile(path.join(slots, 'slot-1.json'), '{torn');
  const counts = await getCounts({ stateRoot, maxSlots: 2 });
  assert.equal(counts.availableCount, 0);
  assert.equal(counts.lockedCount, 1);
  assert.equal(counts.corruptCount, 1);
  const reclaimed = await reclaimLeases({ stateRoot, maxSlots: 2 });
  assert.equal(reclaimed.reclaimed.length, 0);
  assert.equal(reclaimed.blocked.length, 2);
  assert.equal((await acquireSlot({ stateRoot, maxSlots: 2, jobId: 'blocked', attemptId: 'one', processIdentity: identity })).acquired, false);
  assert.equal(await fsp.readFile(path.join(slots, 'slot-1.json'), 'utf8'), '{torn');
});

test('lease scans query a shared PID once per scan, never cache across scans', async (t) => {
  const stateRoot = await root(t);
  for (let i = 0; i < 2; i++) await acquireSlot({ stateRoot, jobId: `job-${i}`, attemptId: 'one', processIdentity: identity, controllerPid: process.pid });
  let probes = 0;
  const processSupervisor = { ...supervisor, queryProcessIdentity: async () => { probes++; return { running: true, identity }; } };
  assert.equal((await scanLeases({ stateRoot, processSupervisor })).activeCount, 2);
  assert.equal(probes, 1);
  await scanLeases({ stateRoot, processSupervisor });
  assert.equal(probes, 2);
});

test('cancel without an active attempt or worker returns a structured reason', async (t) => {
  const stateRoot = await root(t);
  const job = await createJob(stateRoot);
  assert.equal((await runJobAction(stateRoot, 'cancel', job.jobId)).reason, 'no_active_worker');
  await createAttempt(stateRoot, job.jobId);
  assert.equal((await runJobAction(stateRoot, 'cancel', job.jobId)).reason, 'no_active_worker');
});

test('common-directory lock release preserves a replacement owner', async (t) => {
  const directory = await root(t);
  const lock = await acquireCommonDirLock(directory);
  await fsp.writeFile(lock.lockPath, JSON.stringify({ token: 'replacement', pid: process.pid }));
  await lock.release();
  assert.equal(JSON.parse(await fsp.readFile(lock.lockPath, 'utf8')).token, 'replacement');
});

test('owned POSIX teardown signals the grandchild process group', {
  skip: !['linux', 'darwin'].includes(process.platform), timeout: 15000,
}, async (t) => {
  const script = `const {spawn}=require('node:child_process'); const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); console.log(c.pid); setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ['-e', script], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} });
  const [data] = await once(child.stdout, 'data');
  const grandchild = Number(data.toString().trim());
  assert.ok(grandchild > 0);
  const exited = once(child, 'exit');
  terminateOwnedProcessTree(child);
  await exited;
  for (let i = 0; i < 40; i++) {
    if (!(await queryProcessIdentity(grandchild)).running) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail('grandchild survived process-group termination');
});


test('live slot lock ownership is never stolen based on age', async (t) => {
  const stateRoot = await root(t);
  const lock = path.join(stateRoot, 'locks', 'slots', 'slot-0.json.lock');
  await fsp.mkdir(lock, { recursive: true });
  const owner = { owner: 'live-owner', pid: process.pid, createdAt: 0 };
  await fsp.writeFile(path.join(lock, 'owner.json'), JSON.stringify(owner));
  const result = await acquireSlot({ stateRoot, maxSlots: 1, jobId: 'blocked', attemptId: 'one', processIdentity: identity });
  assert.equal(result.acquired, false);
  assert.deepEqual(JSON.parse(await fsp.readFile(path.join(lock, 'owner.json'), 'utf8')), owner);
});

test('cross-process contenders recover one dead lock without overwriting a winner', { timeout: 20000 }, async (t) => {
  const stateRoot = await root(t);
  const lock = path.join(stateRoot, 'locks', 'slots', 'slot-0.json.lock');
  await fsp.mkdir(lock, { recursive: true });
  const exited = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  const deadPid = exited.pid;
  await once(exited, 'exit');
  await fsp.writeFile(path.join(lock, 'owner-dead.json'), JSON.stringify({ owner: 'dead', pid: deadPid }));
  const leasesUrl = new URL('../../skills/delegate-to-antigravity/scripts/lib/leases.mjs', import.meta.url).href;
  const script = `import { acquireSlot } from ${JSON.stringify(leasesUrl)};
    const result = await acquireSlot({ stateRoot: ${JSON.stringify(stateRoot)}, maxSlots: 1, jobId: String(process.pid), attemptId: 'one', processIdentity: { pid: process.pid, creationTime: 'test', executable: process.execPath, commandLine: 'test' } });
    console.log(JSON.stringify(result));`;
  const results = await Promise.all(Array.from({ length: 8 }, async () => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
    let output = '', errors = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { errors += chunk; });
    const [code] = await once(child, 'close');
    assert.equal(code, 0, errors);
    return JSON.parse(output);
  }));
  const winners = results.filter(result => result.acquired);
  assert.equal(winners.length, 1);
  assert.equal(JSON.parse(await fsp.readFile(winners[0].slotPath, 'utf8')).nonce, winners[0].lease.nonce);
});
