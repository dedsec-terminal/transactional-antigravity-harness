import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

export const MAX_STREAM_CAPTURE_BYTES = 2 * 1024 * 1024; // 2 MiB = 2,097,152 bytes

export function getDefaultAgyRoot() {
  if (process.env.AGY_ROOT) {
    return path.resolve(process.env.AGY_ROOT);
  }
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    return path.join(process.env.LOCALAPPDATA, 'agy');
  }
  return path.join(os.homedir(), '.agy');
}

export function resolveAgyRoot(root) {
  return path.resolve(root || getDefaultAgyRoot());
}

export async function ensureDir(dirPath) {
  await fsp.mkdir(dirPath, { recursive: true });
  return dirPath;
}

function lockOwnerPath(lockPath) {
  return path.join(lockPath, 'owner.json');
}

async function readLockOwner(lockPath) {
  try {
    return JSON.parse(await fsp.readFile(lockOwnerPath(lockPath), 'utf8'));
  } catch {
    return null;
  }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code !== 'ESRCH';
  }
}

// A lock is abandoned when its owner record proves the owner is dead, or when
// publication never completed (no readable record) and the lock is older than
// the stale window. A record that exists but cannot be verified never qualifies.
async function lockIsAbandoned(lockPath, staleMs) {
  const info = await readLockOwner(lockPath);
  if (info && typeof info.owner === 'string' && Number.isInteger(info.pid) && info.pid > 0) {
    return !processIsAlive(info.pid);
  }
  let stat;
  try {
    stat = await fsp.stat(lockPath);
  } catch {
    return false;
  }
  return Date.now() - stat.mtimeMs > staleMs;
}

// Publishes the lock directory with its owner record inside. rename() is atomic
// and fails when the lock already exists, so two contenders can never both
// believe they created it and a crash cannot leave an empty lock behind.
async function publishLockDirectory(lockPath, ownerRecord, randomId) {
  const stagingPath = `${lockPath}.publish.${randomId()}`;
  await fsp.mkdir(stagingPath);
  try {
    await fsp.writeFile(lockOwnerPath(stagingPath), JSON.stringify(ownerRecord), 'utf8');
    await fsp.rename(stagingPath, lockPath);
  } catch (err) {
    await fsp.rm(stagingPath, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

// Removes an abandoned lock by atomically renaming it aside first. Only one
// contender can win that rename, and the moved record is re-verified before
// deletion so a replacement lock is restored instead of stolen.
async function removeAbandonedLock(lockPath, expectedOwner, randomId) {
  const graveyardPath = `${lockPath}.reclaim.${randomId()}`;
  try {
    await fsp.rename(lockPath, graveyardPath);
  } catch (err) {
    if (err.code === 'ENOENT') return true;
    throw err;
  }
  const moved = await readLockOwner(graveyardPath);
  const movedOwner = moved && typeof moved.owner === 'string' ? moved.owner : null;
  if (movedOwner !== expectedOwner) {
    try { await fsp.rename(graveyardPath, lockPath); }
    catch { /* keep the moved lock on disk rather than delete one that may be live */ }
    return false;
  }
  await fsp.rm(graveyardPath, { recursive: true, force: true }).catch(() => {});
  return true;
}

// Cross-process lock with an atomically published ownership record. A live or
// unverifiable owner is never stolen; dead owners and incomplete publications
// are reclaimed under an atomic claim so only one contender can recover.
export async function withFileLock(lockPath, fn, options = {}) {
  const { retryDelayMs = 10, maxWaitMs = 30000, staleMs = 120000, randomId = generateUuid } = options;
  const owner = `${process.pid}:${randomId()}`;
  const started = Date.now();
  let acquired = false;
  while (!acquired) {
    try {
      await publishLockDirectory(lockPath, { owner, pid: process.pid, createdAt: Date.now() }, randomId);
      acquired = true;
    } catch (err) {
      if (!['EEXIST', 'ENOTEMPTY', 'ENOTDIR', 'EPERM', 'EACCES', 'EBUSY'].includes(err.code)) throw err;
      const info = await readLockOwner(lockPath);
      const expectedOwner = info && typeof info.owner === 'string' ? info.owner : null;
      if (await lockIsAbandoned(lockPath, staleMs)) {
        await removeAbandonedLock(lockPath, expectedOwner, randomId);
        continue;
      }
      if (Date.now() - started >= maxWaitMs) throw new Error(`Timed out acquiring lock ${lockPath}`);
      await new Promise(resolve => setTimeout(resolve, retryDelayMs));
    }
  }
  try { return await fn(); }
  finally {
    try {
      const info = JSON.parse(await fsp.readFile(lockOwnerPath(lockPath), 'utf8'));
      if (info.owner === owner) await fsp.rm(lockPath, { recursive: true, force: true });
    } catch { /* preserve lock if ownership cannot be verified */ }
  }
}

export function generateUuid() {
  return crypto.randomUUID();
}

export function sha256(data) {
  const hash = crypto.createHash('sha256');
  if (typeof data === 'string' || Buffer.isBuffer(data) || data instanceof Uint8Array) {
    hash.update(data);
  } else {
    throw new TypeError('Expected string, Buffer, or Uint8Array for sha256');
  }
  return hash.digest('hex');
}

export function canonicalJsonStringify(obj) {
  if (obj === null || typeof obj !== 'object') {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return '[' + obj.map(canonicalJsonStringify).join(',') + ']';
  }
  const keys = Object.keys(obj).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalJsonStringify(obj[k])).join(',') + '}';
}

export function sha256Json(obj) {
  return sha256(Buffer.from(canonicalJsonStringify(obj), 'utf8'));
}

export async function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

export async function writeJsonAtomic(filePath, data, options = {}) {
  const {
    rename = fsp.rename,
    fsync = true,
    maxRetries = 10,
    baseRetryDelayMs = 25,
    sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms)),
    space = 2,
    randomId = generateUuid,
  } = options;

  const targetPath = path.resolve(filePath);
  const targetDir = path.dirname(targetPath);
  await ensureDir(targetDir);

  const tempPath = path.join(targetDir, `.${path.basename(targetPath)}.${randomId()}.tmp`);
  const jsonContent = JSON.stringify(data, null, space) + '\n';
  const buffer = Buffer.from(jsonContent, 'utf8');

  let handle;
  try {
    handle = await fsp.open(tempPath, 'w');
    await handle.writeFile(buffer);
    if (fsync) {
      await handle.sync();
    }
  } finally {
    if (handle) {
      await handle.close();
    }
  }

  let attempt = 0;
  while (true) {
    try {
      await rename(tempPath, targetPath);
      break;
    } catch (err) {
      attempt++;
      const isTransientWindows = (
        err.code === 'EPERM' ||
        err.code === 'EBUSY' ||
        err.code === 'EACCES'
      );
      if (attempt <= maxRetries && isTransientWindows) {
        const delay = baseRetryDelayMs * Math.pow(1.5, attempt - 1);
        await sleep(delay);
        continue;
      }
      try {
        await fsp.unlink(tempPath);
      } catch {
        // Ignore unlink error on failure cleanup
      }
      throw err;
    }
  }
}

export async function readJson(filePath) {
  const content = await fsp.readFile(filePath, 'utf8');
  return JSON.parse(content);
}

export async function appendJsonl(filePath, record, options = {}) {
  const { fsync = true } = options;
  const targetPath = path.resolve(filePath);
  await ensureDir(path.dirname(targetPath));

  const line = JSON.stringify(record) + '\n';
  const buffer = Buffer.from(line, 'utf8');

  const handle = await fsp.open(targetPath, 'a');
  try {
    await handle.writeFile(buffer);
    if (fsync) {
      await handle.sync();
    }
  } finally {
    await handle.close();
  }
}

export class CorruptJsonlError extends Error {
  constructor(message, { filePath, lineNumber, lineContent, cause } = {}) {
    super(message);
    this.name = 'CorruptJsonlError';
    this.code = 'ERR_CORRUPT_JSONL';
    this.filePath = filePath;
    this.lineNumber = lineNumber;
    this.lineContent = lineContent;
    this.cause = cause;
  }
}

export async function readJsonlTolerant(filePath, options = {}) {
  let content;
  try {
    content = await fsp.readFile(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      const empty = [];
      empty.records = empty;
      empty.corruptTail = null;
      empty.linesRead = 0;
      return empty;
    }
    throw err;
  }

  const rawLines = content.split(/\r?\n/);
  const nonEmpties = [];
  for (let i = 0; i < rawLines.length; i++) {
    const text = rawLines[i].trim();
    if (text.length > 0) {
      nonEmpties.push({ index: i, lineNum: i + 1, text: rawLines[i] });
    }
  }

  const records = [];
  let corruptTail = null;

  for (let i = 0; i < nonEmpties.length; i++) {
    const item = nonEmpties[i];
    const isLastNonEmpty = (i === nonEmpties.length - 1);

    try {
      const parsed = JSON.parse(item.text);
      records.push(parsed);
    } catch (parseErr) {
      if (isLastNonEmpty) {
        corruptTail = item.text;
      } else {
        throw new CorruptJsonlError(
          `Corrupt JSONL line ${item.lineNum} in ${filePath}: ${parseErr.message}`,
          {
            filePath,
            lineNumber: item.lineNum,
            lineContent: item.text,
            cause: parseErr,
          }
        );
      }
    }
  }

  records.records = records;
  records.corruptTail = corruptTail;
  records.linesRead = nonEmpties.length;
  return records;
}

export function captureBoundedBuffer(input, maxBytes = MAX_STREAM_CAPTURE_BYTES) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(typeof input === 'string' ? input : '', 'utf8');
  const totalBytes = buf.length;
  const hash = sha256(buf);

  if (totalBytes <= maxBytes) {
    const str = buf.toString('utf8');
    return {
      truncated: false,
      totalBytes,
      headBytes: totalBytes,
      tailBytes: 0,
      droppedBytes: 0,
      maxBytes,
      sha256: hash,
      content: str,
      headContent: str,
      tailContent: '',
    };
  }

  const headSize = Math.floor(maxBytes / 2);
  const tailSize = maxBytes - headSize;
  const droppedBytes = totalBytes - maxBytes;

  const headBuf = buf.subarray(0, headSize);
  const tailBuf = buf.subarray(totalBytes - tailSize);
  const headContent = headBuf.toString('utf8');
  const tailContent = tailBuf.toString('utf8');
  const summaryMarker = `\n... [truncated ${droppedBytes} bytes] ...\n`;

  return {
    truncated: true,
    totalBytes,
    headBytes: headBuf.length,
    tailBytes: tailBuf.length,
    droppedBytes,
    maxBytes,
    sha256: hash,
    content: headContent + summaryMarker + tailContent,
    headContent,
    tailContent,
  };
}

export function createBoundedStreamCollector(maxBytes = MAX_STREAM_CAPTURE_BYTES) {
  const headTarget = Math.floor(maxBytes / 2);
  const tailTarget = maxBytes - headTarget;
  let totalBytes = 0;
  const hash = crypto.createHash('sha256');
  let headChunks = [];
  let headLength = 0;
  let headBuffer = null;
  let tailChunks = [];
  let tailLength = 0;
  let truncated = false;

  // Keeps only the last tailTarget bytes in the queue; whole chunks fall off
  // the front and a single boundary chunk is trimmed in place. Concatenation
  // happens once in finish(), so appending is amortized instead of O(n^2).
  function appendTail(buf) {
    tailChunks.push(buf);
    tailLength += buf.length;
    while (tailChunks.length > 1 && tailLength - tailChunks[0].length >= tailTarget) {
      tailLength -= tailChunks[0].length;
      tailChunks.shift();
    }
    if (tailLength > tailTarget) {
      const overflow = tailLength - tailTarget;
      tailChunks[0] = tailChunks[0].subarray(overflow);
      tailLength -= overflow;
    }
  }

  return {
    write(chunk) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
      if (buf.length === 0) return;
      totalBytes += buf.length;
      hash.update(buf);

      if (!truncated) {
        headChunks.push(buf);
        headLength += buf.length;
        if (headLength > maxBytes) {
          truncated = true;
          const combined = Buffer.concat(headChunks);
          headBuffer = combined.subarray(0, headTarget);
          appendTail(combined.subarray(combined.length - tailTarget));
          headChunks = null;
        }
      } else {
        appendTail(buf);
      }
    },
    finish() {
      const digest = hash.digest('hex');
      if (!truncated) {
        const full = Buffer.concat(headChunks);
        const str = full.toString('utf8');
        return {
          truncated: false,
          totalBytes,
          headBytes: full.length,
          tailBytes: 0,
          droppedBytes: 0,
          maxBytes,
          sha256: digest,
          content: str,
          headContent: str,
          tailContent: '',
        };
      }

      const tailBuffer = Buffer.concat(tailChunks);
      const droppedBytes = totalBytes - (headBuffer.length + tailBuffer.length);
      const headContent = headBuffer.toString('utf8');
      const tailContent = tailBuffer.toString('utf8');
      return {
        truncated: true,
        totalBytes,
        headBytes: headBuffer.length,
        tailBytes: tailBuffer.length,
        droppedBytes,
        maxBytes,
        sha256: digest,
        content: headContent + `\n... [truncated ${droppedBytes} bytes] ...\n` + tailContent,
        headContent,
        tailContent,
      };
    }
  };
}
