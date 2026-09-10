import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import fsp from "node:fs/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

export class GitError extends Error {
  constructor(message, { status = null, stdout = "", stderr = "", command = "" } = {}) {
    super(message);
    this.name = "GitError";
    this.status = status;
    this.stdout = stdout;
    this.stderr = stderr;
    this.command = command;
  }
}

export class GitValidationError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = "GitValidationError";
    this.code = code;
    this.details = details;
  }
}

export function canonicalPath(targetPath) {
  try {
    return fs.realpathSync.native(path.resolve(targetPath));
  } catch {
    return path.resolve(targetPath);
  }
}

export function runGit(args, options = {}) {
  const gitArgs = ["-c", "core.longpaths=true", ...args];
  const env = {
    ...process.env,
    ...options.env,
  };
  const result = spawnSync("git", gitArgs, {
    cwd: options.cwd,
    env,
    input: options.input,
    maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
    encoding: options.encoding ?? "utf8",
    windowsHide: true,
    stdio: options.stdio ?? ["pipe", "pipe", "pipe"],
  });

  if (result.error) {
    throw new GitError(`Failed to spawn git: ${result.error.message}`, {
      command: gitArgs.join(" "),
    });
  }

  const stdoutStr = typeof result.stdout === "string" ? result.stdout : result.stdout?.toString("utf8") ?? "";
  const stderrStr = typeof result.stderr === "string" ? result.stderr : result.stderr?.toString("utf8") ?? "";

  if (!options.allowFailure && result.status !== 0) {
    const errorMsg = (stderrStr.trim() || stdoutStr.trim() || `git exited with status ${result.status}`).slice(0, 1000);
    const err = new GitError(`git ${args[0]} failed (exit code ${result.status}): ${errorMsg}`, {
      status: result.status,
      stdout: stdoutStr,
      stderr: stderrStr,
      command: gitArgs.join(" "),
    });
    throw err;
  }

  return result;
}

export function getWorkspaceIdentity(repoRoot, commonDir) {
  const cRepo = canonicalPath(repoRoot);
  const cCommon = canonicalPath(commonDir);
  const hash = crypto.createHash("sha256").update(`${cRepo}\n${cCommon}`).digest("hex");
  return {
    id: hash,
    repoRoot: cRepo,
    commonDir: cCommon,
  };
}

export function validateRepository(workspacePath, options = {}) {
  const canonicalWorkspace = canonicalPath(workspacePath);

  const bareCheck = runGit(["rev-parse", "--is-bare-repository"], {
    cwd: canonicalWorkspace,
    allowFailure: true,
  });
  if (bareCheck.status === 0 && bareCheck.stdout.trim() === "true") {
    throw new GitValidationError(`Bare repository is not supported: ${canonicalWorkspace}`, "BARE_REPOSITORY", {
      repoRoot: canonicalWorkspace,
    });
  }

  let toplevelRes;
  try {
    toplevelRes = runGit(["rev-parse", "--show-toplevel"], {
      cwd: canonicalWorkspace,
      allowFailure: true,
    });
  } catch (err) {
    throw new GitValidationError(`Not a git repository: ${canonicalWorkspace}`, "NOT_A_GIT_REPOSITORY", {
      workspacePath: canonicalWorkspace,
      cause: err.message,
    });
  }

  if (toplevelRes.status !== 0 || !toplevelRes.stdout.trim()) {
    throw new GitValidationError(`Not a git repository: ${canonicalWorkspace}`, "NOT_A_GIT_REPOSITORY", {
      workspacePath: canonicalWorkspace,
      stderr: toplevelRes.stderr,
    });
  }

  const repoRoot = canonicalPath(toplevelRes.stdout.trim());

  const bareRes = runGit(["rev-parse", "--is-bare-repository"], {
    cwd: repoRoot,
    allowFailure: true,
  });
  if (bareRes.status !== 0 || bareRes.stdout.trim() === "true") {
    throw new GitValidationError(`Bare repository is not supported: ${repoRoot}`, "BARE_REPOSITORY", {
      repoRoot,
    });
  }

  const headRes = runGit(["rev-parse", "--verify", "HEAD"], {
    cwd: repoRoot,
    allowFailure: true,
  });
  if (headRes.status !== 0 || !headRes.stdout.trim()) {
    throw new GitValidationError(`Repository has unborn HEAD (no commits): ${repoRoot}`, "UNBORN_HEAD", {
      repoRoot,
    });
  }
  const headSha = headRes.stdout.trim();

  const commonDirRes = runGit(["rev-parse", "--git-common-dir"], {
    cwd: repoRoot,
    allowFailure: true,
  });
  if (commonDirRes.status !== 0 || !commonDirRes.stdout.trim()) {
    throw new GitValidationError(`Unable to determine git common dir: ${repoRoot}`, "INVALID_COMMON_DIR", {
      repoRoot,
    });
  }
  const commonDir = canonicalPath(path.resolve(repoRoot, commonDirRes.stdout.trim()));

  const gitDirRes = runGit(["rev-parse", "--git-dir"], {
    cwd: repoRoot,
    allowFailure: true,
  });
  const gitDir = canonicalPath(path.resolve(repoRoot, gitDirRes.stdout.trim()));

  const statusRes = runGit(["status", "--porcelain=v1", "--untracked-files=all"], {
    cwd: repoRoot,
    allowFailure: true,
  });
  const isClean = statusRes.stdout.trim().length === 0;

  if (options.requireClean && !isClean) {
    throw new GitValidationError(`Repository is dirty (uncommitted changes present): ${repoRoot}`, "DIRTY_REPOSITORY", {
      repoRoot,
      status: statusRes.stdout,
    });
  }

  const identity = getWorkspaceIdentity(repoRoot, commonDir);
  if (options.expectedIdentity) {
    let expectedId;
    if (typeof options.expectedIdentity === "string") {
      expectedId = options.expectedIdentity;
    } else if (options.expectedIdentity?.id) {
      expectedId = options.expectedIdentity.id;
    } else if (options.expectedIdentity?.repoRoot) {
      expectedId = getWorkspaceIdentity(options.expectedIdentity.repoRoot, options.expectedIdentity.commonDir ?? commonDir).id;
    }

    if (expectedId && identity.id !== expectedId) {
      throw new GitValidationError(`Workspace identity mismatch. Expected ${expectedId}, got ${identity.id}`, "IDENTITY_MISMATCH", {
        actualIdentity: identity,
        expectedIdentity: options.expectedIdentity,
      });
    }
  }

  return {
    repoRoot,
    commonDir,
    gitDir,
    headSha,
    isBare: false,
    isClean,
    identity,
  };
}

export function normalizeDeclaredTargets(targets) {
  if (!Array.isArray(targets) || targets.length === 0) {
    throw new GitValidationError("Declared targets must be a non-empty array", "INVALID_TARGETS");
  }

  const normalizedList = [];

  for (const raw of targets) {
    if (typeof raw !== "string" || !raw.trim()) {
      throw new GitValidationError(`Declared target must be a non-empty string: ${String(raw)}`, "MALFORMED_TARGET");
    }

    if (raw.includes("\\")) {
      throw new GitValidationError(
        `Declared target contains backslash; use forward slash for workspace-relative target: '${raw}'`,
        "BACKSLASH_AMBIGUITY",
        { target: raw },
      );
    }

    if (raw.includes("\0")) {
      throw new GitValidationError(`Declared target contains null character: '${raw}'`, "MALFORMED_TARGET", {
        target: raw,
      });
    }

    if (raw.startsWith("/") || /^[a-zA-Z]:/.test(raw) || raw.startsWith("//") || raw.startsWith("\\\\")) {
      throw new GitValidationError(
        `Declared target must be workspace-relative; absolute paths rejected: '${raw}'`,
        "ABSOLUTE_TARGET",
        { target: raw },
      );
    }

    const segments = raw.split("/");
    for (let i = 0; i < segments.length; i += 1) {
      const seg = segments[i];
      if (seg === "." || seg === "..") {
        throw new GitValidationError(
          `Declared target must not contain '.' or '..' segments: '${raw}'`,
          "DOT_DOT_ESCAPE",
          { target: raw },
        );
      }
      if (seg === "" && i < segments.length - 1) {
        throw new GitValidationError(
          `Declared target contains empty segment or duplicate slash: '${raw}'`,
          "MALFORMED_TARGET",
          { target: raw },
        );
      }
    }

    // A trailing slash is the only unambiguous directory declaration.  The
    // legacy extension heuristic is retained for callers that do not provide
    // a base tree, but capture callers resolve intent from the base tree.
    const isPrefix = raw.endsWith("/") || (!path.extname(raw) && !raw.endsWith("."));
    const cleaned = raw.replace(/\/+$/, "");
    if (!cleaned) {
      throw new GitValidationError(`Declared target resolves to empty root path: '${raw}'`, "MALFORMED_TARGET", {
        target: raw,
      });
    }

    normalizedList.push({
      original: raw,
      cleaned,
      isPrefix,
    });
  }

  // Check for duplicate and prefix overlap within declared targets
  for (let i = 0; i < normalizedList.length; i += 1) {
    for (let j = i + 1; j < normalizedList.length; j += 1) {
      const a = normalizedList[i].cleaned;
      const b = normalizedList[j].cleaned;

      if (a === b) {
        throw new GitValidationError(`Declared targets contain duplicate entry: '${a}'`, "UNAUTHORIZED_OVERLAP", {
          targetA: normalizedList[i].original,
          targetB: normalizedList[j].original,
        });
      }

      if (b.startsWith(`${a}/`)) {
        throw new GitValidationError(
          `Declared target '${normalizedList[j].original}' is covered by broader target '${normalizedList[i].original}'`,
          "UNAUTHORIZED_OVERLAP",
          {
            parent: normalizedList[i].original,
            child: normalizedList[j].original,
          },
        );
      }

      if (a.startsWith(`${b}/`)) {
        throw new GitValidationError(
          `Declared target '${normalizedList[i].original}' is covered by broader target '${normalizedList[j].original}'`,
          "UNAUTHORIZED_OVERLAP",
          {
            parent: normalizedList[j].original,
            child: normalizedList[i].original,
          },
        );
      }
    }
  }

  const result = normalizedList.map((entry) => entry.cleaned);
  Object.defineProperty(result, "__prefixes", {
    value: new Set(normalizedList.filter((e) => e.isPrefix).map((e) => e.cleaned)),
    enumerable: false,
  });
  return result;
}

export function isPathWithinTargets(relPath, normalizedTargets) {
  if (!relPath || typeof relPath !== "string") return false;
  const normalizedPath = relPath.replace(/\\/g, "/").replace(/^\/+/, "");

  for (const target of normalizedTargets) {
    const prefix = normalizedTargets.__prefixes?.has(target);
    if (normalizedPath === target) return true;
    if (prefix && normalizedPath.startsWith(`${target}/`)) return true;
  }
  return false;
}

export function checkTargetsOverlap(targetsA, targetsB) {
  const normA = normalizeDeclaredTargets(targetsA);
  const normB = normalizeDeclaredTargets(targetsB);

  for (const a of normA) {
    for (const b of normB) {
      const prefixA = normA.__prefixes?.has(a);
      const prefixB = normB.__prefixes?.has(b);
      if (a === b || (prefixA && b.startsWith(`${a}/`)) || (prefixB && a.startsWith(`${b}/`))) {
        return {
          overlap: true,
          targetA: a,
          targetB: b,
        };
      }
    }
  }
  return { overlap: false };
}

export async function acquireCommonDirLock(commonDir, options = {}) {
  const lockPath = path.join(commonDir, "agy-worktree.lock");
  const timeoutMs = options.timeoutMs ?? 15_000;
  const retryIntervalMs = options.retryIntervalMs ?? 50;
  const staleAgeMs = options.staleAgeMs ?? 30_000;
  const token = crypto.randomBytes(16).toString("hex");
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    try {
      const handle = await fsp.open(lockPath, "wx");
      const payload = JSON.stringify({
        pid: process.pid,
        createdAt: Date.now(),
        hostname: os.hostname(),
        token,
      });
      await handle.writeFile(payload, "utf8");
      return {
        lockPath,
        handle,
        release: async () => {
          try {
            await handle.close();
          } catch {}
          try {
            const current = JSON.parse(await fsp.readFile(lockPath, "utf8"));
            if (current.token === token) await fsp.unlink(lockPath);
          } catch { /* Preserve locks whose ownership cannot be verified. */ }
        },
      };
    } catch (err) {
      if (err.code === "EEXIST") {
        try {
          const content = await fsp.readFile(lockPath, "utf8");
          const data = JSON.parse(content);
          let isAlive = false;
          if (data.pid) {
            try {
              process.kill(data.pid, 0);
              isAlive = true;
            } catch {
              isAlive = false;
            }
          }
          // Never age-steal a live process' lock.  For dead owners, unlink
          // only if the token read is still the token we inspected.
          if (!isAlive) {
            const latest = await fsp.readFile(lockPath, "utf8").catch(() => "");
            let latestData;
            try { latestData = JSON.parse(latest); } catch { latestData = null; }
            if (latestData?.token === data.token) await fsp.unlink(lockPath).catch(() => {});
            continue;
          }
        } catch {
          // Retry on concurrent read/write
        }
        await new Promise((resolve) => setTimeout(resolve, retryIntervalMs));
        continue;
      }
      throw err;
    }
  }

  throw new Error(`Timeout acquiring common-dir lock at ${lockPath} after ${timeoutMs}ms`);
}

export async function withCommonDirLock(commonDir, fn, options = {}) {
  const lock = await acquireCommonDirLock(commonDir, options);
  try {
    return await fn();
  } finally {
    await lock.release();
  }
}

export function listWorktrees(repoRoot) {
  const res = runGit(["worktree", "list", "--porcelain"], {
    cwd: repoRoot,
    allowFailure: true,
  });
  if (res.status !== 0) return [];

  const trees = [];
  const entries = res.stdout.split(/\r?\n\r?\n/);
  for (const entry of entries) {
    if (!entry.trim()) continue;
    const lines = entry.split(/\r?\n/);
    const tree = {};
    for (const line of lines) {
      if (line.startsWith("worktree ")) {
        tree.worktree = canonicalPath(line.slice("worktree ".length).trim());
      } else if (line.startsWith("HEAD ")) {
        tree.head = line.slice("HEAD ".length).trim();
      } else if (line.startsWith("branch ")) {
        tree.branch = line.slice("branch ".length).trim();
      } else if (line.trim() === "detached") {
        tree.detached = true;
      }
    }
    if (tree.worktree) {
      trees.push(tree);
    }
  }
  return trees;
}

/**
 * Creates a git worktree for isolated execution, optionally using Git cone sparse checkout.
 *
 * Sparse checkout notes:
 * - Git cone sparse checkout includes ancestor files and siblings in selected directories,
 *   not exact-file isolation.
 * - Directory paths select the directory.
 * - Tracked file paths select their parent directory.
 * - Root files imply root-only selection (Git cone mode naturally includes all root files).
 * - Glob metacharacters (*, ?, [, ], {, }) are rejected for checkoutPaths; literal paths only.
 * - When checkoutPaths is omitted, standard full checkout behavior is preserved.
 *
 * @param {Object} options
 * @param {string} options.repoRoot - Path to repository root.
 * @param {string} options.worktreePath - Target path for new worktree.
 * @param {string} [options.baseSha] - Base commit SHA (defaults to repo HEAD).
 * @param {string} [options.callerId] - Identifier of calling process or job.
 * @param {string[]} [options.checkoutPaths] - Optional array of repo-relative paths for sparse checkout.
 * @returns {Promise<{ worktreePath: string, baseSha: string, repoRoot: string, commonDir: string, marker: Object }>}
 */
export async function createWorktree({ repoRoot, worktreePath, baseSha, callerId, checkoutPaths, gitRunner = runGit }) {
  const repoInfo = validateRepository(repoRoot);
  const targetBase = baseSha || repoInfo.headSha;

  let selectedConeDirs = null;
  if (checkoutPaths !== undefined) {
    for (const raw of (Array.isArray(checkoutPaths) ? checkoutPaths : [])) {
      if (typeof raw === "string" && /[*?[\]{}]/.test(raw)) {
        throw new GitValidationError(
          `checkoutPaths must be literal paths; glob metacharacters are rejected: '${raw}'`,
          "GLOB_NOT_SUPPORTED",
          { target: raw },
        );
      }
    }

    const normalizedTargets = normalizeDeclaredTargets(checkoutPaths);

    const dirSet = new Set();
    for (const target of normalizedTargets) {
      const catRes = runGit(["cat-file", "-t", `${targetBase}:${target}`], {
        cwd: repoInfo.repoRoot,
        allowFailure: true,
      });
      const objType = catRes.status === 0 ? catRes.stdout.trim() : null;

      if (objType === "tree") {
        // Directory path selects directory
        dirSet.add(target);
      } else if (objType === "blob") {
        // Tracked file path selects parent directory; root files imply root-only selection
        const parentDir = path.posix.dirname(target);
        if (parentDir !== "." && parentDir !== "") {
          dirSet.add(parentDir);
        }
      } else {
        throw new GitValidationError(
          `checkoutPath not found at base commit ${targetBase}: '${target}' (caller must select an existing parent directory for new files)`,
          "PATH_NOT_FOUND",
          { target, baseSha: targetBase },
        );
      }
    }

    selectedConeDirs = Array.from(dirSet);
  }

  const resolvedWorktree = path.resolve(worktreePath);
  if (canonicalPath(resolvedWorktree).toLowerCase() === repoInfo.repoRoot.toLowerCase()) {
    throw new GitValidationError(
      `Safety violation: cannot create worktree at canonical repository root: ${resolvedWorktree}`,
      "CANONICAL_REPO_SAFETY_VIOLATION",
      { path: resolvedWorktree, repoRoot: repoInfo.repoRoot },
    );
  }

  await fsp.mkdir(path.dirname(resolvedWorktree), { recursive: true });

  let canonicalWorktree;
  let marker;

  await withCommonDirLock(repoInfo.commonDir, async () => {
    let treeCreated = false;
    try {
      if (selectedConeDirs !== null) {
        gitRunner(["worktree", "add", "--no-checkout", "--detach", resolvedWorktree, targetBase], {
          cwd: repoInfo.repoRoot,
        });
        treeCreated = true;
        gitRunner(["sparse-checkout", "set", "--cone", "--", ...selectedConeDirs], {
          cwd: resolvedWorktree,
        });
        gitRunner(["checkout"], {
          cwd: resolvedWorktree,
        });
      } else {
        gitRunner(["worktree", "add", "--detach", resolvedWorktree, targetBase], {
          cwd: repoInfo.repoRoot,
        });
        treeCreated = true;
      }

      canonicalWorktree = canonicalPath(resolvedWorktree);

      marker = {
        version: 1,
        harness: "antigravity-delegation-harness",
        createdAt: new Date().toISOString(),
        pid: process.pid,
        repoRoot: repoInfo.repoRoot,
        commonDir: repoInfo.commonDir,
        worktreePath: canonicalWorktree,
        baseSha: targetBase,
        callerId: callerId ?? null,
      };

      // Store ownership evidence in this worktree's dedicated Git admin directory.
      // A checkout marker becomes worker output; common info/exclude is shared state.
      const gitDirRes = gitRunner(["rev-parse", "--git-dir"], { cwd: resolvedWorktree });
      const worktreeGitDir = canonicalPath(path.resolve(resolvedWorktree, gitDirRes.stdout.trim()));
      const markerFile = path.join(worktreeGitDir, "agy-worktree.json");
      await fsp.writeFile(markerFile, JSON.stringify(marker, null, 2), "utf8");
    } catch (err) {
      if (treeCreated) {
        const canonicalTarget = canonicalPath(resolvedWorktree);
        const canonicalRepo = canonicalPath(repoInfo.repoRoot);
        if (canonicalTarget.toLowerCase() !== canonicalRepo.toLowerCase()) {
          runGit(["worktree", "remove", "--force", resolvedWorktree], {
            cwd: repoInfo.repoRoot,
            allowFailure: true,
          });
          await fsp.rm(resolvedWorktree, { recursive: true, force: true }).catch(() => {});
          runGit(["worktree", "prune"], {
            cwd: repoInfo.repoRoot,
            allowFailure: true,
          });
        }
      }
      throw err;
    }
  });

  return {
    worktreePath: canonicalWorktree,
    baseSha: targetBase,
    repoRoot: repoInfo.repoRoot,
    commonDir: repoInfo.commonDir,
    marker,
  };
}

export async function verifyWorktreeOwnership(worktreePath, options = {}) {
  const resolved = path.resolve(worktreePath);

  let lstat;
  try {
    lstat = await fsp.lstat(resolved);
  } catch (err) {
    throw new GitValidationError(`Worktree path is not accessible: ${resolved}`, "WORKTREE_NOT_FOUND", {
      path: resolved,
      cause: err.message,
    });
  }

  if (lstat.isSymbolicLink()) {
    throw new GitValidationError(
      `Worktree path is a symbolic link escape: ${resolved}`,
      "UNSAFE_WORKTREE_PATH",
      { path: resolved },
    );
  }

  const canonicalTarget = canonicalPath(resolved);

  const repoRoot = options.repoRoot ? canonicalPath(options.repoRoot) : null;
  if (repoRoot && canonicalTarget.toLowerCase() === repoRoot.toLowerCase()) {
    throw new GitValidationError(
      `Safety violation: cannot finalize canonical repository root as worktree: ${resolved}`,
      "CANONICAL_REPO_SAFETY_VIOLATION",
      { path: resolved, repoRoot },
    );
  }

  const gitDirRes = runGit(["rev-parse", "--git-dir"], { cwd: resolved, allowFailure: true });
  if (gitDirRes.status !== 0 || !gitDirRes.stdout.trim()) {
    throw new GitValidationError(`Worktree has no readable Git administrative directory: ${resolved}`, "UNVERIFIED_WORKTREE");
  }
  const gitDir = canonicalPath(path.resolve(resolved, gitDirRes.stdout.trim()));
  const markerFile = path.join(gitDir, "agy-worktree.json");
  let marker;
  try {
    const content = await fsp.readFile(markerFile, "utf8");
    marker = JSON.parse(content);
  } catch (err) {
    throw new GitValidationError(
      `Not a verified harness-owned worktree (missing/invalid ownership marker): ${resolved}`,
      "UNVERIFIED_WORKTREE",
      { path: resolved, cause: err.message },
    );
  }

  if (marker.harness !== "antigravity-delegation-harness") {
    throw new GitValidationError(
      `Ownership marker invalid harness identifier: ${marker.harness}`,
      "UNVERIFIED_WORKTREE",
      { marker },
    );
  }

  if (repoRoot && canonicalPath(marker.repoRoot).toLowerCase() !== repoRoot.toLowerCase()) {
    throw new GitValidationError(
      `Ownership marker repoRoot mismatch. Expected ${repoRoot}, got ${marker.repoRoot}`,
      "UNVERIFIED_WORKTREE",
      { marker, expectedRepoRoot: repoRoot },
    );
  }

  const registeredTrees = listWorktrees(marker.repoRoot);
  const isRegistered = registeredTrees.some(
    (t) => t.worktree.toLowerCase() === canonicalTarget.toLowerCase(),
  );
  if (!isRegistered) {
    throw new GitValidationError(
      `Worktree is not registered in repository: ${resolved}`,
      "UNREGISTERED_WORKTREE",
      { path: resolved, registeredTrees },
    );
  }

  return {
    canonicalPath: canonicalTarget,
    marker,
    repoRoot: marker.repoRoot,
    commonDir: marker.commonDir,
  };
}

export async function finalizeWorktree(worktreePath, options = {}) {
  const verified = await verifyWorktreeOwnership(worktreePath, options);
  const commonDir = verified.commonDir;
  const repoRoot = verified.repoRoot;
  const targetPath = verified.canonicalPath;
  const removeRunner = options.removeRunner || ((args, runOptions) => runGit(args, runOptions));

  try {
    await withCommonDirLock(commonDir, async () => {
      const removeRes = await removeRunner(["worktree", "remove", "--force", targetPath], {
        cwd: repoRoot,
        allowFailure: true,
      });

      if (removeRes.status !== 0) {
        const stderr = removeRes.stderr || removeRes.stdout;
        if (/EBUSY|EPERM|used by another process|Permission denied|locked/i.test(stderr)) {
          const err = new Error(`Worktree directory locked by open handle: ${stderr}`);
          err.code = "EBUSY";
          throw err;
        }
        throw new Error(`git worktree remove failed: ${stderr}`);
      }

      const registered = listWorktrees(repoRoot).some((t) => t.worktree.toLowerCase() === targetPath.toLowerCase());
      if (registered) throw new Error("git worktree remove reported success but worktree remains registered");

      await fsp.rm(targetPath, { recursive: true, force: true }).catch((err) => {
        if (err.code === "EBUSY" || err.code === "EPERM") {
          throw err;
        }
      });

      runGit(["worktree", "prune"], {
        cwd: repoRoot,
        allowFailure: true,
      });
    });

    return {
      status: "removed",
      worktreePath: targetPath,
    };
  } catch (err) {
    if (
      err.code === "EBUSY" ||
      err.code === "EPERM" ||
      /EBUSY|EPERM|used by another process|Permission denied/i.test(err.message)
    ) {
      return {
        status: "pending_prune",
        worktreePath: targetPath,
        error: err.message,
      };
    }
    throw err;
  }
}
