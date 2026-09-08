import fsp from 'node:fs/promises';
import path from 'node:path';

export const ALLOWED_PHASES = new Set([
  'accepted',
  'preparing',
  'running',
  'verifying',
  'completed',
  'failed',
  'cancelled',
]);

export const REJECTED_FIELDS = new Set([
  'thinking',
  'reasoning',
  'chainOfThought',
  'prompt',
  'stdout',
  'stderr',
  'secret',
  'token',
]);

export const PUBLIC_FIELDS = new Set([
  'timestamp',
  'phase',
  'message',
  'elapsedMs',
  'tool',
  'files',
  'usage',
]);

const ALLOWED_USAGE_KEYS = new Set(['inputTokens', 'outputTokens', 'totalTokens']);
const FORBIDDEN_FIELDS = new Set(
  Array.from(REJECTED_FIELDS, (f) => f.toLowerCase())
);
const pathLocks = new Map();

function withPathLock(targetPath, fn) {
  const prev = pathLocks.get(targetPath) || Promise.resolve();
  const current = prev.catch(() => {}).then(fn);
  const cleanup = current.catch(() => {}).finally(() => {
    if (pathLocks.get(targetPath) === cleanup) {
      pathLocks.delete(targetPath);
    }
  });
  pathLocks.set(targetPath, cleanup);
  return current;
}

function normalizeString(val, maxLen) {
  if (val === null || val === undefined) return undefined;
  if (typeof val !== 'string') throw new TypeError('Expected string value');
  const cleaned = val.normalize('NFC').replace(/[\x00-\x1F\x7F-\x9F]+/g, ' ').trim();
  return maxLen !== undefined ? cleaned.slice(0, maxLen) : cleaned;
}

function validateAndSanitizeEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    throw new TypeError('Activity event must be an object');
  }

  for (const key of Object.keys(event)) {
    if (FORBIDDEN_FIELDS.has(key.toLowerCase())) {
      throw new Error(`Prohibited field in activity event: "${key}"`);
    }
    if (!PUBLIC_FIELDS.has(key)) {
      throw new Error(`Unknown field in activity event: "${key}"`);
    }
  }

  if (!event.phase || typeof event.phase !== 'string' || !ALLOWED_PHASES.has(event.phase)) {
    throw new Error(`Invalid or missing activity phase: "${event?.phase}"`);
  }

  let timestamp;
  if (event.timestamp === undefined) {
    timestamp = new Date().toISOString();
  } else if (
    (typeof event.timestamp === 'string' && event.timestamp.trim().length > 0) ||
    (typeof event.timestamp === 'number' && Number.isFinite(event.timestamp)) ||
    (event.timestamp instanceof Date && !Number.isNaN(event.timestamp.getTime()))
  ) {
    const d = event.timestamp instanceof Date ? event.timestamp : new Date(event.timestamp);
    if (Number.isNaN(d.getTime())) {
      throw new TypeError(`Invalid timestamp: "${event.timestamp}"`);
    }
    timestamp = d.toISOString();
  } else {
    throw new TypeError('timestamp must be a valid ISO string, epoch number, or Date');
  }

  const record = { timestamp, phase: event.phase };

  if (event.message !== undefined) {
    record.message = normalizeString(event.message, 240);
  }

  if (event.elapsedMs !== undefined) {
    if (typeof event.elapsedMs !== 'number' || !Number.isFinite(event.elapsedMs) || event.elapsedMs < 0) {
      throw new TypeError('elapsedMs must be a non-negative number');
    }
    record.elapsedMs = Math.round(event.elapsedMs);
  }

  if (event.tool !== undefined) {
    record.tool = normalizeString(event.tool, 80);
  }

  if (event.files !== undefined) {
    if (!Array.isArray(event.files)) throw new TypeError('files must be an array of strings');
    record.files = event.files.slice(0, 20).map((f) => {
      if (typeof f !== 'string') throw new TypeError('Each file entry must be a string');
      return normalizeString(f, 260);
    });
  }

  if (event.usage !== undefined) {
    if (typeof event.usage !== 'object' || event.usage === null || Array.isArray(event.usage)) {
      throw new TypeError('usage must be an object');
    }
    const cleanUsage = {};
    for (const [k, v] of Object.entries(event.usage)) {
      if (!ALLOWED_USAGE_KEYS.has(k)) {
        throw new Error(`Prohibited usage key: "${k}"`);
      }
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
        throw new TypeError(`Usage field "${k}" must be a non-negative number`);
      }
      cleanUsage[k] = Math.round(v);
    }
    record.usage = cleanUsage;
  }

  return record;
}

function resolveActivityFile(jobDir) {
  if (!jobDir || typeof jobDir !== 'string' || jobDir.trim().length === 0) {
    throw new TypeError('jobDir must be a non-empty string path');
  }
  return path.join(path.resolve(jobDir), 'activity.jsonl');
}

export async function appendActivityEvent(jobDir, event, options = {}) {
  const record = validateAndSanitizeEvent(event);
  const filePath = resolveActivityFile(jobDir);

  const st = await fsp.stat(path.resolve(jobDir));
  if (!st.isDirectory()) throw new Error(`jobDir must be an existing directory: ${jobDir}`);

  return withPathLock(filePath, async () => {
    const line = JSON.stringify(record) + '\n';
    const handle = await fsp.open(filePath, 'a');
    try {
      await handle.writeFile(line, 'utf8');
      if (options.fsync !== false) await handle.sync();
    } finally {
      await handle.close();
    }
    return record;
  });
}

export async function readActivityEvents(jobDir, options = {}) {
  const filePath = resolveActivityFile(jobDir);
  let content;
  try {
    content = await fsp.readFile(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }

  const rawLines = content.split(/\r?\n/);
  const nonEmpties = [];
  for (let i = 0; i < rawLines.length; i++) {
    if (rawLines[i].trim().length > 0) {
      nonEmpties.push({ lineNum: i + 1, text: rawLines[i] });
    }
  }

  const events = [];
  let truncatedTail = null;
  for (let i = 0; i < nonEmpties.length; i++) {
    const isLast = i === nonEmpties.length - 1;
    const { lineNum, text } = nonEmpties[i];
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (parseErr) {
      if (isLast) {
        truncatedTail = text;
        break;
      }
      throw new Error(`Malformed activity event JSON at line ${lineNum}: ${parseErr.message}`);
    }
    events.push(validateAndSanitizeEvent(parsed));
  }

  const limit = Math.min(options.limit ?? 100, 100);
  const result = limit > 0 ? events.slice(-limit) : [];
  if (truncatedTail !== null) result.truncatedTail = truncatedTail;
  return result;
}