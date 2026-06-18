import { beforeEach, describe, expect, it, vi } from "vitest";
import { normalize } from "path";

const stats = new Map<string, { mtimeMs: number; directory: boolean }>();
const children = new Map<string, string[]>();
const statCalls: string[] = [];

function addDir(path: string, mtimeMs: number, names: string[]): void {
  stats.set(normalize(path), { mtimeMs, directory: true });
  children.set(normalize(path), names);
}

function addFile(path: string, mtimeMs: number): void {
  stats.set(normalize(path), { mtimeMs, directory: false });
}

vi.mock("fs", () => ({
  readdirSync: vi.fn((dir: string) => {
    const names = children.get(normalize(dir));
    if (!names) throw new Error(`missing directory: ${dir}`);
    return names;
  }),
  statSync: vi.fn((path: string) => {
    statCalls.push(path);
    const st = stats.get(normalize(path));
    if (!st) throw new Error(`missing stat: ${path}`);
    return {
      mtimeMs: st.mtimeMs,
      isDirectory: () => st.directory,
    };
  }),
}));

vi.mock("../src/constants.js", () => {
  const { normalize } = require("path") as typeof import("path");
  return {
    CLAUDE_SESSIONS_DIR: normalize("/sessions/claude"),
    CODEX_SESSIONS_DIR: normalize("/sessions/codex"),
    claudeSessionRoots: () => [normalize("/sessions/claude")],
    codexSessionRoots: () => [normalize("/sessions/codex")],
  };
});

vi.mock("../src/lib/session.js", () => ({
  parseJsonlHead: vi.fn(async () => []),
  extractClaudeSessionMeta: vi.fn((_entries, filePath: string, modifiedAt: string) => ({
    session_id: filePath.split(/[\\/]/).pop()?.replace(".jsonl", "") ?? filePath,
    provider: "claude",
    model: "",
    project_path: "",
    first_prompt: "",
    file_path: filePath,
    created_at: modifiedAt,
    modified_at: modifiedAt,
  })),
  extractCodexSessionMeta: vi.fn((_entries, filePath: string, modifiedAt: string) => ({
    session_id: filePath.split(/[\\/]/).pop()?.replace(".jsonl", "") ?? filePath,
    provider: "codex",
    model: "",
    project_path: "",
    first_prompt: "",
    file_path: filePath,
    created_at: modifiedAt,
    modified_at: modifiedAt,
  })),
}));

describe("findSessions", () => {
  beforeEach(() => {
    stats.clear();
    children.clear();
    statCalls.length = 0;

    addDir("/sessions/codex", 1, []);
    addDir(
      "/sessions/claude",
      100,
      Array.from({ length: 20 }, (_, index) => `project-${String(index).padStart(2, "0")}`)
    );

    for (let index = 0; index < 20; index++) {
      const project = `/sessions/claude/project-${String(index).padStart(2, "0")}`;
      const mtime = 1000 - index;
      addDir(project, mtime, [`session-${index}.jsonl`]);
      addFile(`${project}/session-${index}.jsonl`, mtime);
    }
  });

  it("uses the requested limit when collecting provider files", async () => {
    const { findSessions } = await import("../src/lib/discovery.js");

    const sessions = await findSessions(2, "claude");

    expect(sessions).toHaveLength(2);
    expect(statCalls.filter((path) => path.includes("/session-")).length).toBeLessThan(20);
  });

  it("findSessionCandidates returns all matching sessions", async () => {
    const claudeTop = children.get(normalize("/sessions/claude"));
    if (!claudeTop) throw new Error("missing mocked dir");
    claudeTop.push("match-proj");

    addDir("/sessions/claude/match-proj", 300, ["ae208026-a.jsonl", "ae208026-b.jsonl", "other.jsonl"]);
    addFile("/sessions/claude/match-proj/ae208026-a.jsonl", 500);
    addFile("/sessions/claude/match-proj/ae208026-b.jsonl", 400);
    addFile("/sessions/claude/match-proj/other.jsonl", 200);

    const { findSessionCandidates } = await import("../src/lib/discovery.js");
    const candidates = await findSessionCandidates("ae208026");

    expect(candidates).toHaveLength(2);
    expect(candidates[0].session_id).toBe("ae208026-a.jsonl".replace(".jsonl", ""));
    expect(candidates[1].session_id).toBe("ae208026-b.jsonl".replace(".jsonl", ""));
  });

  it("findSessionCandidates rejects non-session names without scanning", async () => {
    const { findSessionCandidates } = await import("../src/lib/discovery.js");
    const candidates = await findSessionCandidates("sc-bench-skill-task-003-repeat-005");

    expect(candidates).toHaveLength(0);
    expect(statCalls).toHaveLength(0);
  });

  it("findSessionCandidates searches nested provider directories", async () => {
    addDir("/sessions/codex", 150, ["2026"]);
    addDir("/sessions/codex/2026", 200, ["06"]);
    addDir("/sessions/codex/2026/06", 250, ["07"]);
    addDir("/sessions/codex/2026/06/07", 300, ["1234abcd-5678-90ef.jsonl"]);
    addFile("/sessions/codex/2026/06/07/1234abcd-5678-90ef.jsonl", 350);

    const { findSessionCandidates } = await import("../src/lib/discovery.js");
    const candidates = await findSessionCandidates("1234abcd-5678-90ef");

    expect(candidates).toHaveLength(1);
    expect(candidates[0].session_id).toBe("1234abcd-5678-90ef");
    expect(candidates[0].provider).toBe("codex");
  });
});
