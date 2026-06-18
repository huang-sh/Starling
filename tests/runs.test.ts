import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearRuns,
  createRun,
  finalizeRun,
  getRunStatusForSession,
  isPidAlive,
  loadRuns,
  markRunCrashed,
  reconcileStaleRuns,
  removeRun,
  runsPath,
  saveRuns,
  statusBadge,
  statusGlyph,
  summarizeRunStatus,
} from "../src/lib/runs.js";
import type { Bookmark, RunRecord } from "../src/types.js";

let root = "";
let previousRunsEnv: string | undefined;

function record(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    run_id: "run-1",
    provider: "claude",
    status: "running",
    started_at: "2026-01-01T00:00:00.000Z",
    source: "starling-run",
    ...overrides,
  };
}

describe("runs store", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "starling-runs-"));
    previousRunsEnv = process.env.STARLING_RUNS;
    process.env.STARLING_RUNS = join(root, "runs.json");
  });

  afterEach(() => {
    if (previousRunsEnv === undefined) delete process.env.STARLING_RUNS;
    else process.env.STARLING_RUNS = previousRunsEnv;
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  it("returns an empty store when the file is missing", () => {
    expect(loadRuns()).toEqual({ version: 1, runs: [] });
    expect(runsPath()).toBe(join(root, "runs.json"));
  });

  it("returns an empty store when the file is corrupt", () => {
    writeFileSync(runsPath(), "{ not valid json");
    expect(loadRuns()).toEqual({ version: 1, runs: [] });
  });

  it("creates and reloads a run record", () => {
    createRun(record({ run_id: "run-a", pid: 123, project_path: "/work" }));
    const loaded = loadRuns();
    expect(loaded.runs).toHaveLength(1);
    expect(loaded.runs[0]).toMatchObject({ run_id: "run-a", pid: 123, status: "running" });
  });

  it("finalizes a run with status, exit code and session id", () => {
    createRun(record({ run_id: "run-b" }));
    finalizeRun("run-b", { status: "completed", exit_code: 0, session_id: "sess-b" });
    const run = loadRuns().runs[0]!;
    expect(run.status).toBe("completed");
    expect(run.exit_code).toBe(0);
    expect(run.session_id).toBe("sess-b");
    expect(run.ended_at).toBeTruthy();
  });

  it("finalizeRun is a no-op for an unknown run id", () => {
    createRun(record({ run_id: "run-c", status: "running" }));
    finalizeRun("does-not-exist", { status: "completed", exit_code: 0 });
    expect(loadRuns().runs).toHaveLength(1);
    expect(loadRuns().runs[0]!.status).toBe("running");
  });

  it("markRunCrashed sets crashed status", () => {
    createRun(record({ run_id: "run-d", status: "running" }));
    markRunCrashed("run-d");
    expect(loadRuns().runs[0]!.status).toBe("crashed");
  });

  it("removes a run by id", () => {
    createRun(record({ run_id: "run-e" }));
    expect(removeRun("run-e")).toBe(true);
    expect(loadRuns().runs).toHaveLength(0);
    expect(removeRun("run-e")).toBe(false);
  });

  it("clearRuns filters by session id and by status", () => {
    createRun(record({ run_id: "r1", session_id: "s1", status: "completed" }));
    createRun(record({ run_id: "r2", session_id: "s2", status: "crashed" }));
    createRun(record({ run_id: "r3", session_id: "s1", status: "running" }));

    expect(clearRuns({ session_id: "s1" })).toBe(2);
    expect(loadRuns().runs.map((r) => r.run_id)).toEqual(["r2"]);

    createRun(record({ run_id: "r4", session_id: "s2", status: "completed" }));
    expect(clearRuns({ status: "completed" })).toBe(1);
  });

  it("getRunStatusForSession returns the latest record status or unknown", () => {
    expect(getRunStatusForSession("none")).toBe("unknown");
    createRun(record({ run_id: "old", session_id: "sx", status: "completed", started_at: "2026-01-01T00:00:00.000Z" }));
    createRun(record({ run_id: "new", session_id: "sx", status: "errored", started_at: "2026-02-01T00:00:00.000Z" }));
    expect(getRunStatusForSession("sx")).toBe("errored");
  });

  it("bounds history to MAX_RUN_RECORDS while keeping running records", () => {
    const data = { version: 1 as const, runs: [] as RunRecord[] };
    // 10 running records (must be retained) + 600 terminal records.
    for (let i = 0; i < 10; i++) {
      data.runs.push(record({ run_id: `run-${i}`, status: "running", started_at: "2026-01-01T00:00:00.000Z" }));
    }
    for (let i = 0; i < 600; i++) {
      data.runs.push(record({ run_id: `term-${i}`, status: "completed", started_at: `2026-01-0${(i % 9) + 1}T00:00:00.000Z`, ended_at: `2026-01-0${(i % 9) + 1}T00:00:00.000Z` }));
    }
    saveRuns(data);
    const saved = loadRuns();
    expect(saved.runs.length).toBeLessThanOrEqual(500);
    const runningCount = saved.runs.filter((r) => r.status === "running").length;
    expect(runningCount).toBe(10); // all running records preserved
  });

  it("isPidAlive treats ESRCH as dead and a real pid as alive", () => {
    expect(isPidAlive(process.pid)).toBe(true);
    expect(isPidAlive(999999)).toBe(false);
  });

  it("reconcileStaleRuns marks dead-pid running records as crashed", () => {
    createRun(record({ run_id: "alive", pid: process.pid, status: "running" }));
    createRun(record({ run_id: "dead", pid: 999999, status: "running" }));
    const changed = reconcileStaleRuns();
    expect(changed).toBe(1);
    const runs = loadRuns().runs;
    expect(runs.find((r) => r.run_id === "alive")!.status).toBe("running");
    expect(runs.find((r) => r.run_id === "dead")!.status).toBe("crashed");
  });

  it("persisted file uses the runsPath location", () => {
    createRun(record({ run_id: "persist" }));
    expect(existsSync(runsPath())).toBe(true);
    const raw = JSON.parse(readFileSync(runsPath(), "utf-8"));
    expect(raw.runs[0].run_id).toBe("persist");
  });
});

describe("runs formatting helpers", () => {
  it("statusGlyph maps every status", () => {
    expect(statusGlyph("running")).toBe("●");
    expect(statusGlyph("completed")).toBe("✓");
    expect(statusGlyph("errored")).toBe("✗");
    expect(statusGlyph("unknown")).toBe("·");
  });

  it("statusBadge returns a string containing the glyph", () => {
    expect(typeof statusBadge("running")).toBe("string");
    expect(statusBadge("errored")).toContain("✗");
  });

  it("summarizeRunStatus aggregates per-status counts", () => {
    const base: Bookmark = {
      id: "b",
      provider: "claude",
      session_id: "",
      title: "t",
      category: "",
      tags: [],
      project_path: "/p",
      first_prompt: "",
      notes: [],
      space_ids: ["cat_0001"],
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    };
    root = mkdtempSync(join(tmpdir(), "starling-runs-fmt-"));
    process.env.STARLING_RUNS = join(root, "runs.json");
    createRun(record({ run_id: "a", session_id: "s-run", status: "running" }));
    createRun(record({ run_id: "b2", session_id: "s-err", status: "errored" }));

    const summary = summarizeRunStatus([
      { ...base, session_id: "s-run" },
      { ...base, session_id: "s-err" },
      { ...base, session_id: "s-none" },
    ]);
    expect(summary).toContain("●1");
    expect(summary).toContain("✗1");
    expect(summary).toContain("·1"); // unknown

    rmSync(root, { recursive: true, force: true });
    delete process.env.STARLING_RUNS;
  });
});
