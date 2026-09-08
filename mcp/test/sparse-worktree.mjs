import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  canonicalPath,
  createWorktree,
  finalizeWorktree,
  GitValidationError,
  listWorktrees,
  runGit,
  verifyWorktreeOwnership,
} from "../../skills/delegate-to-antigravity/scripts/lib/git-worktree.mjs";

async function createTempDir(prefix = "agy-test-sparse-") {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function initTestRepo(prefix = "agy-test-sparse-repo-") {
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

describe("Sparse Worktree Isolation & Lifecycle", () => {
  const sampleRepoFiles = {
    "root.txt": "root file content\n",
    "pkg/src/app.mjs": "export const app = 'app';\n",
    "pkg/src/sibling.mjs": "export const sibling = 'sibling';\n",
    "unrelated/deep/secret.txt": "secret content\n",
  };

  test("default full checkout includes all files when checkoutPaths is omitted", async () => {
    const { repoDir, cleanup } = await initTestRepo();
    const worktreeBase = await createTempDir("agy-wt-full-");
    const worktreePath = path.join(worktreeBase, "wt-full");

    try {
      const baseSha = await commitFiles(repoDir, sampleRepoFiles);
      const res = await createWorktree({ repoRoot: repoDir, worktreePath, baseSha });

      assert.equal(canonicalPath(res.worktreePath), canonicalPath(worktreePath));
      assert.ok(fs.existsSync(path.join(worktreePath, "root.txt")));
      assert.ok(fs.existsSync(path.join(worktreePath, "pkg", "src", "app.mjs")));
      assert.ok(fs.existsSync(path.join(worktreePath, "pkg", "src", "sibling.mjs")));
      assert.ok(fs.existsSync(path.join(worktreePath, "unrelated", "deep", "secret.txt")));

      const verified = await verifyWorktreeOwnership(worktreePath, { repoRoot: repoDir });
      assert.equal(verified.canonicalPath, canonicalPath(worktreePath));

      const finalized = await finalizeWorktree(worktreePath, { repoRoot: repoDir });
      assert.equal(finalized.status, "removed");
      assert.equal(fs.existsSync(worktreePath), false);
    } finally {
      await cleanup();
      await fsp.rm(worktreeBase, { recursive: true, force: true }).catch(() => {});
    }
  });

  test("selected tracked file parent includes sibling but unrelated subtree absent", async () => {
    const { repoDir, cleanup } = await initTestRepo();
    const worktreeBase = await createTempDir("agy-wt-sparse-");
    const worktreePath = path.join(worktreeBase, "wt-sparse");

    try {
      const baseSha = await commitFiles(repoDir, sampleRepoFiles);
      await createWorktree({
        repoRoot: repoDir,
        worktreePath,
        baseSha,
        checkoutPaths: ["pkg/src/app.mjs"],
      });

      // Root files are naturally present in Git cone mode
      assert.ok(fs.existsSync(path.join(worktreePath, "root.txt")));

      // Selected file and sibling in same parent directory are present
      assert.ok(fs.existsSync(path.join(worktreePath, "pkg", "src", "app.mjs")));
      assert.ok(fs.existsSync(path.join(worktreePath, "pkg", "src", "sibling.mjs")));

      // Unrelated subtree is completely absent from the sparse worktree
      assert.equal(fs.existsSync(path.join(worktreePath, "unrelated")), false);

      await finalizeWorktree(worktreePath, { repoRoot: repoDir });
    } finally {
      await cleanup();
      await fsp.rm(worktreeBase, { recursive: true, force: true }).catch(() => {});
    }
  });

  test("root-file-only selection checks out root file and excludes subtrees", async () => {
    const { repoDir, cleanup } = await initTestRepo();
    const worktreeBase = await createTempDir("agy-wt-root-");
    const worktreePath = path.join(worktreeBase, "wt-root");

    try {
      const baseSha = await commitFiles(repoDir, sampleRepoFiles);
      await createWorktree({
        repoRoot: repoDir,
        worktreePath,
        baseSha,
        checkoutPaths: ["root.txt"],
      });

      assert.ok(fs.existsSync(path.join(worktreePath, "root.txt")));
      assert.equal(fs.existsSync(path.join(worktreePath, "pkg")), false);
      assert.equal(fs.existsSync(path.join(worktreePath, "unrelated")), false);

      await finalizeWorktree(worktreePath, { repoRoot: repoDir });
    } finally {
      await cleanup();
      await fsp.rm(worktreeBase, { recursive: true, force: true }).catch(() => {});
    }
  });

  test("directory path ending slash selects directory and excludes unrelated", async () => {
    const { repoDir, cleanup } = await initTestRepo();
    const worktreeBase = await createTempDir("agy-wt-dir-");
    const worktreePath = path.join(worktreeBase, "wt-dir");

    try {
      const baseSha = await commitFiles(repoDir, sampleRepoFiles);
      await createWorktree({
        repoRoot: repoDir,
        worktreePath,
        baseSha,
        checkoutPaths: ["pkg/src/"],
      });

      assert.ok(fs.existsSync(path.join(worktreePath, "root.txt")));
      assert.ok(fs.existsSync(path.join(worktreePath, "pkg", "src", "app.mjs")));
      assert.ok(fs.existsSync(path.join(worktreePath, "pkg", "src", "sibling.mjs")));
      assert.equal(fs.existsSync(path.join(worktreePath, "unrelated")), false);

      await finalizeWorktree(worktreePath, { repoRoot: repoDir });
    } finally {
      await cleanup();
      await fsp.rm(worktreeBase, { recursive: true, force: true }).catch(() => {});
    }
  });

  test("invalid traversal, glob, and missing paths are rejected BEFORE tree creation", async () => {
    const { repoDir, cleanup } = await initTestRepo();
    const worktreeBase = await createTempDir("agy-wt-invalid-");

    try {
      const baseSha = await commitFiles(repoDir, sampleRepoFiles);

      const invalidCases = [
        {
          checkoutPaths: ["../escape.txt"],
          expectedCode: "DOT_DOT_ESCAPE",
          name: "dot-dot segment",
        },
        {
          checkoutPaths: ["pkg/src/../../escape.txt"],
          expectedCode: "DOT_DOT_ESCAPE",
          name: "nested dot-dot segment",
        },
        {
          checkoutPaths: ["/root.txt"],
          expectedCode: "ABSOLUTE_TARGET",
          name: "absolute path leading slash",
        },
        {
          checkoutPaths: ["pkg/*.mjs"],
          expectedCode: "GLOB_NOT_SUPPORTED",
          name: "asterisk glob",
        },
        {
          checkoutPaths: ["pkg/src/app?.mjs"],
          expectedCode: "GLOB_NOT_SUPPORTED",
          name: "question mark glob",
        },
        {
          checkoutPaths: ["pkg/[a-z]"],
          expectedCode: "GLOB_NOT_SUPPORTED",
          name: "bracket glob",
        },
        {
          checkoutPaths: ["pkg/{a,b}"],
          expectedCode: "GLOB_NOT_SUPPORTED",
          name: "brace glob",
        },
        {
          checkoutPaths: ["pkg/src/missing.mjs"],
          expectedCode: "PATH_NOT_FOUND",
          name: "missing path at base commit",
        },
      ];

      for (let i = 0; i < invalidCases.length; i += 1) {
        const { checkoutPaths, expectedCode, name } = invalidCases[i];
        const wtPath = path.join(worktreeBase, `wt-inv-${i}`);

        await assert.rejects(
          async () => {
            await createWorktree({
              repoRoot: repoDir,
              worktreePath: wtPath,
              baseSha,
              checkoutPaths,
            });
          },
          (err) => {
            assert.ok(
              err instanceof GitValidationError,
              `Expected GitValidationError for ${name}, got ${err?.constructor?.name}: ${err?.message}`,
            );
            assert.equal(
              err.code,
              expectedCode,
              `Expected error code ${expectedCode} for ${name}, got ${err.code}`,
            );
            return true;
          },
        );

        // Verify tree was NEVER created on disk and NEVER registered in git
        assert.equal(fs.existsSync(wtPath), false, `Worktree directory should not exist for ${name}`);
        const registered = listWorktrees(repoDir);
        assert.ok(
          !registered.some((t) => t.worktree.toLowerCase() === canonicalPath(wtPath).toLowerCase()),
          `Worktree should not be registered for ${name}`,
        );
      }
    } finally {
      await cleanup();
      await fsp.rm(worktreeBase, { recursive: true, force: true }).catch(() => {});
    }
  });

  test("canonical status and index unchanged when creating and operating on sparse worktree", async () => {
    const { repoDir, cleanup } = await initTestRepo();
    const worktreeBase = await createTempDir("agy-wt-status-");
    const worktreePath = path.join(worktreeBase, "wt-status");

    try {
      const baseSha = await commitFiles(repoDir, sampleRepoFiles);

      // Verify canonical repo is clean before
      const statusBefore = runGit(["status", "--porcelain=v1"], { cwd: repoDir });
      assert.equal(statusBefore.stdout.trim(), "");
      const diffBefore = runGit(["diff-index", "--quiet", "HEAD"], { cwd: repoDir, allowFailure: true });
      assert.equal(diffBefore.status, 0);

      // Create sparse worktree
      await createWorktree({
        repoRoot: repoDir,
        worktreePath,
        baseSha,
        checkoutPaths: ["pkg/src/app.mjs"],
      });

      // Modify and add a file in the sparse worktree
      await fsp.writeFile(path.join(worktreePath, "pkg", "src", "app.mjs"), "export const modified = true;\n");

      // Verify canonical repo status and index remain completely untouched
      const statusAfter = runGit(["status", "--porcelain=v1"], { cwd: repoDir });
      assert.equal(statusAfter.stdout.trim(), "", "Canonical repository status must remain clean");
      const diffAfter = runGit(["diff-index", "--quiet", "HEAD"], { cwd: repoDir, allowFailure: true });
      assert.equal(diffAfter.status, 0, "Canonical repository index must remain untouched");

      await finalizeWorktree(worktreePath, { repoRoot: repoDir });
    } finally {
      await cleanup();
      await fsp.rm(worktreeBase, { recursive: true, force: true }).catch(() => {});
    }
  });

  test("sparse child does not make later default full child sparse", async () => {
    const { repoDir, cleanup } = await initTestRepo();
    const worktreeBase = await createTempDir("agy-wt-seq-");
    const wtSparsePath = path.join(worktreeBase, "wt-sparse");
    const wtFullPath = path.join(worktreeBase, "wt-full");

    try {
      const baseSha = await commitFiles(repoDir, sampleRepoFiles);

      // 1. Create sparse worktree child
      await createWorktree({
        repoRoot: repoDir,
        worktreePath: wtSparsePath,
        baseSha,
        checkoutPaths: ["pkg/src/app.mjs"],
      });

      assert.equal(
        fs.existsSync(path.join(wtSparsePath, "unrelated", "deep", "secret.txt")),
        false,
        "Sparse child must exclude unrelated files",
      );

      // 2. Create default full worktree child
      await createWorktree({
        repoRoot: repoDir,
        worktreePath: wtFullPath,
        baseSha,
      });

      assert.ok(
        fs.existsSync(path.join(wtFullPath, "unrelated", "deep", "secret.txt")),
        "Later full child must include all files, unaffected by prior sparse child",
      );
      assert.ok(fs.existsSync(path.join(wtFullPath, "pkg", "src", "app.mjs")));
      assert.ok(fs.existsSync(path.join(wtFullPath, "root.txt")));

      await finalizeWorktree(wtSparsePath, { repoRoot: repoDir });
      await finalizeWorktree(wtFullPath, { repoRoot: repoDir });
    } finally {
      await cleanup();
      await fsp.rm(worktreeBase, { recursive: true, force: true }).catch(() => {});
    }
  });

  test("ownership and finalize work on sparse worktree", async () => {
    const { repoDir, cleanup } = await initTestRepo();
    const worktreeBase = await createTempDir("agy-wt-own-");
    const worktreePath = path.join(worktreeBase, "wt-own");

    try {
      const baseSha = await commitFiles(repoDir, sampleRepoFiles);
      const created = await createWorktree({
        repoRoot: repoDir,
        worktreePath,
        baseSha,
        callerId: "test-sparse-caller",
        checkoutPaths: ["pkg/src/app.mjs"],
      });

      assert.equal(created.marker.callerId, "test-sparse-caller");
      assert.equal(created.marker.harness, "antigravity-delegation-harness");

      // Verify ownership
      const verified = await verifyWorktreeOwnership(worktreePath, { repoRoot: repoDir });
      assert.equal(verified.canonicalPath, canonicalPath(worktreePath));
      assert.equal(verified.marker.callerId, "test-sparse-caller");
      assert.equal(canonicalPath(verified.repoRoot), canonicalPath(repoDir));

      // Finalize worktree
      const finalizeRes = await finalizeWorktree(worktreePath, { repoRoot: repoDir });
      assert.equal(finalizeRes.status, "removed");
      assert.equal(fs.existsSync(worktreePath), false);

      const trees = listWorktrees(repoDir);
      assert.ok(!trees.some((t) => t.worktree.toLowerCase() === canonicalPath(worktreePath).toLowerCase()));
    } finally {
      await cleanup();
      await fsp.rm(worktreeBase, { recursive: true, force: true }).catch(() => {});
    }
  });

  test("sparse setup failure does not leave an unmarked owned tree under lock", async () => {
    const { repoDir, cleanup } = await initTestRepo();
    const worktreeBase = await createTempDir("agy-wt-fail-");
    const worktreePath = path.join(worktreeBase, "wt-fail");

    try {
      const baseSha = await commitFiles(repoDir, sampleRepoFiles);

      // Custom gitRunner that fails when executing sparse-checkout
      const failingRunner = (args, options) => {
        if (args[0] === "sparse-checkout") {
          throw new Error("Simulated sparse-checkout setup failure");
        }
        return runGit(args, options);
      };

      await assert.rejects(
        async () => {
          await createWorktree({
            repoRoot: repoDir,
            worktreePath,
            baseSha,
            checkoutPaths: ["pkg/src/app.mjs"],
            gitRunner: failingRunner,
          });
        },
        /Simulated sparse-checkout setup failure/,
      );

      // Safe cleanup: worktree directory removed and unregistered
      assert.equal(fs.existsSync(worktreePath), false, "Worktree directory must be cleaned up on sparse setup failure");
      const trees = listWorktrees(repoDir);
      assert.ok(
        !trees.some((t) => t.worktree.toLowerCase() === canonicalPath(worktreePath).toLowerCase()),
        "Worktree must not remain registered after setup failure",
      );

      // Canonical repository is never removed or marked dirty
      assert.ok(fs.existsSync(repoDir), "Canonical repository must remain intact");
      const statusRes = runGit(["status", "--porcelain=v1"], { cwd: repoDir });
      assert.equal(statusRes.stdout.trim(), "", "Canonical repository status must remain clean");
    } finally {
      await cleanup();
      await fsp.rm(worktreeBase, { recursive: true, force: true }).catch(() => {});
    }
  });

  test("safety check prevents creating worktree at canonical repository root", async () => {
    const { repoDir, cleanup } = await initTestRepo();

    try {
      const baseSha = await commitFiles(repoDir, sampleRepoFiles);
      await assert.rejects(
        async () => {
          await createWorktree({
            repoRoot: repoDir,
            worktreePath: repoDir,
            baseSha,
          });
        },
        (err) => err instanceof GitValidationError && err.code === "CANONICAL_REPO_SAFETY_VIOLATION",
      );

      // Canonical repo intact
      assert.ok(fs.existsSync(repoDir));
      assert.ok(fs.existsSync(path.join(repoDir, "root.txt")));
    } finally {
      await cleanup();
    }
  });
});
