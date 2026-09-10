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

// Cross-process lock with an ownership nonce. A live owner is never stolen;
// callers wait until it releases (or an owner that is provably dead is stale).
export async function withFileLock(lockPath, fn, options = {}) {
  const { retryDelayMs = 10, maxWaitMs = 30000 } = options;
  const nonce = generateUuid();
  const owner = `${process.pid}:${nonce}`;
  const ownerFile = path.join(lockPath, `owner-${nonce}.json`);
  const started = Date.now();
  let acquired = false;
  while (!acquired) {
    try {
      await fsp.mkdir(lockPath);
      try {
        await fsp.writeFile(ownerFile, JSON.stringify({ owner, pid: process.pid, createdAt: Date.now() }), { flag: 'wx' });
      } catch (err) {
        await fsp.unlink(ownerFile).catch(() => {});
        await fsp.rmdir(lockPath).catch(() => {});
        throw err;
      }
      acquired = true;
    } catch (err) {
      if (err.code !== 'EEXIST' && err.code !== 'ENOENT') throw err;
      try {
        const entries = await fsp.readdir(lockPath);
        // Read old owner.json records too, but never recursively remove the
        // directory: a concurrent reclaimer may already have replaced it.
        const owners = entries.filter(name => name === 'owner.json' || /^owner-[a-f0-9-]+\.json$/.test(name));
        if (owners.length === 1) {
          const observedFile = path.join(lockPath, owners[0]);
          const info = JSON.parse(await fsp.readFile(observedFile, 'utf8'));
          let dead = false;
          if (info.owner && Number.isSafeInteger(info.pid) && info.pid > 0) {
            try { process.kill(info.pid, 0); } catch (probe) { dead = probe.code === 'ESRCH'; }
          }
          if (dead) {
            // The unique filename prevents a late reclaimer from unlinking a
            // replacement owner's record. rmdir refuses nonempty directories.
            await fsp.unlink(observedFile).catch(() => {});
            await fsp.rmdir(lockPath).catch(() => {});
          }
        }
      } catch { /* Unknown or incomplete ownership is never stolen by age. */ }
      if (Date.now() - started >= maxWaitMs) throw new Error(`Timed out acquiring lock ${lockPath}`);
      await new Promise(resolve => setTimeout(resolve, retryDelayMs));
    }
  }
  try { return await fn(); }
  finally {
    try {
      const info = JSON.parse(await fsp.readFile(ownerFile, 'utf8'));
      if (info.owner === owner) {
        await fsp.unlink(ownerFile);
        await fsp.rmdir(lockPath);
      }
    } catch { /* Preserve lock if ownership cannot be verified. */ }
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
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new TypeError('maxBytes must be a non-negative safe integer');
  const headTarget = Math.floor(maxBytes / 2);
  const tailTarget = maxBytes - headTarget;
  let totalBytes = 0;
  const hash = crypto.createHash('sha256');
  let chunks = [];
  let truncated = false;
  let headBuffer = Buffer.alloc(0);
  let tailBuffer = Buffer.alloc(0);
  let tailPosition = 0;

  return {
    write(chunk) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
      if (buf.length === 0) return;
      totalBytes += buf.length;
      hash.update(buf);

      if (!truncated) {
        chunks.push(buf);
        if (totalBytes > maxBytes) {
          truncated = true;
          // Copy only retained bytes, even if a single input chunk is huge.
          headBuffer = Buffer.concat(chunks, headTarget);
          if (buf.length >= tailTarget) {
            tailBuffer = Buffer.from(buf.subarray(buf.length - tailTarget));
          } else {
            const combined = Buffer.concat(chunks);
            tailBuffer = Buffer.from(combined.subarray(combined.length - tailTarget));
          }
          chunks = null;
        }
      } else {
        // Fixed-size circular tail: each incoming byte is copied at most once.
        if (tailTarget === 0) return;
        if (buf.length >= tailTarget) {
          buf.copy(tailBuffer, 0, buf.length - tailTarget);
          tailPosition = 0;
        } else {
          const first = Math.min(buf.length, tailTarget - tailPosition);
          buf.copy(tailBuffer, tailPosition, 0, first);
          buf.copy(tailBuffer, 0, first);
          tailPosition = (tailPosition + buf.length) % tailTarget;
        }
      }
    },
    finish() {
      const digest = hash.digest('hex');
      if (!truncated) {
        const full = Buffer.concat(chunks);
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

      if (tailPosition) {
        tailBuffer = Buffer.concat([tailBuffer.subarray(tailPosition), tailBuffer.subarray(0, tailPosition)]);
      }
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
