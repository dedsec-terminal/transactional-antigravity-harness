import test from "node:test";
import assert from "node:assert/strict";
import {
  sampleSystemCapacity,
  recommendWorkerCapacity,
  GIB_IN_BYTES,
} from "../../skills/delegate-to-antigravity/scripts/lib/system-capacity.mjs";

test("sampleSystemCapacity: samples logical CPU, memory, and CPU utilization without per-core arrays", async () => {
  const mockOs = {
    cpus: () => [
      { times: { user: 100, nice: 0, sys: 50, idle: 850, irq: 0 } },
      { times: { user: 100, nice: 0, sys: 50, idle: 850, irq: 0 } },
    ],
    totalmem: () => 16 * GIB_IN_BYTES,
    freemem: () => 8 * GIB_IN_BYTES,
    availableParallelism: () => 2,
  };
  let delayedMs = 0;
  const sample = await sampleSystemCapacity({
    os: mockOs,
    delayMs: 50,
    delay: async (ms) => { delayedMs = ms; },
  });

  assert.equal(delayedMs, 50);
  assert.equal(sample.logicalCpuCount, 2);
  assert.equal(sample.totalMemoryBytes, 16 * GIB_IN_BYTES);
  assert.equal(sample.freeMemoryBytes, 8 * GIB_IN_BYTES);
  assert.equal(sample.freeMemoryRatio, 0.5);
  assert.equal(typeof sample.cpuUtilizationRatio, "number");
  assert.equal("cpus" in sample, false, "Must not return raw per-core arrays");
});

test("sampleSystemCapacity: uses injected cpuSamples and direct overrides", async () => {
  const sample = await sampleSystemCapacity({
    logicalCpuCount: 4,
    totalMemoryBytes: 8 * GIB_IN_BYTES,
    freeMemoryBytes: 4 * GIB_IN_BYTES,
    cpuSamples: [
      { idle: 800, total: 1000 },
      { idle: 850, total: 1200 },
    ],
  });
  assert.equal(sample.logicalCpuCount, 4);
  assert.equal(sample.cpuUtilizationRatio, 0.75);
  assert.equal(sample.freeMemoryRatio, 0.5);
  assert.equal("cpus" in sample, false);
});

test("recommendWorkerCapacity: defaults, CPU reservation, and memory-based sizing", () => {
  const sample = {
    logicalCpuCount: 8,
    totalMemoryBytes: 16 * GIB_IN_BYTES,
    freeMemoryBytes: 14 * GIB_IN_BYTES,
    cpuUtilizationRatio: 0.2,
  };
  const rec = recommendWorkerCapacity(sample, { env: {} });
  assert.equal(rec.logicalCpuCount, 8);
  assert.equal(rec.totalMemoryBytes, 16 * GIB_IN_BYTES);
  assert.equal(rec.freeMemoryBytes, 14 * GIB_IN_BYTES);
  assert.equal(rec.freeMemoryRatio, 0.875);
  assert.equal(rec.cpuUtilizationRatio, 0.2);
  assert.equal(rec.activeWorkers, 0);
  assert.equal(rec.recommendedSlots, 7);
  assert.equal(rec.availableSlots, 7);
  assert.equal(rec.limitedBy, "cpu");
});

test("recommendWorkerCapacity: memory constrained host", () => {
  const sample = {
    logicalCpuCount: 16,
    totalMemoryBytes: 4 * GIB_IN_BYTES,
    freeMemoryBytes: 3 * GIB_IN_BYTES,
    cpuUtilizationRatio: 0.1,
  };
  const rec = recommendWorkerCapacity(sample, { env: {} });
  assert.equal(rec.recommendedSlots, 1);
  assert.equal(rec.availableSlots, 1);
  assert.equal(rec.limitedBy, "memory");
});

test("recommendWorkerCapacity: capped by default max 8", () => {
  const sample = {
    logicalCpuCount: 32,
    totalMemoryBytes: 64 * GIB_IN_BYTES,
    freeMemoryBytes: 40 * GIB_IN_BYTES,
    cpuUtilizationRatio: 0.1,
  };
  const rec = recommendWorkerCapacity(sample, { env: {} });
  assert.equal(rec.recommendedSlots, 8);
  assert.equal(rec.limitedBy, "max");
});

test("recommendWorkerCapacity: 1-CPU host reserves where possible without dropping below 1", () => {
  const sample = {
    logicalCpuCount: 1,
    totalMemoryBytes: 8 * GIB_IN_BYTES,
    freeMemoryBytes: 6 * GIB_IN_BYTES,
    cpuUtilizationRatio: 0.1,
  };
  const rec = recommendWorkerCapacity(sample, { env: {} });
  assert.equal(rec.recommendedSlots, 1);
  assert.equal(rec.limitedBy, "cpu");
});

test("recommendWorkerCapacity: new admission is zero under >=90% CPU", () => {
  const sample = {
    logicalCpuCount: 8,
    totalMemoryBytes: 16 * GIB_IN_BYTES,
    freeMemoryBytes: 10 * GIB_IN_BYTES,
    cpuUtilizationRatio: 0.92,
  };
  const recActive = recommendWorkerCapacity(sample, { env: {}, activeWorkers: 2 });
  assert.equal(recActive.recommendedSlots, 2);
  assert.equal(recActive.availableSlots, 0);
  assert.equal(recActive.limitedBy, "cpu");

  const recZero = recommendWorkerCapacity(sample, { env: {}, activeWorkers: 0 });
  assert.equal(recZero.recommendedSlots, 0);
  assert.equal(recZero.availableSlots, 0);
  assert.equal(recZero.limitedBy, "cpu");
});

test("recommendWorkerCapacity: new admission is zero under insufficient memory", () => {
  const sample = {
    logicalCpuCount: 8,
    totalMemoryBytes: 16 * GIB_IN_BYTES,
    freeMemoryBytes: 1.2 * GIB_IN_BYTES,
    cpuUtilizationRatio: 0.2,
  };
  const rec = recommendWorkerCapacity(sample, { env: {}, activeWorkers: 1 });
  assert.equal(rec.recommendedSlots, 1);
  assert.equal(rec.availableSlots, 0);
  assert.equal(rec.limitedBy, "memory");
});

test("recommendWorkerCapacity: never recommend below activeWorkers unless exceeding hard max", () => {
  const sample = {
    logicalCpuCount: 4,
    totalMemoryBytes: 8 * GIB_IN_BYTES,
    freeMemoryBytes: 6 * GIB_IN_BYTES,
    cpuUtilizationRatio: 0.2,
  };
  const rec1 = recommendWorkerCapacity(sample, { env: {}, activeWorkers: 4 });
  assert.equal(rec1.recommendedSlots, 4);
  assert.equal(rec1.availableSlots, 0);
  assert.equal(rec1.limitedBy, "active_workers");

  const rec2 = recommendWorkerCapacity(sample, { env: {}, activeWorkers: 10 });
  assert.equal(rec2.recommendedSlots, 8);
  assert.equal(rec2.availableSlots, 0);
  assert.equal(rec2.limitedBy, "max");
});

test("recommendWorkerCapacity: supports validated env overrides", () => {
  const sample = {
    logicalCpuCount: 16,
    totalMemoryBytes: 32 * GIB_IN_BYTES,
    freeMemoryBytes: 20 * GIB_IN_BYTES,
    cpuUtilizationRatio: 0.2,
  };

  const recFixed = recommendWorkerCapacity(sample, {
    env: { AGY_WORKER_SLOTS: "5" },
    activeWorkers: 2,
  });
  assert.equal(recFixed.recommendedSlots, 5);
  assert.equal(recFixed.availableSlots, 3);
  assert.equal(recFixed.limitedBy, "slots");

  const recCustom = recommendWorkerCapacity(sample, {
    env: {
      AGY_WORKER_MIN: "2",
      AGY_WORKER_MAX: "4",
      AGY_WORKER_MEMORY_MB: "1024",
      AGY_WORKER_CPU_HIGH_PERCENT: "80",
    },
  });
  assert.equal(recCustom.recommendedSlots, 4);
  assert.equal(recCustom.limitedBy, "max");

  const recHigh = recommendWorkerCapacity(
    { ...sample, cpuUtilizationRatio: 0.85 },
    { env: { AGY_WORKER_CPU_HIGH_PERCENT: "80" }, activeWorkers: 1 }
  );
  assert.equal(recHigh.recommendedSlots, 1);
  assert.equal(recHigh.availableSlots, 0);
  assert.equal(recHigh.limitedBy, "cpu");
});

test("recommendWorkerCapacity: rejects invalid and ambiguous bounds", () => {
  const sample = {
    logicalCpuCount: 4,
    totalMemoryBytes: 8 * GIB_IN_BYTES,
    freeMemoryBytes: 4 * GIB_IN_BYTES,
    cpuUtilizationRatio: 0.1,
  };

  assert.throws(() => recommendWorkerCapacity(sample, { env: { AGY_WORKER_SLOTS: "0" } }));
  assert.throws(() => recommendWorkerCapacity(sample, { env: { AGY_WORKER_SLOTS: "9" } }));
  assert.throws(() => recommendWorkerCapacity(sample, { env: { AGY_WORKER_SLOTS: "invalid" } }));

  assert.throws(() => recommendWorkerCapacity(sample, { env: { AGY_WORKER_MIN: "6", AGY_WORKER_MAX: "4" } }));
  assert.throws(() => recommendWorkerCapacity(sample, { env: { AGY_WORKER_SLOTS: "3", AGY_WORKER_MIN: "5" } }));
  assert.throws(() => recommendWorkerCapacity(sample, { env: { AGY_WORKER_SLOTS: "3", AGY_WORKER_MAX: "2" } }));

  assert.throws(() => recommendWorkerCapacity(sample, { env: { AGY_WORKER_MEMORY_MB: "-100" } }));
  assert.throws(() => recommendWorkerCapacity(sample, { env: { AGY_WORKER_CPU_HIGH_PERCENT: "150" } }));
  assert.throws(() => recommendWorkerCapacity(sample, { activeWorkers: -1 }));
});

test("recommendWorkerCapacity: regression - sizes memory slots from free memory on 64GiB host with 10GiB free", () => {
  const sample = {
    logicalCpuCount: 16,
    totalMemoryBytes: 64 * GIB_IN_BYTES,
    freeMemoryBytes: 10 * GIB_IN_BYTES,
    cpuUtilizationRatio: 0.2,
  };
  const rec = recommendWorkerCapacity(sample, { env: {} });
  assert.equal(rec.recommendedSlots, 2);
  assert.equal(rec.availableSlots, 2);
  assert.equal(rec.limitedBy, "memory");
});

test("recommendWorkerCapacity: enforces hard cap 8 on env and option min/max/fixed values (>8)", () => {
  const sample = {
    logicalCpuCount: 8,
    totalMemoryBytes: 16 * GIB_IN_BYTES,
    freeMemoryBytes: 14 * GIB_IN_BYTES,
    cpuUtilizationRatio: 0.1,
  };

  assert.throws(() => recommendWorkerCapacity(sample, { maxWorkers: 9 }));
  assert.throws(() => recommendWorkerCapacity(sample, { minWorkers: 9 }));
  assert.throws(() => recommendWorkerCapacity(sample, { workerSlots: 9 }));
  assert.throws(() => recommendWorkerCapacity(sample, { env: { AGY_WORKER_MAX: "9" } }));
  assert.throws(() => recommendWorkerCapacity(sample, { env: { AGY_WORKER_MIN: "9" } }));
  assert.throws(() => recommendWorkerCapacity(sample, { env: { AGY_WORKER_SLOTS: "9" } }));
  assert.throws(() => recommendWorkerCapacity(sample, { env: { AGY_WORKER_MAX: "12" } }));
  assert.throws(() => recommendWorkerCapacity(sample, { env: { AGY_WORKER_MIN: "10" } }));
});

test("recommendWorkerCapacity: rejects malformed sample and invalid threshold", () => {
  const validSample = {
    logicalCpuCount: 4,
    totalMemoryBytes: 8 * GIB_IN_BYTES,
    freeMemoryBytes: 4 * GIB_IN_BYTES,
    cpuUtilizationRatio: 0.2,
  };

  assert.throws(() => recommendWorkerCapacity(null));
  assert.throws(() => recommendWorkerCapacity(undefined));
  assert.throws(() => recommendWorkerCapacity("invalid"));
  assert.throws(() => recommendWorkerCapacity({ ...validSample, logicalCpuCount: 0 }));
  assert.throws(() => recommendWorkerCapacity({ ...validSample, logicalCpuCount: -1 }));
  assert.throws(() => recommendWorkerCapacity({ ...validSample, logicalCpuCount: 2.5 }));
  assert.throws(() => recommendWorkerCapacity({ ...validSample, logicalCpuCount: "4" }));
  assert.throws(() => recommendWorkerCapacity({ ...validSample, totalMemoryBytes: -1 }));
  assert.throws(() => recommendWorkerCapacity({ ...validSample, totalMemoryBytes: Infinity }));
  assert.throws(() => recommendWorkerCapacity({ ...validSample, freeMemoryBytes: -1 }));
  assert.throws(() => recommendWorkerCapacity({ ...validSample, freeMemoryBytes: 10 * GIB_IN_BYTES, totalMemoryBytes: 8 * GIB_IN_BYTES }));
  assert.throws(() => recommendWorkerCapacity({ ...validSample, cpuUtilizationRatio: -0.1 }));
  assert.throws(() => recommendWorkerCapacity({ ...validSample, cpuUtilizationRatio: 1.05 }));

  assert.throws(() => recommendWorkerCapacity(validSample, { cpuHighPercent: 0 }));
  assert.throws(() => recommendWorkerCapacity(validSample, { cpuHighPercent: -5 }));
  assert.throws(() => recommendWorkerCapacity(validSample, { cpuHighPercent: 101 }));
  assert.throws(() => recommendWorkerCapacity(validSample, { threshold: 0 }));
  assert.throws(() => recommendWorkerCapacity(validSample, { threshold: 101 }));
  assert.throws(() => recommendWorkerCapacity(validSample, { env: { AGY_WORKER_CPU_HIGH_PERCENT: "0" } }));
});
