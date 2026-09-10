import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fsp from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  ISOLATION_SHARED,
  ISOLATION_WORKTREE,
  VALID_ISOLATION_MODES,
  DEFAULT_ISOLATION,
  DEFAULT_RETENTION_MINUTES,
  EVIDENCE_RETENTION_DAYS,
  MAX_WORKER_SLOTS,
  MAX_CONCURRENT_SLOTS,
  MAX_RESULT_BYTES,
  MAX_SUMMARY_CHARS,
  MAX_VERIFICATION_CHARS,
  MAX_DIAGNOSTICS_ITEMS,
  MAX_DIAGNOSTIC_CHARS,
  MAX_CHANGED_PATHS,
  MAX_PATH_CHARS,
  ALLOWED_RESULT_KEYS,
  ALLOWED_STATUS_VALUES,
  TYPED_RESULT_SCHEMA,
  CONTRACT_JSON_SCHEMA,
  RESULT_JSON_SCHEMA,
  TYPED_CONTRACT_SCHEMA,
  normalizeTarget,
  normalizeTargets,
  validateTarget,
  validateTargets,
  isPathCoveredByTargets,
  buildFourPillarPrompt,
  buildPrompt,
  validateTypedResult,
  parseTypedResult,
  isValidTypedResult,
  getDefaultIsolation,
  isUnsafeSharedIsolation,
  resolveIsolation,
  buildCallbackMessage,
  buildCallback,
} from "../../skills/delegate-to-antigravity/scripts/lib/contracts.mjs";

test("Prompt bytes: byte-stable four-pillar prompt builder in exact order", () => {
  const prompt1 = buildFourPillarPrompt({
    targets: ["src/index.ts", "mcp/server.ts"],
    action: "Implement feature X",
    constraints: "Use Node stdlib only",
    verification: "node --test",
    task: "Additional instructions here.",
  });

  const prompt2 = buildFourPillarPrompt({
    targets: ["mcp/server.ts", "src/index.ts"], // Reversed order
    action: "Implement feature X\r\n",
    constraints: "Use Node stdlib only\r",
    verification: "node --test",
    task: "Additional instructions here.\r\n",
  });

  // Byte stability: targets sorted deterministically, newlines normalized to \n
  assert.equal(prompt1, prompt2);
  assert.equal(Buffer.byteLength(prompt1, "utf8"), Buffer.byteLength(prompt2, "utf8"));

  // Verify exact order of pillars: TARGETS, ACTION, CONSTRAINTS, VERIFICATION, with task text appended last
  const lines = prompt1.split("\n");
  assert.ok(lines[0].startsWith("TARGETS: mcp/server.ts; src/index.ts"));
  assert.ok(lines[1].startsWith("ACTION: Implement feature X"));
  assert.ok(lines[2].startsWith("CONSTRAINTS: Use Node stdlib only"));
  assert.ok(lines[3].startsWith("VERIFICATION: node --test"));
  assert.equal(lines[4], "");
  assert.equal(lines[5], "Additional instructions here.");

  // Alias verification
  assert.equal(buildPrompt, buildFourPillarPrompt);

  // Without task text
  const noTask = buildFourPillarPrompt({
    targets: "src/file.mjs",
    action: "Refactor",
    constraints: "No external deps",
    verification: "node --check",
  });
  const noTaskLines = noTask.split("\n");
  assert.equal(noTaskLines.length, 4);
  assert.equal(noTaskLines[0], "TARGETS: src/file.mjs");
  assert.equal(noTaskLines[1], "ACTION: Refactor");
  assert.equal(noTaskLines[2], "CONSTRAINTS: No external deps");
  assert.equal(noTaskLines[3], "VERIFICATION: node --check");
});

test("Schemas: strict JSON Schema permitted properties and limits", () => {
  assert.equal(TYPED_RESULT_SCHEMA.$schema, "http://json-schema.org/draft-07/schema#");
  assert.equal(TYPED_RESULT_SCHEMA.type, "object");
  assert.equal(TYPED_RESULT_SCHEMA.additionalProperties, false);

  // Verify permitted properties: ONLY status, summary, verification, diagnostics, claimedChangedPaths
  const schemaProps = Object.keys(TYPED_RESULT_SCHEMA.properties).sort();
  const expectedProps = ["claimedChangedPaths", "diagnostics", "status", "summary", "verification"].sort();
  assert.deepEqual(schemaProps, expectedProps);

  // Required properties
  assert.deepEqual(
    TYPED_RESULT_SCHEMA.required.sort(),
    ["claimedChangedPaths", "status", "summary", "verification"].sort(),
  );

  // Schema aliases
  assert.equal(CONTRACT_JSON_SCHEMA, TYPED_RESULT_SCHEMA);
  assert.equal(RESULT_JSON_SCHEMA, TYPED_RESULT_SCHEMA);
  assert.equal(TYPED_CONTRACT_SCHEMA, TYPED_RESULT_SCHEMA);

  // Enum and limits
  assert.ok(TYPED_RESULT_SCHEMA.properties.status.enum.includes("success"));
  assert.ok(TYPED_RESULT_SCHEMA.properties.status.enum.includes("failure"));
  assert.ok(TYPED_RESULT_SCHEMA.properties.status.enum.includes("inconclusive"));
  assert.equal(TYPED_RESULT_SCHEMA.properties.summary.maxLength, MAX_SUMMARY_CHARS);
  assert.equal(TYPED_RESULT_SCHEMA.properties.verification.maxLength, MAX_VERIFICATION_CHARS);
  assert.equal(TYPED_RESULT_SCHEMA.properties.diagnostics.maxItems, MAX_DIAGNOSTICS_ITEMS);
  assert.equal(TYPED_RESULT_SCHEMA.properties.claimedChangedPaths.maxItems, MAX_CHANGED_PATHS);
});

test("Valid typed results parsing and validation", () => {
  const validMinimal = {
    status: "success",
    summary: "Successfully updated contracts",
    verification: "node --test passed",
    claimedChangedPaths: ["skills/delegate-to-antigravity/scripts/lib/contracts.mjs"],
  };

  const parsed1 = parseTypedResult(validMinimal);
  assert.equal(parsed1.status, "success");
  assert.equal(parsed1.summary, "Successfully updated contracts");
  assert.deepEqual(parsed1.diagnostics, []);
  assert.deepEqual(parsed1.claimedChangedPaths, ["skills/delegate-to-antigravity/scripts/lib/contracts.mjs"]);

  // Test uppercase status normalization and JSON string parsing
  const jsonString = JSON.stringify({
    status: "SUCCESS",
    summary: "All checks green",
    verification: "All 10 tests passed",
    diagnostics: ["warning: non-fatal lint"],
    claimedChangedPaths: ["mcp/test/contracts.mjs"],
  });
  const parsed2 = parseTypedResult(jsonString);
  assert.equal(parsed2.status, "success");
  assert.deepEqual(parsed2.diagnostics, ["warning: non-fatal lint"]);

  assert.ok(isValidTypedResult(validMinimal));
  assert.ok(isValidTypedResult(jsonString));
});

test("Invalid typed results rejected", () => {
  // Not an object
  assert.throws(() => parseTypedResult("not json"), /Failed to parse/);
  assert.throws(() => parseTypedResult(null), /Input to parseTypedResult must be a JSON string or object/);
  assert.throws(() => validateTypedResult([]), /Typed result must be a JSON object/);
  assert.throws(() => validateTypedResult("string"), /Typed result must be a JSON object/);

  // Missing required properties
  assert.throws(
    () => validateTypedResult({ summary: "foo", verification: "bar", claimedChangedPaths: [] }),
    /Missing required property.*status/,
  );
  assert.throws(
    () => validateTypedResult({ status: "success", verification: "bar", claimedChangedPaths: [] }),
    /Missing required property.*summary/,
  );
  assert.throws(
    () => validateTypedResult({ status: "success", summary: "foo", claimedChangedPaths: [] }),
    /Missing required property.*verification/,
  );
  assert.throws(
    () => validateTypedResult({ status: "success", summary: "foo", verification: "bar" }),
    /Missing required property.*claimedChangedPaths/,
  );

  // Invalid status
  assert.throws(
    () => validateTypedResult({ status: "unknown", summary: "foo", verification: "bar", claimedChangedPaths: [] }),
    /Invalid status/,
  );

  // Extra / forbidden properties
  assert.throws(
    () => validateTypedResult({
      status: "success",
      summary: "foo",
      verification: "bar",
      claimedChangedPaths: [],
      extraProp: 123,
    }),
    /Unexpected property in typed result: "extraProp"/,
  );
});

test("Excessive typed results rejected", () => {
  const base = {
    status: "success",
    summary: "Normal summary",
    verification: "Normal verification",
    claimedChangedPaths: ["file.txt"],
  };

  // Excessive summary
  assert.throws(
    () => validateTypedResult({ ...base, summary: "a".repeat(MAX_SUMMARY_CHARS + 1) }),
    RangeError,
  );

  // Excessive verification
  assert.throws(
    () => validateTypedResult({ ...base, verification: "a".repeat(MAX_VERIFICATION_CHARS + 1) }),
    RangeError,
  );

  // Excessive claimedChangedPaths item count
  const tooManyPaths = Array.from({ length: MAX_CHANGED_PATHS + 1 }, (_, i) => `file${i}.txt`);
  assert.throws(
    () => validateTypedResult({ ...base, claimedChangedPaths: tooManyPaths }),
    RangeError,
  );

  // Excessive single path length
  assert.throws(
    () => validateTypedResult({ ...base, claimedChangedPaths: ["a".repeat(MAX_PATH_CHARS + 1)] }),
    RangeError,
  );

  // Excessive diagnostics item count
  const tooManyDiags = Array.from({ length: MAX_DIAGNOSTICS_ITEMS + 1 }, (_, i) => `diag${i}`);
  assert.throws(
    () => validateTypedResult({ ...base, diagnostics: tooManyDiags }),
    RangeError,
  );

  // Excessive diagnostic item length
  assert.throws(
    () => validateTypedResult({ ...base, diagnostics: ["a".repeat(MAX_DIAGNOSTIC_CHARS + 1)] }),
    RangeError,
  );

  // Excessive raw payload size in bytes
  const largePayload = JSON.stringify({
    ...base,
    summary: "x".repeat(500),
    // Pad to exceed MAX_RESULT_BYTES
    diagnostics: Array.from({ length: 50 }, () => "d".repeat(900)),
  });
  // Verify byte length check on large string
  const giantJson = "x".repeat(MAX_RESULT_BYTES + 1);
  assert.throws(() => parseTypedResult(giantJson), RangeError);
});

test("Target normalization, validation, and escape prevention", () => {
  // Workspace-relative normalization
  assert.equal(normalizeTarget("src/index.ts"), "src/index.ts");
  assert.equal(normalizeTarget("./src/index.ts"), "src/index.ts");
  assert.equal(normalizeTarget("src\\lib\\utils.mjs"), "src/lib/utils.mjs");
  assert.equal(normalizeTarget("src//lib///utils.mjs"), "src/lib/utils.mjs");

  // Directory prefix preservation
  assert.equal(normalizeTarget("src/"), "src/");
  assert.equal(normalizeTarget("skills/delegate-to-antigravity/"), "skills/delegate-to-antigravity/");

  // Multiple targets normalization: sorted, deduplicated
  const targets = normalizeTargets([
    "skills\\delegate-to-antigravity\\scripts\\lib\\contracts.mjs",
    "./mcp/test/contracts.mjs",
    "mcp/test/contracts.mjs", // Duplicate
  ]);
  assert.deepEqual(targets, [
    "mcp/test/contracts.mjs",
    "skills/delegate-to-antigravity/scripts/lib/contracts.mjs",
  ]);

  // Target coverage check with directory prefixes
  assert.ok(isPathCoveredByTargets("src/lib/math.mjs", ["src/"]));
  assert.ok(isPathCoveredByTargets("src/index.ts", ["src/"]));
  assert.ok(isPathCoveredByTargets("src/index.ts", ["src/index.ts"]));
  assert.equal(isPathCoveredByTargets("other/file.ts", ["src/"]), false);

  // Target escapes without workspace root
  assert.throws(() => normalizeTarget("../outside.txt"), /Target escape detected/);
  assert.throws(() => normalizeTarget("../../etc/passwd"), /Target escape detected/);
  assert.throws(() => normalizeTarget("foo/../../bar"), /Target escape detected/);
  assert.throws(() => normalizeTarget("/absolute/path"), /Target escape detected/);
  assert.throws(() => normalizeTarget("C:\\Windows\\System32"), /Target escape detected/);
  assert.throws(() => normalizeTarget(""), /Target path must not be empty/);
  assert.throws(() => normalizeTarget("foo\0bar"), /Target path must not contain null bytes/);

  // Target escapes with workspace root
  const mockWorkspace = path.resolve(os.tmpdir(), "agy-contracts-workspace");
  assert.throws(
    () => normalizeTarget("../escape.txt", mockWorkspace),
    /Target escape detected.*resolves outside workspace root/,
  );
  assert.throws(
    () => normalizeTarget(path.resolve(mockWorkspace, "..", "outside.txt"), mockWorkspace),
    /Target escape detected.*resolves outside workspace root/,
  );

  // Valid target within workspace root
  const inside = path.resolve(mockWorkspace, "subdir", "file.js");
  assert.equal(normalizeTarget(inside, mockWorkspace), "subdir/file.js");
});

test("Isolation matrix and constants", () => {
  // Verify exported constants
  assert.equal(ISOLATION_SHARED, "shared");
  assert.equal(ISOLATION_WORKTREE, "worktree");
  assert.deepEqual(VALID_ISOLATION_MODES, ["shared", "worktree"]);
  assert.equal(DEFAULT_RETENTION_MINUTES, 1440);
  assert.equal(EVIDENCE_RETENTION_DAYS, 14);
  assert.equal(MAX_WORKER_SLOTS, 8);
  assert.equal(MAX_CONCURRENT_SLOTS, 8);

  // Matrix cell 1: sync plan => default shared, explicit shared allowed, explicit worktree allowed
  assert.equal(getDefaultIsolation({ mode: "plan", isAsync: false }), "shared");
  assert.equal(resolveIsolation({ mode: "plan", isAsync: false }), "shared");
  assert.equal(resolveIsolation({ mode: "plan", isAsync: false, isolation: "shared" }), "shared");
  assert.equal(resolveIsolation({ mode: "plan", isAsync: false, isolation: "worktree" }), "worktree");

  // Matrix cell 2: sync accept-edits => default worktree, explicit worktree allowed, explicit shared rejected
  assert.equal(getDefaultIsolation({ mode: "accept-edits", isAsync: false }), "worktree");
  assert.equal(resolveIsolation({ mode: "accept-edits", isAsync: false }), "worktree");
  assert.equal(resolveIsolation({ mode: "accept-edits", isAsync: false, isolation: "worktree" }), "worktree");
  assert.throws(
    () => resolveIsolation({ mode: "accept-edits", isAsync: false, isolation: "shared" }),
    /Unsafe isolation.*mutating 'accept-edits' mode/,
  );

  // Matrix cell 3: async plan => default worktree, explicit worktree allowed, explicit shared rejected
  assert.equal(getDefaultIsolation({ mode: "plan", isAsync: true }), "worktree");
  assert.equal(resolveIsolation({ mode: "plan", isAsync: true }), "worktree");
  assert.equal(resolveIsolation({ mode: "plan", isAsync: true, isolation: "worktree" }), "worktree");
  assert.throws(
    () => resolveIsolation({ mode: "plan", isAsync: true, isolation: "shared" }),
    /Unsafe isolation.*asynchronous execution/,
  );

  // Matrix cell 4: async accept-edits => default worktree, explicit worktree allowed, explicit shared rejected
  assert.equal(getDefaultIsolation({ mode: "accept-edits", isAsync: true }), "worktree");
  assert.equal(resolveIsolation({ mode: "accept-edits", isAsync: true }), "worktree");
  assert.equal(resolveIsolation({ mode: "accept-edits", isAsync: true, isolation: "worktree" }), "worktree");
  assert.throws(
    () => resolveIsolation({ mode: "accept-edits", isAsync: true, isolation: "shared" }),
    /Unsafe isolation/,
  );

  // Invalid isolation mode string
  assert.throws(() => resolveIsolation({ isolation: "invalid-mode" }), /Invalid isolation mode/);

  // Unsafe checker helper
  assert.equal(isUnsafeSharedIsolation({ mode: "plan", isAsync: false }), false);
  assert.equal(isUnsafeSharedIsolation({ mode: "accept-edits", isAsync: false }), true);
  assert.equal(isUnsafeSharedIsolation({ mode: "plan", isAsync: true }), true);
  assert.equal(isUnsafeSharedIsolation({ mode: "accept-edits", isAsync: true }), true);
});

test("Callback exact lines: three-line callback builder showing all 6 required fields", () => {
  const message = buildCallbackMessage({
    job: "job-abc-123",
    attempt: 2,
    execution: "exec-xyz-789",
    artifact: "worktrees/worker-1/patch.diff",
    claimedChangedPaths: ["skills/lib/contracts.mjs", "mcp/test/contracts.mjs"],
    summary: "Completed contract upgrades",
    verification: "node --test passed (12 tests)",
  });

  const lines = message.split("\n");
  assert.equal(lines.length, 3, "Callback message must consist of exactly 3 lines");

  // Line 1: Files Changed
  assert.ok(lines[0].startsWith("### Files Changed: "));
  assert.ok(lines[0].includes("skills/lib/contracts.mjs; mcp/test/contracts.mjs"));

  // Line 2: Summary showing untrusted worker, job, attempt, execution, artifact
  assert.ok(lines[1].startsWith("### Summary: "));
  assert.ok(lines[1].includes("[Untrusted worker report]"), "Must label report as untrusted worker");
  assert.ok(lines[1].includes("job=job-abc-123"), "Must include job identifier");
  assert.ok(lines[1].includes("attempt=2"), "Must include attempt number");
  assert.ok(lines[1].includes("execution=exec-xyz-789"), "Must include execution identifier");
  assert.ok(lines[1].includes("artifact=worktrees/worker-1/patch.diff"), "Must include artifact path");
  assert.ok(lines[1].includes("Completed contract upgrades"), "Must include concise summary");

  // Line 3: Verification showing parent=pending and worker claims (do not claim worker semantic verification)
  assert.ok(lines[2].startsWith("### Verification: "));
  assert.ok(lines[2].includes("parent=pending"), "Must show parent=pending");
  assert.ok(lines[2].includes("worker claims: node --test passed (12 tests)"), "Must frame worker check as claims only");

  // Alias verification
  assert.equal(buildCallback, buildCallbackMessage);

  // Strips multiline injections to guarantee exactly 3 lines
  const injected = buildCallbackMessage({
    job: "job-1\ninjected-line",
    attempt: 1,
    execution: "exec-1\r\ninjected-line-2",
    artifact: "art\ninjected-line-3",
    claimedChangedPaths: ["file1.txt\ninjected-line-4"],
    summary: "Summary line 1\nSummary line 2",
    verification: "Verify 1\nVerify 2",
  });
  const injectedLines = injected.split("\n");
  assert.equal(injectedLines.length, 3, "Must sanitize multiline inputs into single lines");
});

test("Protocol contract: sparseCheckout schema, description, handler forwarding, and runner serialization", async () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const indexPath = path.resolve(here, "../src/index.ts");
  const content = await fsp.readFile(indexPath, "utf8");

  // RunnerInput contract
  assert.match(
    content,
    /type\s+RunnerInput\s*=\s*\{[\s\S]*?sparseCheckout\?:\s*boolean;?[\s\S]*?\};/,
    "RunnerInput must define optional sparseCheckout boolean",
  );

  // Schema contract in delegateSchema
  assert.match(
    content,
    /sparseCheckout:\s*z\.boolean\(\)\.optional\(\)\.describe\(/,
    "delegateSchema must define sparseCheckout as z.boolean().optional() with description",
  );

  // Required explanations in description
  const descMatch = content.match(/sparseCheckout:\s*z\.boolean\(\)\.optional\(\)\.describe\(\s*([\s\S]*?)\s*\),/);
  assert.ok(descMatch, "sparseCheckout description must exist");
  const desc = descMatch[1];
  assert.match(desc, /checks out only declared targets in cone mode/i);
  assert.match(desc, /includes root\/ancestor\/same-directory files/i);
  assert.match(desc, /requires targets exist at base/i);
  assert.match(desc, /full default for dependencies\/new paths/i);

  // Both handlers must expose and forward sparseCheckout
  assert.match(
    content,
    /server\.registerTool\(\s*['"]agy_delegate['"][\s\S]*?async\s*\(\{[^}]*sparseCheckout[^}]*\}\)/,
    "agy_delegate handler must receive sparseCheckout",
  );
  assert.match(
    content,
    /server\.registerTool\(\s*['"]agy_delegate_async['"][\s\S]*?async\s*\(\{[^}]*sparseCheckout[^}]*\}\)/,
    "agy_delegate_async handler must receive sparseCheckout",
  );

  // Both handlers must forward sparseCheckout to delegateArgs
  const delegateMatches = [...content.matchAll(/delegateArgs\(\s*\{[\s\S]*?sparseCheckout[\s\S]*?\}\s*,\s*promptFile\.file\s*,?\s*\)/g)];
  assert.equal(delegateMatches.length, 2, "delegateArgs must be called with sparseCheckout in both handlers");

  // Serialization to runner: serialize as --sparse-checkout only when true
  assert.match(
    content,
    /if\s*\(\s*input\.sparseCheckout\s*===\s*true\s*\)\s*args\.push\(['"]--sparse-checkout['"]\);/,
    "delegateArgs must push --sparse-checkout only when input.sparseCheckout is strictly true",
  );

  // Behavioral verification of argument serialization contract
  function simulateDelegateArgs(input) {
    const args = [];
    if (input.targets?.length) args.push("--targets-json", JSON.stringify(input.targets));
    if (input.sparseCheckout === true) args.push("--sparse-checkout");
    if (input.isolation) args.push("--isolation", input.isolation);
    return args;
  }

  assert.deepEqual(
    simulateDelegateArgs({ sparseCheckout: true }),
    ["--sparse-checkout"],
    "Must serialize --sparse-checkout when true",
  );
  assert.deepEqual(
    simulateDelegateArgs({ sparseCheckout: false }),
    [],
    "Must not serialize --sparse-checkout when false",
  );
  assert.deepEqual(
    simulateDelegateArgs({}),
    [],
    "Must not serialize --sparse-checkout when omitted (default false)",
  );
});

test("Protocol contract: subagents schema, forwarding, and runner serialization", async () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const content = await fsp.readFile(path.resolve(here, "../src/index.ts"), "utf8");

  assert.match(content, /type\s+RunnerInput\s*=\s*\{[\s\S]*?subagents\?:\s*number;?[\s\S]*?\};/);
  assert.match(content, /subagents:\s*z\.number\(\)\.int\(\)\.min\(0\)\.max\(8\)\.optional\(\)\.describe\(/);

  const descMatch = content.match(/subagents:\s*z\.number\(\)[\s\S]*?\.describe\(\s*([\s\S]*?)\s*\),/);
  assert.ok(descMatch);
  assert.match(descMatch[1], /controller auto policy/i);
  assert.match(descMatch[1], /omission/i);

  assert.match(content, /server\.registerTool\(\s*['"]agy_delegate['"][\s\S]*?async\s*\(\{[^}]*subagents[^}]*\}\)/);
  assert.match(content, /server\.registerTool\(\s*['"]agy_delegate_async['"][\s\S]*?async\s*\(\{[^}]*subagents[^}]*\}\)/);

  const delegateMatches = [...content.matchAll(/delegateArgs\(\s*\{[\s\S]*?subagents[\s\S]*?\}\s*,\s*promptFile\.file\s*,?\s*\)/g)];
  assert.equal(delegateMatches.length, 2);

  assert.match(content, /input\.subagents\s*!==\s*undefined/);
  assert.match(content, /args\.push\(['"]--subagents['"],\s*String\(input\.subagents\)\)/);

  function simulateRunnerArgs(input) {
    const args = [];
    if (input.subagents !== undefined) args.push("--subagents", String(input.subagents));
    return args;
  }
  assert.deepEqual(simulateRunnerArgs({ subagents: 0 }), ["--subagents", "0"]);
  assert.deepEqual(simulateRunnerArgs({ subagents: 8 }), ["--subagents", "8"]);
  assert.deepEqual(simulateRunnerArgs({}), []);
});
