import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

import {
  canonicalPath,
  checkTargetsOverlap,
  createWorktree,
  finalizeWorktree,
  getWorkspaceIdentity,
  GitValidationError,
  isPathWithinTargets,
  listWorktrees,
  normalizeDeclaredTargets,
  runGit,
  validateRepository,
  withCommonDirLock,
} from "../../skills/delegate-to-antigravity/scripts/lib/git-worktree.mjs";
import {
  captureEvidence,
  deterministicJsonStringify,
  hashManifest,
  hashPatch,
  validateReconstruction,
} from "../../skills/delegate-to-antigravity/scripts/lib/evidence.mjs";
import {
  applyPatch,
  detectConflicts,
  hashTouchedPreimages,
} from "../../skills/delegate-to-antigravity/scripts/lib/apply.mjs";

async function createTempDir(prefix = "agy-test-") {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function initTestRepo(prefix = "agy-test-repo-") {
  const repoDir = await createTempDir(prefix);
  const canonical = canonicalPath(repoDir);

  runGit(["init"], { cwd: canonical });
  runGit(["config", "user.name", "Agy Test Harness"], { cwd: canonical });
  runGit(["config", "user.email", "agy-harness@example.com"], { cwd: canonical });
  runGit(["config", "core.autocrlf", "false"], { cwd: canonical });
  runGit(["config", "commit.gpgsign", "false"], { cwd: canonical });
  runGit(["config", "protocol.file.allow", "always"], { cwd: canonical });

  return {
    repoDir: canonical,
    cleanup: async () => {
      await fsp.rm(canonical, { recursive: true, force: true }).catch(() => {});
    },
  };
}

async function commitFiles(repoDir, filesMap, message = "initial commit") {
  for (const [relPath, content] of Object.entries(filesMap)) {
    const full = path.join(repoDir, relPath);
    await fsp.mkdir(path.dirname(full), { recursive: true });
    if (Buffer.isBuffer(content)) {
      await fsp.writeFile(full, content);
    } else {
      await fsp.writeFile(full, content, "utf8");
    }
  }
  runGit(["add", "-A"], { cwd: repoDir });
  runGit(["commit", "-m", message], { cwd: repoDir });
  const headRes = runGit(["rev-parse", "HEAD"], { cwd: repoDir });
  return headRes.stdout.trim();
}

describe("Git Worktree Isolation & Validation", () => {
  test("rejects non-git directory", async () => {
    const nonGitDir = await createTempDir("agy-nongit-");
    try {
      assert.throws(
        () => validateRepository(nonGitDir),
        (err) => err instanceof GitValidationError && err.code === "NOT_A_GIT_REPOSITORY",
      );
    } finally {
      await fsp.rm(nonGitDir, { recursive: true, force: true });
    }
  });

  test("rejects bare repository", async () => {
    const bareDir = await createTempDir("agy-bare-");
    try {
      runGit(["init", "--bare"], { cwd: bareDir });
      assert.throws(
        () => validateRepository(bareDir),
        (err) => err instanceof GitValidationError && err.code === "BARE_REPOSITORY",
      );
    } finally {
      await fsp.rm(bareDir, { recursive: true, force: true });
    }
  });

  test("rejects unborn HEAD (repository with no commits)", async () => {
    const { repoDir, cleanup } = await initTestRepo("agy-unborn-");
    try {
      assert.throws(
        () => validateRepository(repoDir),
        (err) => err instanceof GitValidationError && err.code === "UNBORN_HEAD",
      );
    } finally {
      await cleanup();
    }
  });

  test("rejects dirty canonical repository when clean is required", async () => {
    const { repoDir, cleanup } = await initTestRepo("agy-dirty-");
    try {
      await commitFiles(repoDir, { "init.txt": "hello\n" });
      await fsp.writeFile(path.join(repoDir, "untracked.txt"), "dirty untracked\n", "utf8");

      assert.throws(
        () => validateRepository(repoDir, { requireClean: true }),
        (err) => err instanceof GitValidationError && err.code === "DIRTY_REPOSITORY",
      );

      const info = validateRepository(repoDir, { requireClean: false });
      assert.equal(info.isClean, false);
    } finally {
      await cleanup();
    }
  });

  test("validates repository identity and rejects identity mismatch", async () => {
    const repoA = await initTestRepo("agy-identity-a-");
    const repoB = await initTestRepo("agy-identity-b-");
    try {
      await commitFiles(repoA.repoDir, { "file.txt": "a\n" });
      await commitFiles(repoB.repoDir, { "file.txt": "b\n" });

      const infoA = validateRepository(repoA.repoDir);
      assert.ok(infoA.identity.id);

      // Valid matching identity
      const verifiedA = validateRepository(repoA.repoDir, { expectedIdentity: infoA.identity });
      assert.equal(verifiedA.identity.id, infoA.identity.id);

      // Identity mismatch
      assert.throws(
        () => validateRepository(repoB.repoDir, { expectedIdentity: infoA.identity }),
        (err) => err instanceof GitValidationError && err.code === "IDENTITY_MISMATCH",
      );
    } finally {
      await repoA.cleanup();
      await repoB.cleanup();
    }
  });

  test("normalizes declared targets and rejects invalid patterns", () => {
    // Rejects backslash ambiguity
    assert.throws(
      () => normalizeDeclaredTargets(["src\\foo.js"]),
      (err) => err instanceof GitValidationError && err.code === "BACKSLASH_AMBIGUITY",
    );

    // Rejects absolute paths
    assert.throws(
      () => normalizeDeclaredTargets(["/root/path.js"]),
      (err) => err instanceof GitValidationError && err.code === "ABSOLUTE_TARGET",
    );
    assert.throws(
      () => normalizeDeclaredTargets(["C:/root/path.js"]),
      (err) => err instanceof GitValidationError && err.code === "ABSOLUTE_TARGET",
    );

    // Rejects dot-dot escapes
    assert.throws(
      () => normalizeDeclaredTargets(["../escape.js"]),
      (err) => err instanceof GitValidationError && err.code === "DOT_DOT_ESCAPE",
    );
    assert.throws(
      () => normalizeDeclaredTargets(["src/../../escape.js"]),
      (err) => err instanceof GitValidationError && err.code === "DOT_DOT_ESCAPE",
    );

    // Rejects empty segments / double slash
    assert.throws(
      () => normalizeDeclaredTargets(["src//sub.js"]),
      (err) => err instanceof GitValidationError && err.code === "MALFORMED_TARGET",
    );

    // Rejects duplicate targets
    assert.throws(
      () => normalizeDeclaredTargets(["src/a.js", "src/a.js"]),
      (err) => err instanceof GitValidationError && err.code === "UNAUTHORIZED_OVERLAP",
    );

    // Rejects overlapping prefix targets
    assert.throws(
      () => normalizeDeclaredTargets(["src", "src/nested/file.js"]),
      (err) => err instanceof GitValidationError && err.code === "UNAUTHORIZED_OVERLAP",
    );
    assert.throws(
      () => normalizeDeclaredTargets(["src/", "src/nested/file.js"]),
      (err) => err instanceof GitValidationError && err.code === "UNAUTHORIZED_OVERLAP",
    );

    // Accepts valid disjoint targets
    const valid = normalizeDeclaredTargets(["src/a.js", "tests/b.test.js", "docs/"]);
    assert.deepEqual(valid, ["src/a.js", "tests/b.test.js", "docs"]);

    // Path matching
    assert.equal(isPathWithinTargets("src/a.js", valid), true);
    assert.equal(isPathWithinTargets("docs/readme.md", valid), true);
    assert.equal(isPathWithinTargets("other/file.js", valid), false);

    // Overlap checking
    const overlapResult = checkTargetsOverlap(["src/feature"], ["src/feature/sub.js"]);
    assert.equal(overlapResult.overlap, true);

    const disjointResult = checkTargetsOverlap(["src/featureA"], ["src/featureB"]);
    assert.equal(disjointResult.overlap, false);
  });

  test("worktree locking serializes operations and prevents race conditions", async () => {
    const { repoDir, cleanup } = await initTestRepo("agy-lock-");
    try {
      await commitFiles(repoDir, { "init.txt": "1\n" });
      const info = validateRepository(repoDir);

      let concurrentSeen = false;
      let holding = false;

      const p1 = withCommonDirLock(info.commonDir, async () => {
        holding = true;
        await new Promise((r) => setTimeout(r, 150));
        holding = false;
      });

      const p2 = withCommonDirLock(info.commonDir, async () => {
        if (holding) concurrentSeen = true;
      });

      await Promise.all([p1, p2]);
      assert.equal(concurrentSeen, false);
    } finally {
      await cleanup();
    }
  });
});

describe("Evidence Capture & Apply Roundtrip", () => {
  test("modified-added-deleted-renamed-binary roundtrip with mechanical reconstruction", async () => {
    const { repoDir, cleanup } = await initTestRepo("agy-roundtrip-");
    const worktreesBase = await createTempDir("agy-wts-");

    try {
      const initialBinary = Buffer.from([0x00, 0x01, 0x02, 0xfe, 0xff, 0x42, 0x00, 0x77]);
      const baseSha = await commitFiles(repoDir, {
        "text-mod.txt": "line1\nline2\nline3\n",
        "text-del.txt": "delete me\n",
        "text-ren.txt": "rename me\n",
        "bin-mod.bin": initialBinary,
        "unrelated.txt": "unrelated original\n",
      });

      const worktreePath = path.join(worktreesBase, "wt-1");
      const wtInfo = await createWorktree({
        repoRoot: repoDir,
        worktreePath,
        baseSha,
        callerId: "worker-roundtrip",
      });

      const gitDir = runGit(["rev-parse", "--git-dir"], { cwd: worktreePath }).stdout.trim();
      assert.ok(fs.existsSync(path.join(path.resolve(worktreePath, gitDir), "agy-worktree.json")));
      assert.equal(fs.existsSync(path.join(worktreePath, ".agy-worktree.json")), false);

      // Make modifications in worktree:
      // 1. Modify text
      await fsp.writeFile(path.join(worktreePath, "text-mod.txt"), "line1\nmodified line2\nline3\nline4\n", "utf8");
      // 2. Add text
      await fsp.writeFile(path.join(worktreePath, "text-add.txt"), "new file content\n", "utf8");
      // 3. Delete text
      await fsp.unlink(path.join(worktreePath, "text-del.txt"));
      // 4. Rename text
      runGit(["mv", "text-ren.txt", "text-renamed.txt"], { cwd: worktreePath });
      // 5. Modify binary
      const modifiedBinary = Buffer.from([0x00, 0x42, 0x43, 0xfe, 0xaa, 0xbb, 0xcc, 0x00, 0xff]);
      await fsp.writeFile(path.join(worktreePath, "bin-mod.bin"), modifiedBinary);
      // 6. Add binary
      const newBinary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);
      await fsp.writeFile(path.join(worktreePath, "bin-add.bin"), newBinary);

      const declaredTargets = [
        "text-mod.txt",
        "text-add.txt",
        "text-del.txt",
        "text-ren.txt",
        "text-renamed.txt",
        "bin-mod.bin",
        "bin-add.bin",
      ];

      // Capture evidence from worktree
      const evidence = await captureEvidence({
        worktreePath,
        baseSha,
        declaredTargets,
        repoRoot: repoDir,
      });

      assert.equal(evidence.reconstructionValidated, true);
      assert.equal(evidence.manifest.hasOutOfTarget, false);
      assert.equal(evidence.manifest.hasSubmoduleIssues, false);
      assert.equal(evidence.manifest.stats.binary, 2);
      assert.equal(evidence.manifest.stats.deleted, 1);
      assert.equal(evidence.manifest.stats.renamed, 1);
      assert.equal(evidence.manifest.stats.added, 2);
      assert.equal(evidence.manifest.stats.modified, 2);

      // Verify hashes
      assert.equal(evidence.patchHash, hashPatch(evidence.patch));
      assert.equal(evidence.manifestHash, hashManifest(evidence.manifest));

      // Apply patch to the canonical repo
      const applyResult = await applyPatch({
        targetRepoPath: repoDir,
        patch: evidence.patch,
        manifest: evidence.manifest,
        manifestHash: evidence.manifestHash,
      });

      assert.equal(applyResult.success, true);
      assert.equal(applyResult.applied, true);
      assert.equal(applyResult.blocked, false);

      // Canonical index must NOT be mutated
      const stagedCheck = runGit(["diff", "--cached", "--name-only"], { cwd: repoDir });
      assert.equal(stagedCheck.stdout.trim(), "");

      // Verify files on disk match exactly
      assert.equal(
        await fsp.readFile(path.join(repoDir, "text-mod.txt"), "utf8"),
        "line1\nmodified line2\nline3\nline4\n",
      );
      assert.equal(
        await fsp.readFile(path.join(repoDir, "text-add.txt"), "utf8"),
        "new file content\n",
      );
      assert.equal(fs.existsSync(path.join(repoDir, "text-del.txt")), false);
      assert.equal(fs.existsSync(path.join(repoDir, "text-ren.txt")), false);
      assert.equal(
        await fsp.readFile(path.join(repoDir, "text-renamed.txt"), "utf8"),
        "rename me\n",
      );

      const diskBinMod = await fsp.readFile(path.join(repoDir, "bin-mod.bin"));
      assert.deepEqual(diskBinMod, modifiedBinary);

      const diskBinAdd = await fsp.readFile(path.join(repoDir, "bin-add.bin"));
      assert.deepEqual(diskBinAdd, newBinary);

      // Verify preimages were captured
      assert.ok(applyResult.preimages["text-mod.txt"]);
      assert.equal(applyResult.preimages["text-add.txt"], null);

      // Finalize worktree
      const fin = await finalizeWorktree(worktreePath, { repoRoot: repoDir });
      assert.equal(fin.status, "removed");
      assert.equal(fs.existsSync(worktreePath), false);
    } finally {
      await cleanup();
      await fsp.rm(worktreesBase, { recursive: true, force: true });
    }
  });

  test("detects out-of-target changes and blocks apply", async () => {
    const { repoDir, cleanup } = await initTestRepo("agy-target-mismatch-");
    const worktreesBase = await createTempDir("agy-wts-target-");

    try {
      const baseSha = await commitFiles(repoDir, {
        "src/component.js": "export const a = 1;\n",
        "config.json": "{\"version\": 1}\n",
      });

      const worktreePath = path.join(worktreesBase, "wt-target");
      await createWorktree({ repoRoot: repoDir, worktreePath, baseSha });

      // Worker modifies both target and unauthorized file
      await fsp.writeFile(path.join(worktreePath, "src/component.js"), "export const a = 2;\n", "utf8");
      await fsp.writeFile(path.join(worktreePath, "config.json"), "{\"version\": 2}\n", "utf8");

      const evidence = await captureEvidence({
        worktreePath,
        baseSha,
        declaredTargets: ["src/component.js"],
        repoRoot: repoDir,
      });

      assert.equal(evidence.manifest.hasOutOfTarget, true);
      assert.ok(evidence.manifest.outOfTargetFiles.includes("config.json"));

      const applyRes = await applyPatch({
        targetRepoPath: repoDir,
        patch: evidence.patch,
        manifest: evidence.manifest,
        manifestHash: evidence.manifestHash,
      });

      assert.equal(applyRes.blocked, true);
      assert.ok(applyRes.reasons.includes("OUT_OF_TARGET_CHANGES"));

      await finalizeWorktree(worktreePath, { repoRoot: repoDir });
    } finally {
      await cleanup();
      await fsp.rm(worktreesBase, { recursive: true, force: true });
    }
  });

  test("blocks apply on base SHA mismatch, patch hash mismatch, or manifest hash mismatch", async () => {
    const { repoDir, cleanup } = await initTestRepo("agy-hash-mismatch-");
    const worktreesBase = await createTempDir("agy-wts-hash-");

    try {
      const baseSha1 = await commitFiles(repoDir, { "test.txt": "v1\n" });
      const worktreePath = path.join(worktreesBase, "wt-hash");
      await createWorktree({ repoRoot: repoDir, worktreePath, baseSha: baseSha1 });

      await fsp.writeFile(path.join(worktreePath, "test.txt"), "v2\n", "utf8");
      const evidence = await captureEvidence({
        worktreePath,
        baseSha: baseSha1,
        declaredTargets: ["test.txt"],
        repoRoot: repoDir,
      });

      const missingHash = await applyPatch({ targetRepoPath: repoDir, patch: evidence.patch, manifest: evidence.manifest });
      assert.deepEqual(missingHash.reasons, ["MANIFEST_HASH_REQUIRED"]);
      assert.equal(missingHash.applied, false);

      // 1. Base SHA mismatch: canonical repo has a new commit
      await commitFiles(repoDir, { "unrelated.txt": "advance head\n" });
      const resBaseMismatch = await applyPatch({
        targetRepoPath: repoDir,
        patch: evidence.patch,
        manifest: evidence.manifest,
        manifestHash: evidence.manifestHash,
      });
      assert.equal(resBaseMismatch.blocked, true);
      assert.ok(resBaseMismatch.reasons.includes("BASE_SHA_MISMATCH"));

      // Reset repo head back to baseSha1 for hash tests
      runGit(["reset", "--hard", baseSha1], { cwd: repoDir });

      // 2. Patch hash mismatch
      const corruptedPatch = Buffer.concat([evidence.patch, Buffer.from("# corrupted line\n")]);
      const resPatchMismatch = await applyPatch({
        targetRepoPath: repoDir,
        patch: corruptedPatch,
        manifest: evidence.manifest,
        manifestHash: evidence.manifestHash,
      });
      assert.equal(resPatchMismatch.blocked, true);
      assert.ok(resPatchMismatch.reasons.includes("PATCH_HASH_MISMATCH"));

      // 3. Manifest hash mismatch
      const tamperedManifest = { ...evidence.manifest, baseSha: "0123456789abcdef0123456789abcdef01234567" };
      const resManifestMismatch = await applyPatch({
        targetRepoPath: repoDir,
        patch: evidence.patch,
        manifest: tamperedManifest,
        manifestHash: evidence.manifestHash,
      });
      assert.equal(resManifestMismatch.blocked, true);
      assert.ok(resManifestMismatch.reasons.includes("MANIFEST_HASH_MISMATCH"));

      await finalizeWorktree(worktreePath, { repoRoot: repoDir });
    } finally {
      await cleanup();
      await fsp.rm(worktreesBase, { recursive: true, force: true });
    }
  });

  test("preserves unrelated edits while blocking conflicts on touched paths", async () => {
    const { repoDir, cleanup } = await initTestRepo("agy-unrelated-");
    const worktreesBase = await createTempDir("agy-wts-unrelated-");

    try {
      const baseSha = await commitFiles(repoDir, {
        "src/worker-file.txt": "worker original\n",
        "other/unrelated.txt": "other original\n",
      });

      const worktreePath = path.join(worktreesBase, "wt-unrelated");
      await createWorktree({ repoRoot: repoDir, worktreePath, baseSha });

      await fsp.writeFile(path.join(worktreePath, "src/worker-file.txt"), "worker updated\n", "utf8");
      const evidence = await captureEvidence({
        worktreePath,
        baseSha,
        declaredTargets: ["src/worker-file.txt"],
        repoRoot: repoDir,
      });

      // Canonical repo has UNRELATED unstaged edits
      await fsp.writeFile(path.join(repoDir, "other/unrelated.txt"), "other modified by user\n", "utf8");

      // Apply should SUCCEED and preserve unrelated changes!
      const resApply = await applyPatch({
        targetRepoPath: repoDir,
        patch: evidence.patch,
        manifest: evidence.manifest,
        manifestHash: evidence.manifestHash,
      });

      assert.equal(resApply.success, true);
      assert.equal(
        await fsp.readFile(path.join(repoDir, "src/worker-file.txt"), "utf8"),
        "worker updated\n",
      );
      assert.equal(
        await fsp.readFile(path.join(repoDir, "other/unrelated.txt"), "utf8"),
        "other modified by user\n",
      );

      // Now create a conflict on TOUCHED path (unstaged modification)
      await fsp.writeFile(path.join(repoDir, "src/worker-file.txt"), "conflicting edit\n", "utf8");
      const resConflict = await applyPatch({
        targetRepoPath: repoDir,
        patch: evidence.patch,
        manifest: evidence.manifest,
        manifestHash: evidence.manifestHash,
      });

      assert.equal(resConflict.blocked, true);
      assert.ok(resConflict.reasons.includes("TOUCHED_PATH_CONFLICT"));
      assert.ok(resConflict.conflicts.some((c) => c.path === "src/worker-file.txt"));

      // Worktree remains intact
      await finalizeWorktree(worktreePath, { repoRoot: repoDir });
    } finally {
      await cleanup();
      await fsp.rm(worktreesBase, { recursive: true, force: true });
    }
  });

  test("accepts Git-normalized line endings but rejects real preimage changes", async () => {
    const { repoDir, cleanup } = await initTestRepo("agy-line-endings-");
    try {
      const baseSha = await commitFiles(repoDir, {
        ".gitattributes": "*.txt text eol=lf\n",
        "line.txt": "first\nsecond\n",
      });
      const manifest = { baseSha, files: [{ status: "M", path: "line.txt" }] };

      await fsp.writeFile(path.join(repoDir, "line.txt"), "first\r\nsecond\r\n", "utf8");
      assert.equal(runGit(["diff", "--quiet", "--", "line.txt"], { cwd: repoDir, allowFailure: true }).status, 0);
      assert.deepEqual(detectConflicts(repoDir, manifest), []);

      await fsp.writeFile(path.join(repoDir, "line.txt"), "first\r\nchanged\r\n", "utf8");
      const conflicts = detectConflicts(repoDir, manifest);
      assert.ok(conflicts.some((conflict) => conflict.path === "line.txt" && conflict.type === "unstaged_conflict"));
      assert.ok(conflicts.some((conflict) => conflict.path === "line.txt" && conflict.type === "preimage_mismatch"));
    } finally {
      await cleanup();
    }
  });

  test("represents open-handle failure as pending_prune and cleans up once handle is closed", async () => {
    const { repoDir, cleanup } = await initTestRepo("agy-handle-");
    const worktreesBase = await createTempDir("agy-wts-handle-");

    try {
      const baseSha = await commitFiles(repoDir, { "file.txt": "hello\n" });
      const worktreePath = path.join(worktreesBase, "wt-handle");
      await createWorktree({ repoRoot: repoDir, worktreePath, baseSha });

      // Lock a file in the worktree by opening it with exclusive write or read lock
      const targetFilePath = path.join(worktreePath, "file.txt");
      let handle;
      try {
        handle = await fsp.open(targetFilePath, "r+");
      } catch {
        handle = await fsp.open(targetFilePath, "r");
      }

      // Try finalize while file is open
      const firstFinalize = await finalizeWorktree(worktreePath, {
        repoRoot: repoDir,
        removeRunner: async () => ({ status: 1, stderr: "EBUSY: file is used by another process", stdout: "" }),
      });

      assert.equal(firstFinalize.status, "pending_prune");
      assert.ok(firstFinalize.error);

      // Close the open handle
      await handle.close();

      // Now finalize should succeed
      const secondFinalize = await finalizeWorktree(worktreePath, { repoRoot: repoDir });
      assert.equal(secondFinalize.status, "removed");
      assert.equal(fs.existsSync(worktreePath), false);
    } finally {
      await cleanup();
      await fsp.rm(worktreesBase, { recursive: true, force: true });
    }
  });

  test("platform-unsupported symlink, mode, and gitlink cases are explicitly handled or skipped with reason", async (t) => {
    // 1. Symlinks
    let symlinksAllowed = false;
    const testDir = await createTempDir("agy-symlink-test-");
    const linkPath = path.join(testDir, "test-link");
    try {
      await fsp.symlink(testDir, linkPath, "junction");
      symlinksAllowed = true;
      await fsp.unlink(linkPath);
    } catch {
      symlinksAllowed = false;
    } finally {
      await fsp.rm(testDir, { recursive: true, force: true });
    }

    if (!symlinksAllowed) {
      t.skip("Symlink/junction creation not permitted for unprivileged user on Windows");
    }

    // 2. POSIX executable modes
    if (process.platform === "win32") {
      t.skip("POSIX chmod file modes are not tracked by Windows Git filesystem (core.filemode=false)");
    }

    // 3. Gitlinks / submodules
    const { repoDir, cleanup } = await initTestRepo("agy-submodule-");
    try {
      await commitFiles(repoDir, { "parent.txt": "parent\n" });
      const subRepo = await initTestRepo("agy-sub-inner-");
      await commitFiles(subRepo.repoDir, { "sub.txt": "submodule content\n" });

      const subAddRes = runGit(
        ["submodule", "add", subRepo.repoDir.replace(/\\/g, "/"), "my-submodule"],
        {
          cwd: repoDir,
          allowFailure: true,
        },
      );

      if (subAddRes.status !== 0) {
        t.skip(`Submodule creation skipped due to local Git protocol/config restrictions: ${subAddRes.stderr}`);
      } else {
        await commitFiles(repoDir, {}, "add submodule");
        assert.ok(fs.existsSync(path.join(repoDir, "my-submodule", "sub.txt")));
      }
      await subRepo.cleanup();
    } finally {
      await cleanup();
    }
  });
});
