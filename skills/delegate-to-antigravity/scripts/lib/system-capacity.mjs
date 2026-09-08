import os from "node:os";

export const DEFAULT_MIN_WORKERS = 1;
export const DEFAULT_MAX_WORKERS = 8;
export const DEFAULT_WORKER_MEMORY_MB = 1536; // 1.5 GiB
export const DEFAULT_CPU_HIGH_PERCENT = 90;
export const GIB_IN_BYTES = 1024 * 1024 * 1024;
export const MIB_IN_BYTES = 1024 * 1024;

function parseInteger(val, name, min, max) {
  if (val === undefined || val === null || val === "") return undefined;
  const str = String(val).trim();
  if (!/^[+-]?\d+$/.test(str)) throw new Error(`Invalid ${name}: "${val}" is not an integer`);
  const num = Number(str);
  if ((min !== undefined && num < min) || (max !== undefined && num > max)) {
    throw new Error(`Invalid ${name}: ${num} out of bounds [${min ?? "-inf"}, ${max ?? "inf"}]`);
  }
  return num;
}

function parseNumber(val, name, min, max) {
  if (val === undefined || val === null || val === "") return undefined;
  const num = Number(String(val).trim());
  if (!Number.isFinite(num) || (min !== undefined && num < min) || (max !== undefined && num > max)) {
    throw new Error(`Invalid ${name}: ${val} is not a valid number`);
  }
  return num;
}

function normalizeCpuSnapshot(snap) {
  if (typeof snap === "number") return { ratio: snap };
  if (Array.isArray(snap)) {
    let idle = 0, total = 0;
    for (const cpu of snap) {
      const times = cpu?.times || {};
      for (const k of Object.keys(times)) total += times[k];
      idle += times.idle || 0;
    }
    return { idle, total };
  }
  if (snap && typeof snap === "object") {
    if (snap.idle !== undefined && snap.total !== undefined) return snap;
    if (snap.user !== undefined && snap.idle !== undefined) {
      let total = 0;
      for (const k of Object.keys(snap)) total += Number(snap[k]) || 0;
      return { idle: snap.idle, total };
    }
  }
  return { idle: 0, total: 0 };
}

function calcCpuRatio(s1, s2) {
  const norm1 = normalizeCpuSnapshot(s1);
  const norm2 = normalizeCpuSnapshot(s2);
  if (norm2.ratio !== undefined) return norm2.ratio;
  if (norm1.ratio !== undefined) return norm1.ratio;
  const deltaTotal = norm2.total - norm1.total;
  const deltaIdle = norm2.idle - norm1.idle;
  if (deltaTotal <= 0) return 0;
  const ratio = Math.max(0, Math.min(1, 1 - deltaIdle / deltaTotal));
  return Math.round(ratio * 10000) / 10000;
}

function readCpuSnapshot(osMod) {
  const cpus = osMod?.cpus ? osMod.cpus() : [];
  let idle = 0, total = 0;
  for (const cpu of cpus) {
    const times = cpu?.times || {};
    for (const k of Object.keys(times)) total += times[k];
    idle += times.idle || 0;
  }
  return { idle, total };
}

export async function sampleSystemCapacity(options = {}) {
  const osMod = options.os ?? os;
  const delayMs = options.delayMs ?? 100;
  const delayFn = options.delay ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

  let cpuUtilizationRatio;
  if (typeof options.cpuUtilizationRatio === "number") {
    cpuUtilizationRatio = Math.max(0, Math.min(1, options.cpuUtilizationRatio));
  } else if (Array.isArray(options.cpuSamples) && options.cpuSamples.length >= 2) {
    cpuUtilizationRatio = calcCpuRatio(options.cpuSamples[0], options.cpuSamples[1]);
  } else if (Array.isArray(options.cpuSnapshots) && options.cpuSnapshots.length >= 2) {
    cpuUtilizationRatio = calcCpuRatio(options.cpuSnapshots[0], options.cpuSnapshots[1]);
  } else {
    const snap1 = readCpuSnapshot(osMod);
    await delayFn(delayMs);
    const snap2 = readCpuSnapshot(osMod);
    cpuUtilizationRatio = calcCpuRatio(snap1, snap2);
  }

  const logicalCpuCount = options.logicalCpuCount ?? (osMod.availableParallelism ? osMod.availableParallelism() : (osMod.cpus?.()?.length ?? 1));
  const totalMemoryBytes = options.totalMemoryBytes ?? (osMod.totalmem ? osMod.totalmem() : 0);
  const freeMemoryBytes = options.freeMemoryBytes ?? (osMod.freemem ? osMod.freemem() : 0);
  const freeMemoryRatio = totalMemoryBytes > 0 ? Math.round((freeMemoryBytes / totalMemoryBytes) * 10000) / 10000 : 0;

  return {
    logicalCpuCount: Number(logicalCpuCount),
    totalMemoryBytes: Number(totalMemoryBytes),
    freeMemoryBytes: Number(freeMemoryBytes),
    freeMemoryRatio,
    cpuUtilizationRatio,
  };
}

export function recommendWorkerCapacity(sample, options = {}) {
  const env = options.env ?? process.env;
  const fixedSlots = parseInteger(env.AGY_WORKER_SLOTS, "AGY_WORKER_SLOTS", 1, 8) ?? parseInteger(options.workerSlots, "workerSlots", 1, 8);
  const envMin = parseInteger(env.AGY_WORKER_MIN, "AGY_WORKER_MIN", 1);
  const optMin = parseInteger(options.minWorkers, "minWorkers", 1);
  let minWorkers = envMin ?? optMin ?? DEFAULT_MIN_WORKERS;

  const envMax = parseInteger(env.AGY_WORKER_MAX, "AGY_WORKER_MAX", 1);
  const optMax = parseInteger(options.maxWorkers, "maxWorkers", 1);
  let maxWorkers = envMax ?? optMax ?? DEFAULT_MAX_WORKERS;

  if (fixedSlots !== undefined) {
    if ((envMin !== undefined && envMin > fixedSlots) || (optMin !== undefined && optMin > fixedSlots)) {
      throw new Error(`Ambiguous bounds: minWorkers exceeds fixed slots (${fixedSlots})`);
    }
    if ((envMax !== undefined && envMax < fixedSlots) || (optMax !== undefined && optMax < fixedSlots)) {
      throw new Error(`Ambiguous bounds: maxWorkers is less than fixed slots (${fixedSlots})`);
    }
    minWorkers = fixedSlots;
    maxWorkers = fixedSlots;
  }
  if (minWorkers > maxWorkers) {
    throw new Error(`Invalid bounds: minWorkers (${minWorkers}) exceeds maxWorkers (${maxWorkers})`);
  }

  const workerMemoryMb = parseNumber(env.AGY_WORKER_MEMORY_MB, "AGY_WORKER_MEMORY_MB", 1) ?? parseNumber(options.workerMemoryMb, "workerMemoryMb", 1) ?? DEFAULT_WORKER_MEMORY_MB;
  const workerMemoryBytes = Math.round(workerMemoryMb * MIB_IN_BYTES);
  const cpuHighPercent = parseNumber(env.AGY_WORKER_CPU_HIGH_PERCENT, "AGY_WORKER_CPU_HIGH_PERCENT", 0, 100) ?? parseNumber(options.cpuHighPercent, "cpuHighPercent", 0, 100) ?? DEFAULT_CPU_HIGH_PERCENT;
  const cpuHighRatio = cpuHighPercent / 100;
  const activeWorkers = parseInteger(options.activeWorkers ?? 0, "activeWorkers", 0) ?? 0;

  const logicalCpuCount = Number(sample?.logicalCpuCount ?? 1);
  const totalMemoryBytes = Number(sample?.totalMemoryBytes ?? 0);
  const freeMemoryBytes = Number(sample?.freeMemoryBytes ?? 0);
  const freeMemoryRatio = typeof sample?.freeMemoryRatio === "number"
    ? sample.freeMemoryRatio
    : (totalMemoryBytes > 0 ? Math.round((freeMemoryBytes / totalMemoryBytes) * 10000) / 10000 : 0);
  const cpuUtilizationRatio = Number(sample?.cpuUtilizationRatio ?? 0);

  const cpuSlots = logicalCpuCount > 1 ? logicalCpuCount - 1 : 1;
  const reservedMemoryBytes = Math.max(GIB_IN_BYTES, Math.floor(totalMemoryBytes * 0.10));
  const availableMemoryBytes = Math.max(0, totalMemoryBytes - reservedMemoryBytes);
  const memSlots = Math.floor(availableMemoryBytes / workerMemoryBytes);

  const freeAfterReserve = freeMemoryBytes - reservedMemoryBytes;
  const insufficientMemory = freeMemoryBytes < reservedMemoryBytes || freeAfterReserve < workerMemoryBytes;
  const cpuSaturated = cpuUtilizationRatio >= cpuHighRatio;

  let recommendedSlots;
  let limitedBy;

  if (cpuSaturated || insufficientMemory) {
    if (activeWorkers > maxWorkers) {
      recommendedSlots = maxWorkers;
      limitedBy = "max";
    } else {
      recommendedSlots = activeWorkers;
      limitedBy = cpuSaturated ? "cpu" : "memory";
    }
  } else if (fixedSlots !== undefined) {
    if (activeWorkers > maxWorkers) {
      recommendedSlots = maxWorkers;
      limitedBy = "max";
    } else {
      recommendedSlots = Math.max(fixedSlots, activeWorkers);
      limitedBy = recommendedSlots > fixedSlots ? "active_workers" : "slots";
    }
  } else {
    let baseSlots = cpuSlots <= memSlots ? cpuSlots : memSlots;
    let baseLimiter = cpuSlots <= memSlots ? "cpu" : "memory";

    if (baseSlots > maxWorkers) {
      baseSlots = maxWorkers;
      baseLimiter = "max";
    } else if (baseSlots < minWorkers) {
      baseSlots = minWorkers;
      baseLimiter = "min";
    }

    if (activeWorkers > maxWorkers) {
      recommendedSlots = maxWorkers;
      limitedBy = "max";
    } else if (activeWorkers > baseSlots) {
      recommendedSlots = activeWorkers;
      limitedBy = "active_workers";
    } else {
      recommendedSlots = baseSlots;
      limitedBy = baseLimiter;
    }
  }

  const availableSlots = Math.max(0, recommendedSlots - activeWorkers);

  return {
    logicalCpuCount,
    totalMemoryBytes,
    freeMemoryBytes,
    freeMemoryRatio,
    cpuUtilizationRatio,
    activeWorkers,
    recommendedSlots,
    availableSlots,
    limitedBy,
  };
}
