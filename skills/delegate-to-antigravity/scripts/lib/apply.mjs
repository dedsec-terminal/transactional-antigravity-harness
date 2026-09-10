import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import {
  canonicalPath,
  GitValidationError,
  runGit,
  validateRepository,
} from "./git-worktree.mjs";
import { hashManifest, hashPatch } from "./evidence.mjs";

export async function hashTouchedPreimages(targetRepoPath, touchedPaths) {
  const cTarget = canonicalPath(targetRepoPath);
  const preimages = {};

  for (const relPath of touchedPaths) {
    const fullPath = path.join(cTarget, relPath);
    try {
      const content = await fsp.readFile(fullPath);
      preimages[relPath] = crypto.createHash("sha256").update(content).digest("hex");
    } catch (err) {
      if (err.code === "ENOENT") {
        preimages[relPath] = null;
      } else {
        throw err;
      }
    }
  }

  return preimages;
}

function canonicalIndexFingerprint(cwd) {
  const res = runGit(["diff", "--cached", "--binary", "--full-index", "--no-color"], {
    cwd,
    encoding: "buffer",
    allowFailure: true,
  });
  if (res.status !== 0) return `error:${res.status}:${res.stderr || ""}`;
  return crypto.createHash("sha256").update(res.stdout).digest("hex");
}

export function detectConflicts(targetRepoPath, manifest) {
  const cTarget = canonicalPath(targetRepoPath);
  const conflicts = [];

  const touchedPaths = new Set();
  for (const f of manifest.files || []) {
    if (f.path) touchedPaths.add(f.path);
    if (f.oldPath) touchedPaths.add(f.oldPath);
  }

  // 1. Check staged changes on touched paths
  const stagedRes = runGit(["diff", "--cached", "--name-only", "-z"], {
    cwd: cTarget,
    encoding: "utf8",
    allowFailure: true,
  });
  if (stagedRes.status === 0) {
    const staged = stagedRes.stdout.split("\0").filter(Boolean);
    for (const p of staged) {
      if (touchedPaths.has(p)) {
        conflicts.push({
          path: p,
          type: "staged_conflict",
          reason: "Touched path has staged changes in canonical index",
        });
      }
    }
  }

  // 2. Check unstaged modifications on touched paths
  const unstagedRes = runGit(["diff", "--name-only", "-z"], {
    cwd: cTarget,
    encoding: "utf8",
    allowFailure: true,
  });
  if (unstagedRes.status === 0) {
    const unstaged = unstagedRes.stdout.split("\0").filter(Boolean);
    for (const p of unstaged) {
      if (touchedPaths.has(p)) {
        conflicts.push({
          path: p,
          type: "unstaged_conflict",
          reason: "Touched path has unstaged modifications in working tree",
        });
      }
    }
  }

  // 3. Check untracked files on touched paths
  const untrackedRes = runGit(["ls-files", "--others", "--exclude-standard", "-z"], {
    cwd: cTarget,
    encoding: "utf8",
    allowFailure: true,
  });
  if (untrackedRes.status === 0) {
    const untracked = untrackedRes.stdout.split("\0").filter(Boolean);
    for (const p of untracked) {
      if (touchedPaths.has(p)) {
        conflicts.push({
          path: p,
          type: "untracked_conflict",
          reason: "Untracked file exists at touched path",
        });
      }
    }
  }

  // 4. Check delete-recreate, path-type, and preimage content conflicts
  for (const file of manifest.files || []) {
    const fullPath = path.join(cTarget, file.path);
    let diskStat = null;
    try {
      diskStat = fs.lstatSync(fullPath);
    } catch {}

    if (file.status === "A") {
      if (diskStat) {
        conflicts.push({
          path: file.path,
          type: "already_exists_conflict",
          reason: "File to be added already exists on disk",
        });
      }
    } else if (file.status === "D") {
      if (!diskStat) {
        conflicts.push({
          path: file.path,
          type: "delete_recreate_conflict",
          reason: "File to be deleted does not exist on disk",
        });
      } else if (diskStat.isDirectory()) {
        conflicts.push({
          path: file.path,
          type: "path_type_conflict",
          reason: "Path type mismatch: expected file for deletion, found directory",
        });
      }
    } else if (file.status === "M") {
      if (!diskStat) {
        conflicts.push({
          path: file.path,
          type: "missing_preimage",
          reason: "File to be modified does not exist on disk",
        });
      } else if (diskStat.isDirectory()) {
        conflicts.push({
          path: file.path,
          type: "path_type_conflict",
          reason: "Path type mismatch: expected regular file, found directory",
        });
      } else {
        // Compare Git-normalized content with the base blob. Raw worktree bytes
        // can legitimately differ (for example CRLF checkout vs LF blob).
        const baseBlobOid = runGit(["rev-parse", `${manifest.baseSha}:${file.path}`], {
          cwd: cTarget,
          allowFailure: true,
        });
        if (baseBlobOid.status === 0) {
          try {
            const diskBlobOid = runGit(["hash-object", `--path=${file.path}`, "--", fullPath], {
              cwd: cTarget,
              allowFailure: true,
            });
            if (diskBlobOid.status !== 0) throw new Error(diskBlobOid.stderr || "git hash-object failed");
            if (diskBlobOid.stdout.trim() !== baseBlobOid.stdout.trim()) {
              conflicts.push({
                path: file.path,
                type: "preimage_mismatch",
                reason: "File content on disk differs from base commit preimage",
              });
            }
          } catch {
            conflicts.push({
              path: file.path,
              type: "preimage_unreadable",
              reason: "File on disk could not be read for preimage comparison",
            });
          }
        }
      }
    } else if (file.status === "R") {
      if (diskStat) {
        conflicts.push({
          path: file.path,
          type: "already_exists_conflict",
          reason: "Rename target already exists on disk",
        });
      }
      if (file.oldPath) {
        const oldFullPath = path.join(cTarget, file.oldPath);
        if (!fs.existsSync(oldFullPath)) {
          conflicts.push({
            path: file.oldPath,
            type: "missing_preimage",
            reason: "Rename source file does not exist on disk",
          });
        }
      }
    }
  }

  return conflicts;
}

export async function applyPatch({
  targetRepoPath,
  patch,
  manifest,
  manifestHash,
  expectedBaseSha,
  options = {},
}) {
  const repoInfo = validateRepository(targetRepoPath, { requireClean: false });
  const cTarget = repoInfo.repoRoot;

  // Validate the caller-supplied manifest before using any of its mutable
  // fields (especially baseSha) for subsequent checks.
  if (typeof manifestHash !== "string" || !/^[a-f0-9]{64}$/.test(manifestHash)) {
    return { success: false, applied: false, blocked: true, reasons: ["MANIFEST_HASH_REQUIRED"], conflicts: [] };
  }
  {
    const computedManifestHash = hashManifest(manifest);
    if (computedManifestHash !== manifestHash) {
      return {
        success: false,
        applied: false,
        blocked: true,
        reasons: ["MANIFEST_HASH_MISMATCH"],
        details: { expected: manifestHash, actual: computedManifestHash },
        conflicts: [],
      };
    }
  }

  // 1. Verify base SHA
  const requiredBase = expectedBaseSha || manifest.baseSha;
  if (repoInfo.headSha !== requiredBase) {
    return {
      success: false,
      applied: false,
      blocked: true,
      reasons: ["BASE_SHA_MISMATCH"],
      details: {
        expected: requiredBase,
        actual: repoInfo.headSha,
      },
      conflicts: [],
    };
  }

  // 2. Verify patch hash
  const computedPatchHash = hashPatch(patch);
  if (computedPatchHash !== manifest.patchHash) {
    return {
      success: false,
      applied: false,
      blocked: true,
      reasons: ["PATCH_HASH_MISMATCH"],
      details: {
        expected: manifest.patchHash,
        actual: computedPatchHash,
      },
      conflicts: [],
    };
  }

  // 3. Verify no out-of-target changes in manifest
  if (manifest.hasOutOfTarget || (manifest.outOfTargetFiles && manifest.outOfTargetFiles.length > 0)) {
    return {
      success: false,
      applied: false,
      blocked: true,
      reasons: ["OUT_OF_TARGET_CHANGES"],
      details: {
        outOfTargetFiles: manifest.outOfTargetFiles,
      },
      conflicts: [],
    };
  }

  // 5. Verify no dirty submodule issues
  if (manifest.hasSubmoduleIssues || (manifest.dirtySubmodules && manifest.dirtySubmodules.length > 0)) {
    return {
      success: false,
      applied: false,
      blocked: true,
      reasons: ["DIRTY_SUBMODULE_CONTENT"],
      details: {
        dirtySubmodules: manifest.dirtySubmodules,
      },
      conflicts: [],
    };
  }

  // 6. Detect conflicts on touched paths
  const conflicts = detectConflicts(cTarget, manifest);
  if (conflicts.length > 0) {
    return {
      success: false,
      applied: false,
      blocked: true,
      reasons: ["TOUCHED_PATH_CONFLICT"],
      conflicts,
    };
  }

  // 7. Collect touched paths and hash touched preimages immediately before mutation
  const touchedPaths = new Set();
  for (const file of manifest.files || []) {
    if (file.path) touchedPaths.add(file.path);
    if (file.oldPath) touchedPaths.add(file.oldPath);
  }

  const preimages = await hashTouchedPreimages(cTarget, touchedPaths);
  const preIndexFingerprint = canonicalIndexFingerprint(cTarget);

  // If patch is empty, nothing to mutate
  if (patch.length === 0) {
    return {
      success: true,
      applied: true,
      blocked: false,
      touchedFiles: [],
      preimages,
      appliedAt: new Date().toISOString(),
    };
  }

  // 8. Apply directly to worktree without reset/checkout/commit/merge or canonical index mutation
  const applyRes = runGit(["apply", "--whitespace=nowarn"], {
    cwd: cTarget,
    input: patch,
    allowFailure: true,
  });

  if (applyRes.status !== 0) {
    const postIndexFingerprint = canonicalIndexFingerprint(cTarget);
    return {
      success: false,
      applied: false,
      blocked: true,
      reasons: ["APPLY_FAILED"],
      error: applyRes.stderr || applyRes.stdout,
      conflicts: [],
      preimages,
      indexFingerprintBefore: preIndexFingerprint,
      indexFingerprintAfter: postIndexFingerprint,
      indexUnchanged: postIndexFingerprint === preIndexFingerprint,
    };
  }

  // 9. Verify canonical index fingerprint is unchanged. Pre-existing staged
  // edits are valid; only a delta introduced by this operation is unsafe.
  const postIndexFingerprint = canonicalIndexFingerprint(cTarget);
  if (postIndexFingerprint !== preIndexFingerprint) {
    return {
      success: false,
      applied: true,
      blocked: true,
      reasons: ["CANONICAL_INDEX_MUTATED"],
      preimages,
      indexFingerprintBefore: preIndexFingerprint,
      indexFingerprintAfter: postIndexFingerprint,
      indexUnchanged: false,
      touchedFiles: Array.from(touchedPaths).sort(),
    };
  }

  return {
    success: true,
    applied: true,
    blocked: false,
    touchedFiles: Array.from(touchedPaths).sort(),
    preimages,
    indexFingerprintBefore: preIndexFingerprint,
    indexFingerprintAfter: postIndexFingerprint,
    indexUnchanged: true,
    appliedAt: new Date().toISOString(),
  };
}
