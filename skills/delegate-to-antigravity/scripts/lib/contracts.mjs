import path from "node:path";

// ============================================================================
// Isolation & Concurrency Constants
// ============================================================================

export const ISOLATION_SHARED = "shared";
export const ISOLATION_WORKTREE = "worktree";
export const VALID_ISOLATION_MODES = Object.freeze([ISOLATION_SHARED, ISOLATION_WORKTREE]);

export const DEFAULT_ISOLATION = Object.freeze({
  SYNC_PLAN: ISOLATION_SHARED,
  SYNC_ACCEPT_EDITS: ISOLATION_WORKTREE,
  ASYNC_PLAN: ISOLATION_WORKTREE,
  ASYNC_ACCEPT_EDITS: ISOLATION_WORKTREE,
});

export const DEFAULT_RETENTION_MINUTES = 24 * 60; // 1440 minutes = 24 hours
export const EVIDENCE_RETENTION_DAYS = 14;
export const MAX_WORKER_SLOTS = 4;
export const MAX_CONCURRENT_SLOTS = 4;

// ============================================================================
// Parser & Payload Size Limits
// ============================================================================

export const MAX_RESULT_BYTES = 1024 * 1024; // 1 MiB payload limit
export const MAX_SUMMARY_CHARS = 1000;
export const MAX_VERIFICATION_CHARS = 2000;
export const MAX_DIAGNOSTICS_ITEMS = 100;
export const MAX_DIAGNOSTIC_CHARS = 1000;
export const MAX_CHANGED_PATHS = 1000;
export const MAX_PATH_CHARS = 1000;

export const ALLOWED_RESULT_KEYS = Object.freeze([
  "status",
  "summary",
  "verification",
  "diagnostics",
  "claimedChangedPaths",
]);

export const ALLOWED_STATUS_VALUES = Object.freeze([
  "success",
  "failure",
  "inconclusive",
]);

// ============================================================================
// JSON Schema for AGY --json-schema
// ============================================================================

export const TYPED_RESULT_SCHEMA = Object.freeze({
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "AntigravityTypedResult",
  type: "object",
  properties: {
    status: {
      type: "string",
      enum: [
        "success",
        "failure",
        "inconclusive",
        "SUCCESS",
        "FAILURE",
        "INCONCLUSIVE",
      ],
      description: "Terminal execution status of the delegated worker task",
    },
    summary: {
      type: "string",
      maxLength: MAX_SUMMARY_CHARS,
      description: "Concise summary of actions taken by the worker",
    },
    verification: {
      type: "string",
      maxLength: MAX_VERIFICATION_CHARS,
      description: "Bounded verification claims describing checks executed",
    },
    diagnostics: {
      type: "array",
      items: {
        type: "string",
        maxLength: MAX_DIAGNOSTIC_CHARS,
      },
      maxItems: MAX_DIAGNOSTICS_ITEMS,
      description: "Optional diagnostic messages or compiler outputs",
    },
    claimedChangedPaths: {
      type: "array",
      items: {
        type: "string",
        maxLength: MAX_PATH_CHARS,
      },
      maxItems: MAX_CHANGED_PATHS,
      description: "List of workspace-relative paths claimed to have been modified",
    },
  },
  required: ["status", "summary", "verification", "claimedChangedPaths"],
  additionalProperties: false,
});

export const CONTRACT_JSON_SCHEMA = TYPED_RESULT_SCHEMA;
export const RESULT_JSON_SCHEMA = TYPED_RESULT_SCHEMA;
export const TYPED_CONTRACT_SCHEMA = TYPED_RESULT_SCHEMA;

// ============================================================================
// Target Normalization & Validation Contract
// ============================================================================

/**
 * Normalizes a single target path to a workspace-relative forward-slash path.
 * Rejects path traversals (..) and absolute paths escaping the workspace.
 * Preserves directory prefixes (ending with '/').
 */
export function normalizeTarget(target, workspaceRoot) {
  if (target === null || target === undefined || typeof target !== "string") {
    throw new TypeError("Target path must be a non-empty string");
  }

  const raw = target.trim();
  if (!raw) {
    throw new Error("Target path must not be empty");
  }

  if (raw.includes("\0")) {
    throw new Error("Target path must not contain null bytes");
  }

  const isDirectoryPrefix = raw.endsWith("/") || raw.endsWith("\\");
  const forwardSlashes = raw.replace(/\\/g, "/");

  if (workspaceRoot) {
    const absWorkspace = path.resolve(workspaceRoot);
    const absTarget = path.isAbsolute(raw)
      ? path.resolve(raw)
      : path.resolve(absWorkspace, raw);

    const rel = path.relative(absWorkspace, absTarget);
    const relForward = rel.replace(/\\/g, "/");

    if (relForward === ".." || relForward.startsWith("../") || path.isAbsolute(relForward)) {
      throw new Error(`Target escape detected: "${raw}" resolves outside workspace root`);
    }

    if (relForward === "" || relForward === ".") {
      return isDirectoryPrefix ? "./" : ".";
    }

    return isDirectoryPrefix && !relForward.endsWith("/")
      ? `${relForward}/`
      : relForward;
  }

  // Without workspaceRoot: validate purely via syntax
  if (/^[a-zA-Z]:[/\\]/.test(raw) || forwardSlashes.startsWith("/") || forwardSlashes.startsWith("//")) {
    throw new Error(`Target escape detected: absolute path "${raw}" is not allowed without workspace root`);
  }

  const segments = forwardSlashes.split("/").filter((s) => s.length > 0 && s !== ".");
  const resolvedSegments = [];

  for (const seg of segments) {
    if (seg === "..") {
      if (resolvedSegments.length === 0) {
        throw new Error(`Target escape detected: "${raw}" escapes root directory`);
      }
      resolvedSegments.pop();
    } else {
      resolvedSegments.push(seg);
    }
  }

  if (resolvedSegments.length === 0) {
    throw new Error(`Target escape detected: "${raw}" resolves to root or empty path`);
  }

  const normalized = resolvedSegments.join("/");
  return isDirectoryPrefix ? `${normalized}/` : normalized;
}

/**
 * Normalizes an array, set, or delimiter-separated string of targets into a deterministically sorted array.
 */
export function normalizeTargets(targets, workspaceRoot) {
  let targetList = [];

  if (Array.isArray(targets) || targets instanceof Set) {
    targetList = Array.from(targets);
  } else if (typeof targets === "string") {
    targetList = targets.split(/[;,]/).map((t) => t.trim()).filter(Boolean);
  } else if (targets === null || targets === undefined) {
    return [];
  } else {
    throw new TypeError("targets must be an array, Set, string, or null/undefined");
  }

  const normalizedSet = new Set();
  for (const item of targetList) {
    const normalized = normalizeTarget(String(item), workspaceRoot);
    normalizedSet.add(normalized);
  }

  return Array.from(normalizedSet).sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
}

export function validateTarget(target, workspaceRoot) {
  return normalizeTarget(target, workspaceRoot);
}

export function validateTargets(targets, workspaceRoot) {
  return normalizeTargets(targets, workspaceRoot);
}

/**
 * Checks if a candidate file path is covered by normalized targets or directory prefixes.
 */
export function isPathCoveredByTargets(candidatePath, targets, workspaceRoot) {
  const normPath = normalizeTarget(candidatePath, workspaceRoot);
  const normTargets = normalizeTargets(targets, workspaceRoot);

  for (const t of normTargets) {
    if (t.endsWith("/")) {
      if (normPath === t.slice(0, -1) || normPath.startsWith(t)) {
        return true;
      }
    } else {
      if (normPath === t) {
        return true;
      }
    }
  }
  return false;
}

// ============================================================================
// Byte-Stable Four-Pillar Prompt Builder
// ============================================================================

/**
 * Builds a byte-stable four-pillar prompt in exact order:
 * TARGETS, ACTION, CONSTRAINTS, VERIFICATION with task text appended last.
 */
export function buildFourPillarPrompt(input = {}, taskTextOverride = "") {
  if (typeof input !== "object" || input === null) {
    throw new TypeError("Prompt input must be an object");
  }

  const targetsInput = input.targets ?? input.targetFiles;
  let formattedTargets = "none";

  if (targetsInput) {
    const normalized = normalizeTargets(targetsInput);
    if (normalized.length > 0) {
      formattedTargets = normalized.join("; ");
    }
  }

  const action = String(input.action ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();

  const constraints = String(input.constraints ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();

  const verification = String(input.verification ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();

  const taskText = String(taskTextOverride || input.task || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();

  const lines = [
    `TARGETS: ${formattedTargets}`,
    `ACTION: ${action}`,
    `CONSTRAINTS: ${constraints}`,
    `VERIFICATION: ${verification}`,
  ];

  if (taskText) {
    lines.push("", taskText);
  }

  return lines.join("\n");
}

export const buildPrompt = buildFourPillarPrompt;

// ============================================================================
// Strict Local Parser / Validator for Typed Results
// ============================================================================

/**
 * Validates a parsed typed result object with size/length limits and no extra properties.
 */
export function validateTypedResult(obj) {
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
    throw new TypeError("Typed result must be a JSON object");
  }

  const keys = Object.keys(obj);
  const allowedSet = new Set(ALLOWED_RESULT_KEYS);

  for (const key of keys) {
    if (!allowedSet.has(key)) {
      throw new Error(`Unexpected property in typed result: "${key}" (extra properties are forbidden)`);
    }
  }

  // Required fields check
  for (const req of ["status", "summary", "verification", "claimedChangedPaths"]) {
    if (!(req in obj)) {
      throw new Error(`Missing required property in typed result: "${req}"`);
    }
  }

  // Validate status
  if (typeof obj.status !== "string") {
    throw new TypeError("Property 'status' must be a string");
  }
  const normStatus = obj.status.toLowerCase();
  if (!ALLOWED_STATUS_VALUES.includes(normStatus)) {
    throw new Error(`Invalid status: "${obj.status}". Must be one of: ${ALLOWED_STATUS_VALUES.join(", ")}`);
  }

  // Validate summary
  if (typeof obj.summary !== "string") {
    throw new TypeError("Property 'summary' must be a string");
  }
  if (obj.summary.length > MAX_SUMMARY_CHARS) {
    throw new RangeError(`Property 'summary' length (${obj.summary.length}) exceeds limit of ${MAX_SUMMARY_CHARS}`);
  }

  // Validate verification
  if (typeof obj.verification !== "string") {
    throw new TypeError("Property 'verification' must be a string");
  }
  if (obj.verification.length > MAX_VERIFICATION_CHARS) {
    throw new RangeError(`Property 'verification' length (${obj.verification.length}) exceeds limit of ${MAX_VERIFICATION_CHARS}`);
  }

  // Validate claimedChangedPaths
  if (!Array.isArray(obj.claimedChangedPaths)) {
    throw new TypeError("Property 'claimedChangedPaths' must be an array");
  }
  if (obj.claimedChangedPaths.length > MAX_CHANGED_PATHS) {
    throw new RangeError(`Property 'claimedChangedPaths' item count (${obj.claimedChangedPaths.length}) exceeds limit of ${MAX_CHANGED_PATHS}`);
  }
  for (let i = 0; i < obj.claimedChangedPaths.length; i += 1) {
    const p = obj.claimedChangedPaths[i];
    if (typeof p !== "string") {
      throw new TypeError(`Property 'claimedChangedPaths[${i}]' must be a string`);
    }
    if (p.length > MAX_PATH_CHARS) {
      throw new RangeError(`Path in 'claimedChangedPaths[${i}]' length (${p.length}) exceeds limit of ${MAX_PATH_CHARS}`);
    }
  }

  // Validate diagnostics if present
  if (obj.diagnostics !== undefined) {
    if (!Array.isArray(obj.diagnostics)) {
      throw new TypeError("Property 'diagnostics' must be an array of strings");
    }
    if (obj.diagnostics.length > MAX_DIAGNOSTICS_ITEMS) {
      throw new RangeError(`Property 'diagnostics' item count (${obj.diagnostics.length}) exceeds limit of ${MAX_DIAGNOSTICS_ITEMS}`);
    }
    for (let i = 0; i < obj.diagnostics.length; i += 1) {
      const d = obj.diagnostics[i];
      if (typeof d !== "string") {
        throw new TypeError(`Property 'diagnostics[${i}]' must be a string`);
      }
      if (d.length > MAX_DIAGNOSTIC_CHARS) {
        throw new RangeError(`Diagnostic message in 'diagnostics[${i}]' length (${d.length}) exceeds limit of ${MAX_DIAGNOSTIC_CHARS}`);
      }
    }
  }

  return {
    status: normStatus,
    summary: obj.summary,
    verification: obj.verification,
    diagnostics: obj.diagnostics ? [...obj.diagnostics] : [],
    claimedChangedPaths: [...obj.claimedChangedPaths],
  };
}

/**
 * Parses raw JSON string or object, enforcing byte size limits and strict schema.
 */
export function parseTypedResult(rawInput) {
  if (typeof rawInput === "string") {
    const byteLength = Buffer.byteLength(rawInput, "utf8");
    if (byteLength > MAX_RESULT_BYTES) {
      throw new RangeError(`Typed result payload size (${byteLength} bytes) exceeds limit of ${MAX_RESULT_BYTES} bytes`);
    }
    let parsed;
    try {
      parsed = JSON.parse(rawInput);
    } catch (err) {
      throw new Error(`Failed to parse typed result as JSON: ${err.message}`);
    }
    return validateTypedResult(parsed);
  }

  if (typeof rawInput === "object" && rawInput !== null) {
    return validateTypedResult(rawInput);
  }

  throw new TypeError("Input to parseTypedResult must be a JSON string or object");
}

export function isValidTypedResult(input) {
  try {
    parseTypedResult(input);
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// Isolation Defaults & Matrix Validation
// ============================================================================

export function getDefaultIsolation({ mode = "accept-edits", isAsync = false, async = isAsync } = {}) {
  const effectiveAsync = Boolean(isAsync || async);
  if (!effectiveAsync && mode === "plan") {
    return ISOLATION_SHARED;
  }
  return ISOLATION_WORKTREE;
}

export function isUnsafeSharedIsolation({ mode = "accept-edits", isAsync = false, async = isAsync } = {}) {
  const effectiveAsync = Boolean(isAsync || async);
  return effectiveAsync || mode === "accept-edits";
}

/**
 * Resolves and validates isolation mode against execution mode and async flag.
 * Rejects explicit 'shared' isolation for mutating or async operations.
 */
export function resolveIsolation({
  mode = "accept-edits",
  isAsync = false,
  async = isAsync,
  isolation,
} = {}) {
  const effectiveAsync = Boolean(isAsync || async);

  if (!isolation) {
    return getDefaultIsolation({ mode, isAsync: effectiveAsync });
  }

  if (!VALID_ISOLATION_MODES.includes(isolation)) {
    throw new Error(`Invalid isolation mode: "${isolation}". Allowed values: ${VALID_ISOLATION_MODES.map((m) => `'${m}'`).join(", ")}`);
  }

  if (isolation === ISOLATION_SHARED) {
    if (effectiveAsync) {
      throw new Error("Unsafe isolation: explicit 'shared' isolation is rejected for asynchronous execution. Worktree isolation is required.");
    }
    if (mode === "accept-edits") {
      throw new Error("Unsafe isolation: explicit 'shared' isolation is rejected for mutating 'accept-edits' mode. Worktree isolation is required.");
    }
    return ISOLATION_SHARED;
  }

  return ISOLATION_WORKTREE;
}

// ============================================================================
// Exact Three-Line Callback Builder
// ============================================================================

function sanitizeSingleLine(value, fallback = "none") {
  const normalized = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized || fallback;
}

/**
 * Exact three-line callback builder showing untrusted worker, job, attempt,
 * execution, artifact, and parent=pending (never claims worker semantic verification).
 */
export function buildCallbackMessage({
  jobId,
  job = jobId,
  attempt = 1,
  executionId,
  execution = executionId,
  artifact,
  files,
  claimedChangedPaths = files,
  summary = "Task completed",
  verification = "not reported",
} = {}) {
  let filesText = "none";
  if (Array.isArray(claimedChangedPaths)) {
    filesText = claimedChangedPaths.length > 0 ? claimedChangedPaths.join("; ") : "none";
  } else if (claimedChangedPaths) {
    filesText = String(claimedChangedPaths);
  }

  const line1 = `### Files Changed: ${sanitizeSingleLine(filesText, "none")}`;

  const summaryText = sanitizeSingleLine(summary, "no summary reported");
  const line2 = `### Summary: [Untrusted worker report] job=${sanitizeSingleLine(job, "unknown")} attempt=${attempt} execution=${sanitizeSingleLine(execution, "unknown")} artifact=${sanitizeSingleLine(artifact, "none")}: ${summaryText}`;

  const verificationText = sanitizeSingleLine(verification, "none");
  const line3 = `### Verification: parent=pending; worker claims: ${verificationText}`;

  return [line1, line2, line3].join("\n");
}

export const buildCallback = buildCallbackMessage;