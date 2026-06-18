/**
 * Per-process tree CPU% / memory, Linux /proc based.
 *
 * CPU% is delta-sampled: the first call for a pid reports average-since-start
 * (an estimate), subsequent calls report (Δticks / Δwall) over the previous
 * sample. Call `resetCpuSampler()` at the start of a fresh one-shot or watch
 * session. Memory is the sum of VmRSS across the process tree.
 */
import { readFileSync, readdirSync } from "fs";
import { buildChildMap, parseProcStat } from "./processMap.js";

export interface ProcessTreeMetrics {
  pids: number[];
  cpuPct: number;
  memKb: number;
}

const CLK_TCK = 100; // Linux sysconf(_SC_CLK_TCK); effectively always 100.

interface Sample {
  ticks: number;
  wallS: number;
}
const prevSample = new Map<number, Sample>();

let childCache: { expiresAt: number; map: Map<number, number[]> } | null = null;
const CHILD_CACHE_TTL_MS = 1000;

function readUptime(): number {
  try {
    const first = readFileSync("/proc/uptime", "utf-8").split(/\s+/)[0];
    return Number(first) || 0;
  } catch {
    return 0;
  }
}

function readVmRssKb(pid: number): number {
  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf-8");
    const m = status.match(/^VmRSS:\s*(\d+)\s*kB/m);
    return m ? Number(m[1]) : 0;
  } catch {
    return 0;
  }
}

function readTicksAndStart(pid: number): { ticks: number; starttime: number } {
  try {
    const stat = parseProcStat(readFileSync(`/proc/${pid}/stat`, "utf-8"));
    if (!stat) return { ticks: 0, starttime: 0 };
    return { ticks: stat.utime + stat.stime, starttime: stat.starttime };
  } catch {
    return { ticks: 0, starttime: 0 };
  }
}

/** Cached child map so multiple calls within one monitor tick share a scan. */
function getCachedChildMap(): Map<number, number[]> {
  const now = Date.now();
  if (childCache && childCache.expiresAt > now) return childCache.map;
  const map = buildChildMap();
  childCache = { expiresAt: now + CHILD_CACHE_TTL_MS, map };
  return map;
}

function collectTree(rootPid: number, childMap: Map<number, number[]>): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  const queue = [rootPid];
  while (queue.length > 0) {
    const pid = queue.shift()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    out.push(pid);
    const children = childMap.get(pid);
    if (children) for (const c of children) if (!seen.has(c)) queue.push(c);
  }
  return out;
}

function averageSinceStart(rootPid: number, totalTicks: number, now: number): number {
  const { starttime } = readTicksAndStart(rootPid);
  if (!starttime) return 0;
  const elapsedS = now - starttime / CLK_TCK;
  if (elapsedS <= 0) return 0;
  return (totalTicks / CLK_TCK) / elapsedS * 100;
}

/**
 * CPU% and RSS for the process tree rooted at `rootPid`. Linux-only; returns
 * zeroes elsewhere. CPU% is delta-sampled across calls.
 */
export function getProcessTreeMetrics(rootPid: number): ProcessTreeMetrics {
  if (process.platform !== "linux") return { pids: [], cpuPct: 0, memKb: 0 };
  if (!Number.isFinite(rootPid) || rootPid <= 0) return { pids: [], cpuPct: 0, memKb: 0 };

  const childMap = getCachedChildMap();
  const pids = collectTree(rootPid, childMap);
  let totalTicks = 0;
  let totalMem = 0;
  for (const pid of pids) {
    totalTicks += readTicksAndStart(pid).ticks;
    totalMem += readVmRssKb(pid);
  }

  const now = readUptime();
  const prev = prevSample.get(rootPid);
  let cpuPct: number;
  if (prev && now > prev.wallS) {
    const dTicks = totalTicks - prev.ticks;
    cpuPct = (dTicks / CLK_TCK) / (now - prev.wallS) * 100;
  } else {
    cpuPct = averageSinceStart(rootPid, totalTicks, now);
  }
  if (!Number.isFinite(cpuPct) || cpuPct < 0) cpuPct = 0;

  prevSample.set(rootPid, { ticks: totalTicks, wallS: now });
  return { pids, cpuPct, memKb: totalMem };
}

/** Clear delta-sampling state (call at the start of a fresh one-shot/watch run). */
export function resetCpuSampler(): void {
  prevSample.clear();
  childCache = null;
}
