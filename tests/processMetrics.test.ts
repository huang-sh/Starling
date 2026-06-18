import { describe, expect, it } from "vitest";
import { getProcessTreeMetrics, resetCpuSampler } from "../src/lib/processMetrics.js";

describe("processMetrics getProcessTreeMetrics", () => {
  it("returns a well-formed metrics object for the current process", () => {
    resetCpuSampler();
    const m = getProcessTreeMetrics(process.pid);
    expect(m).toBeInstanceOf(Object);
    expect(Array.isArray(m.pids)).toBe(true);
    expect(m.pids.length).toBeGreaterThanOrEqual(1);
    expect(m.pids[0]).toBe(process.pid);
    expect(m.cpuPct).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(m.cpuPct)).toBe(true);
    expect(m.memKb).toBeGreaterThanOrEqual(0);
  });

  it("produces a delta-sampled cpuPct on the second call", () => {
    resetCpuSampler();
    const first = getProcessTreeMetrics(process.pid);
    const second = getProcessTreeMetrics(process.pid);
    expect(first.pids).toEqual(second.pids);
    // After two samples the value is a real delta (finite, non-negative).
    expect(second.cpuPct).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(second.cpuPct)).toBe(true);
  });

  it("returns zeroes for an invalid pid", () => {
    const m = getProcessTreeMetrics(-1);
    expect(m.cpuPct).toBe(0);
    expect(m.memKb).toBe(0);
    expect(m.pids).toEqual([]);
  });
});
