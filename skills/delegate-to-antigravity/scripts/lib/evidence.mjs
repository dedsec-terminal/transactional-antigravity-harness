import crypto from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  canonicalPath,
  GitValidationError,
  isPathWithinTargets,
  normalizeDeclaredTargets,
  runGit,
  verifyWorktreeOwnership,
} from "./git-worktree.mjs";

import { canonicalJsonStringify as deterministicJsonStringify } from "./storage.mjs";
export { deterministicJsonStringify };

export function hashManifest(manifest) {
  return crypto.createHash("sha256").update(deterministicJsonStringify(manifest)).digest("hex");
}

export function hashPatch(patchBuffer) {
  const buf = Buffer.isBuffer(patchBuffer) ? patchBuffer : Buffer.from(patchBuffer, "utf8");
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function parseNameStatusZ(stdout) {
  const tokens = stdout.split("\0").filter((t) => t.length > 0);
  const files = [];
  for (let i = 0; i < tokens.length; ) {
    const statusToken = tokens[i++];
    if (!statusToken) break;
    const status = statusToken[0];
    if (status === "R" || status === "C") {
      const oldPath = tokens[i++];
      const newPath = tokens[i++];
      files.push({
        status,
        oldPath,
        path: newPath,
        score: statusToken.slice(1),
      });
    } else {
      const filePath = tokens[i++];
      files.push({
        status,
        path: filePath,
        oldPath: null,
      });
    }
  }
  return files;
}

function parseDiffIndexZ(stdout) {
  const records = new Map();
  const tokens = stdout.split("\0").filter((t) => t.length > 0);
  for (let i = 0; i < tokens.length; ) {
    const meta = tokens[i++];
    if (!meta || !meta.startsWith(":")) break;
    // :<old-mode> <new-mode> <old-sha> <new-sha> <status>
    const parts = meta.slice(1).split(" ");
    const oldMode = parts[0];
    const newMode = parts[1];
    const oldSha = parts[2];
    const rest = parts[3].split("\t");
    const newSha = rest[0];
    const status = parts[4] || rest[1] || "";
    const filePath = tokens[i++];
    let newFilePath = null;
    if (status.startsWith("R") || status.startsWith("C")) {
      newFilePath = tokens[i++];
    }
    const recordKey = newFilePath || filePath;
    records.set(recordKey, {
      oldMode,
      newMode,
      oldSha,
      newSha,
      status: status[0],
      path: recordKey,
      oldPath: newFilePath ? filePath : null,
    });
  }
  return records;
}

function parseNumstatZ(stdout) {
  const numstats = new Map();
  const records = stdout.split("\0").filter((t) => t.length > 0);
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i];
    const fields = record.split("\t");
    if (fields.length < 3) continue;
    const [added, deleted, ...pathParts] = fields;
    const p = pathParts.join("\t");
    const isBinary = added === "-" && deleted === "-";
    const value = {
      isBinary,
      linesAdded: isBinary ? null : Number.parseInt(added, 10),
      linesDeleted: isBinary ? null : Number.parseInt(deleted, 10),
    };
    numstats.set(p, value);
    // With --numstat -z, rename/copy records carry old and new names as two
    // NUL-delimited tokens after the numeric tuple. Associate both names so
    // metadata remains available regardless of diff/name-status lookup key.
    if (i + 1 < records.length && !records[i + 1].includes("\t")) {
      numstats.set(records[i + 1], value);
      i += 1;
    }
  }
  return numstats;
}

export function detectDirtySubmodules(worktreePath) {
  const dirtySubmodules = [];

  // Check if any submodules exist
  const statusRes = runGit(["submodule", "status"], {
    cwd: worktreePath,
    allowFailure: true,
  });
  if (statusRes.status !== 0 || !statusRes.stdout.trim()) {
    return dirtySubmodules;
  }

  // Check submodules with foreach
  const foreachRes = runGit(
    ["submodule", "foreach", "--quiet", "--recursive", "git status --porcelain=v1"],
    {
      cwd: worktreePath,
      allowFailure: true,
    },
  );

  // Check porcelain status with ignore-submodules=none
  const porcelainRes = runGit(
    ["status", "--porcelain=v1", "--ignore-submodules=none", "-z"],
    {
      cwd: worktreePath,
      allowFailure: true,
    },
  );

  // Parse porcelain tokens
  const tokens = porcelainRes.stdout.split("\0").filter(Boolean);
  for (const token of tokens) {
    const statusPrefix = token.slice(0, 2);
    const itemPath = token.slice(3);
    // In git porcelain: ' M' or 'M ' or '??' on submodule or 'm' in flags
    if (statusPrefix.includes("m") || statusPrefix.includes("M") || statusPrefix.includes("?")) {
      // Check if itemPath is a submodule directory
      const isSubmoduleRes = runGit(["submodule", "status", "--", itemPath], {
        cwd: worktreePath,
        allowFailure: true,
      });
      if (isSubmoduleRes.status === 0 && isSubmoduleRes.stdout.trim()) {
        // Check if gitlink itself was changed in cached diff
        const cachedSubRes = runGit(["diff", "--cached", "--", itemPath], {
          cwd: worktreePath,
          allowFailure: true,
        });
        const gitlinkChanged = cachedSubRes.stdout.includes("Subproject commit");
        if (!gitlinkChanged) {
          dirtySubmodules.push({
            path: itemPath,
            issue: "dirty_content_without_gitlink",
            status: statusPrefix.trim(),
          });
        }
      }
    }
  }

  return dirtySubmodules;
}

export async function validateReconstruction({ baseSha, patch, repoPath }) {
  const tempIndexFile = path.join(
    os.tmpdir(),
    `agy-recon-idx-${Date.now()}-${crypto.randomBytes(8).toString("hex")}.tmp`,
  );

  try {
    // Populate temp index from base commit tree
    runGit(["read-tree", baseSha], {
      cwd: repoPath,
      env: { GIT_INDEX_FILE: tempIndexFile },
    });

    if (patch.length > 0) {
      // Validate patch applies cleanly to temp index
      runGit(["apply", "--cached", "--check"], {
        cwd: repoPath,
        env: { GIT_INDEX_FILE: tempIndexFile },
        input: patch,
      });

      // Actually apply into temporary index
      runGit(["apply", "--cached"], {
        cwd: repoPath,
        env: { GIT_INDEX_FILE: tempIndexFile },
        input: patch,
      });
    }

    const writeTreeRes = runGit(["write-tree"], {
      cwd: repoPath,
      env: { GIT_INDEX_FILE: tempIndexFile },
    });

    return {
      reconstructionValidated: true,
      reconstructedTreeSha: writeTreeRes.stdout.trim(),
    };
  } catch (err) {
    return {
      reconstructionValidated: false,
      reconstructionError: err.message,
    };
  } finally {
    await fsp.unlink(tempIndexFile).catch(() => {});
  }
}

export async function captureEvidence({ worktreePath, baseSha, declaredTargets, repoRoot }) {
  const canonicalWorktree = canonicalPath(worktreePath);

  // Safety preflight: verify worktree ownership marker and ensure it's not the canonical repo root
  const ownership = await verifyWorktreeOwnership(canonicalWorktree, { repoRoot });

  const effectiveRepoRoot = repoRoot ? canonicalPath(repoRoot) : ownership.repoRoot;
  if (canonicalWorktree.toLowerCase() === effectiveRepoRoot.toLowerCase()) {
    throw new GitValidationError(
      `Safety violation: evidence capture attempted on canonical repository root: ${canonicalWorktree}`,
      "CANONICAL_REPO_SAFETY_VIOLATION",
      { worktreePath: canonicalWorktree, repoRoot: effectiveRepoRoot },
    );
  }

  const effectiveBaseSha = baseSha || ownership.marker.baseSha;
  const normalizedTargets = normalizeDeclaredTargets(declaredTargets);

  // Stage all worktree changes ONLY in the disposable worktree
  runGit(["add", "-A"], { cwd: canonicalWorktree });

  // Generate external cached binary full-index patch
  const patchRes = runGit(["diff", "--cached", "--binary", "--full-index", "--no-color"], {
    cwd: canonicalWorktree,
    encoding: "buffer",
  });
  const patch = patchRes.stdout;
  const patchHash = hashPatch(patch);

  // Derive actual paths and metadata directly from Git
  const nameStatusRes = runGit(["diff", "--cached", "--name-status", "-z"], {
    cwd: canonicalWorktree,
    encoding: "utf8",
  });
  const rawFiles = parseNameStatusZ(nameStatusRes.stdout);

  const diffIndexRes = runGit(["diff-index", "--cached", "--full-index", effectiveBaseSha, "-z"], {
    cwd: canonicalWorktree,
    encoding: "utf8",
    allowFailure: true,
  });
  const indexRecords = diffIndexRes.status === 0 ? parseDiffIndexZ(diffIndexRes.stdout) : new Map();

  const numstatRes = runGit(["diff", "--cached", "--numstat", "-z"], {
    cwd: canonicalWorktree,
    encoding: "utf8",
    allowFailure: true,
  });
  const numstats = numstatRes.status === 0 ? parseNumstatZ(numstatRes.stdout) : new Map();

  const filesList = [];
  const outOfTargetFiles = [];

  for (const raw of rawFiles) {
    const idx = indexRecords.get(raw.path);
    const num = numstats.get(raw.path) || numstats.get(raw.oldPath);

    const fileEntry = {
      path: raw.path,
      oldPath: raw.oldPath || idx?.oldPath || null,
      status: raw.status,
      isBinary: Boolean(num?.isBinary),
      linesAdded: num?.linesAdded ?? null,
      linesDeleted: num?.linesDeleted ?? null,
      oldMode: idx?.oldMode || null,
      newMode: idx?.newMode || null,
      oldSha: idx?.oldSha || null,
      newSha: idx?.newSha || null,
    };

    filesList.push(fileEntry);

    // Validate path against declared targets
    const pathInTarget = isPathWithinTargets(raw.path, normalizedTargets);
    const oldPathInTarget = raw.oldPath ? isPathWithinTargets(raw.oldPath, normalizedTargets) : true;

    if (!pathInTarget || !oldPathInTarget) {
      outOfTargetFiles.push(raw.path);
      if (raw.oldPath && !oldPathInTarget && !outOfTargetFiles.includes(raw.oldPath)) {
        outOfTargetFiles.push(raw.oldPath);
      }
    }
  }

  // Sort files deterministically by path
  filesList.sort((a, b) => a.path.localeCompare(b.path));
  outOfTargetFiles.sort();

  // Detect dirty submodule content without changed gitlink
  const dirtySubmodules = detectDirtySubmodules(canonicalWorktree);

  // Mechanically validate reconstruction from base with temporary index
  const recon = await validateReconstruction({
    baseSha: effectiveBaseSha,
    patch,
    repoPath: canonicalWorktree,
  });

  if (!recon.reconstructionValidated) {
    throw new GitValidationError(
      `Mechanical reconstruction from base ${effectiveBaseSha} failed: ${recon.reconstructionError}`,
      "RECONSTRUCTION_FAILED",
      { baseSha: effectiveBaseSha, error: recon.reconstructionError },
    );
  }

  const manifest = {
    version: 1,
    baseSha: effectiveBaseSha,
    patchHash,
    patchBytes: patch.length,
    declaredTargets: normalizedTargets,
    files: filesList,
    outOfTargetFiles,
    hasOutOfTarget: outOfTargetFiles.length > 0,
    dirtySubmodules,
    hasSubmoduleIssues: dirtySubmodules.length > 0,
    reconstructedTreeSha: recon.reconstructedTreeSha,
    stats: {
      total: filesList.length,
      added: filesList.filter((f) => f.status === "A").length,
      modified: filesList.filter((f) => f.status === "M").length,
      deleted: filesList.filter((f) => f.status === "D").length,
      renamed: filesList.filter((f) => f.status === "R").length,
      binary: filesList.filter((f) => f.isBinary).length,
    },
    createdAt: new Date().toISOString(),
  };

  const manifestString = deterministicJsonStringify(manifest);
  const manifestHash = hashManifest(manifest);

  return {
    patch,
    patchHash,
    patchBytes: patch.length,
    manifest,
    manifestHash,
    manifestString,
    reconstructionValidated: recon.reconstructionValidated,
    reconstructedTreeSha: recon.reconstructedTreeSha,
  };
}
