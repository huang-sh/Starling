import { beforeEach, describe, expect, it, vi } from "vitest";
import { normalize } from "path";

const files = new Map<string, string>();
const stats = new Map<string, { mtimeMs: number; directory: boolean }>();
const children = new Map<string, string[]>();
const parsedFiles: string[] = [];
const statCalls: string[] = [];
let writtenJson: unknown = null;
let writeError: Error | null = null;

function key(path: string): string {
  return normalize(path);
}

/** Normalize a POSIX-style test path so it matches what `path.join` produces on the current platform. */
const p = (path: string): string => normalize(path);

function addDir(path: string, names: string[]): void {
  const k = key(path);
  stats.set(k, { mtimeMs: 1, directory: true });
  children.set(k, names);
}

function addFile(path: string, mtimeMs: number): void {
  stats.set(key(path), { mtimeMs, directory: false });
}

vi.mock("fs", () => ({
  existsSync: vi.fn((path: string) => files.has(key(path)) || stats.has(key(path))),
  readFileSync: vi.fn((path: string) => {
    const content = files.get(key(path));
    if (content === undefined) throw new Error(`missing file: ${path}`);
    return content;
  }),
  readdirSync: vi.fn((path: string) => {
    const names = children.get(key(path));
    if (!names) throw new Error(`missing directory: ${path}`);
    return names;
  }),
  statSync: vi.fn((path: string) => {
    statCalls.push(path);
    const st = stats.get(key(path));
    if (!st) throw new Error(`missing stat: ${path}`);
    return {
      mtimeMs: st.mtimeMs,
      isDirectory: () => st.directory,
    };
  }),
  unlinkSync: vi.fn(),
}));

vi.mock("../src/constants.js", () => {
  const { normalize } = require("path") as typeof import("path");
  return {
    CLAUDE_SESSIONS_DIR: normalize("/sessions/claude"),
    CODEX_SESSIONS_DIR: normalize("/sessions/codex"),
    DEFAULT_STARLING_HOME: normalize("/starling"),
    claudeSessionRoots: () => [normalize("/sessions/claude")],
    codexSessionRoots: () => [normalize("/sessions/codex")],
  };
});

vi.mock("../src/utils/fs.js", () => ({
  atomicWriteJSON: vi.fn((_path: string, value: unknown) => {
    if (writeError) throw writeError;
    writtenJson = value;
  }),
}));

vi.mock("../src/lib/session.js", () => ({
  parseJsonlHead: vi.fn(async (filePath: string) => {
    parsedFiles.push(`head:${filePath}`);
    return [];
  }),
  parseJsonlFile: vi.fn(async (filePath: string) => {
    parsedFiles.push(`full:${filePath}`);
    return [];
  }),
  extractClaudeSessionMeta: vi.fn((_entries, filePath: string, modifiedAt: string) => ({
    session_id: filePath.split(/[\\/]/).pop()?.replace(".jsonl", "") ?? filePath,
    provider: "claude",
    model: "claude-test",
    project_path: "/work/new",
    first_prompt: "",
    file_path: filePath,
    created_at: modifiedAt,
    modified_at: modifiedAt,
  })),
  extractCodexSessionMeta: vi.fn((_entries, filePath: string, modifiedAt: string) => ({
    session_id: filePath.split(/[\\/]/).pop()?.replace(".jsonl", "") ?? filePath,
    provider: "codex",
    model: "codex-test",
    project_path: "/work/new",
    first_prompt: "",
    file_path: filePath,
    created_at: modifiedAt,
    modified_at: modifiedAt,
  })),
}));

describe("loadSessionIndexWithNewFiles", () => {
  beforeEach(() => {
    files.clear();
    stats.clear();
    children.clear();
    parsedFiles.length = 0;
    statCalls.length = 0;
    writtenJson = null;
    writeError = null;

    files.set(
      p("/starling/session-index.json"),
      JSON.stringify({
        version: 1,
        built_at: "2026-01-01T00:00:00.000Z",
        session_count: 1,
        project_count: 1,
        sessions: [
          {
            session_id: "existing",
            provider: "claude",
            model: "claude-old",
            project_path: "/work/old",
            first_prompt: "",
            file_path: p("/sessions/claude/project/existing.jsonl"),
            created_at: "2026-01-01T00:00:00.000Z",
            modified_at: "2026-01-01T00:00:00.000Z",
          },
        ],
      })
    );
    addFile(p("/starling/session-index.json"), 100);
    addDir(p("/sessions/claude"), ["project"]);
    addDir(p("/sessions/claude/project"), ["existing.jsonl", "new.jsonl"]);
    addFile(p("/sessions/claude/project/existing.jsonl"), 200);
    addFile(p("/sessions/claude/project/new.jsonl"), 300);
    addDir(p("/sessions/codex"), []);
  });

  it("parses only new session files and persists the updated index", async () => {
    const { loadSessionIndexWithNewFiles } = await import("../src/lib/sessionIndex.js");

    const index = await loadSessionIndexWithNewFiles();

    expect(parsedFiles).toEqual([`head:${p("/sessions/claude/project/new.jsonl")}`]);
    expect(index.session_count).toBe(2);
    expect(index.project_count).toBe(2);
    expect(index.sessions.map((session) => session.session_id).sort()).toEqual(["existing", "new"]);
    expect(writtenJson).toMatchObject({
      version: 1,
      session_count: 2,
      project_count: 2,
    });
  });

  it("returns an updated in-memory index when persistence fails", async () => {
    writeError = Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const { loadSessionIndexWithNewFiles } = await import("../src/lib/sessionIndex.js");

    const index = await loadSessionIndexWithNewFiles();

    expect(parsedFiles).toEqual([`head:${p("/sessions/claude/project/new.jsonl")}`]);
    expect(index.session_count).toBe(2);
    expect(index.project_count).toBe(2);
    expect(index.sessions.map((session) => session.session_id).sort()).toEqual(["existing", "new"]);
    expect(writtenJson).toBeNull();
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("failed to write session index"));
    stderr.mockRestore();
  });

  it("refreshes indexed sessions by id when their files changed", async () => {
    addDir(p("/sessions/claude/project"), ["existing.jsonl"]);
    addFile(p("/sessions/claude/project/existing.jsonl"), Date.parse("2026-01-02T00:00:00.000Z"));
    const { refreshIndexedSessionsById } = await import("../src/lib/sessionIndex.js");

    const index = await refreshIndexedSessionsById(["existing"]);

    expect(parsedFiles).toEqual([`head:${p("/sessions/claude/project/existing.jsonl")}`]);
    expect(index.session_count).toBe(1);
    expect(index.sessions[0].modified_at).toBe("2026-01-02T00:00:00.000Z");
    expect(writtenJson).toMatchObject({
      version: 1,
      session_count: 1,
      project_count: 1,
    });
  });

  it("skips ordinary files in unchanged indexed directories", async () => {
    files.set(
      p("/starling/session-index.json"),
      JSON.stringify({
        version: 1,
        built_at: "2026-01-01T00:00:00.000Z",
        session_count: 1,
        project_count: 1,
        sessions: [
          {
            session_id: "existing",
            provider: "claude",
            model: "claude-old",
            project_path: "/work/old",
            first_prompt: "",
            file_path: p("/sessions/claude/project/existing.jsonl"),
            created_at: "2026-01-01T00:00:00.000Z",
            modified_at: "2026-01-01T00:00:00.000Z",
          },
        ],
        files: [
          {
            session_id: "existing",
            provider: "claude",
            path: p("/sessions/claude/project/existing.jsonl"),
            mtimeMs: Date.parse("2026-01-01T00:00:00.000Z"),
          },
        ],
        directories: [
          { provider: "claude", path: p("/sessions/claude"), mtimeMs: 1 },
          { provider: "claude", path: p("/sessions/claude/project"), mtimeMs: 1 },
          { provider: "codex", path: p("/sessions/codex"), mtimeMs: 1 },
        ],
      })
    );
    addFile(p("/sessions/claude/project/existing.jsonl"), Date.parse("2026-01-02T00:00:00.000Z"));
    const { loadSessionIndexWithNewFiles } = await import("../src/lib/sessionIndex.js");

    const index = await loadSessionIndexWithNewFiles();

    expect(index.session_count).toBe(1);
    expect(parsedFiles).toEqual([]);
    expect(statCalls).not.toContain(p("/sessions/claude/project/existing.jsonl"));
    expect(writtenJson).toBeNull();
  });

  it("fully parses matched sessions when refreshing exact session candidates", async () => {
    files.set(
      p("/starling/session-index.json"),
      JSON.stringify({
        version: 1,
        built_at: "2026-01-01T00:00:00.000Z",
        session_count: 1,
        project_count: 1,
        sessions: [
          {
            session_id: "existing",
            provider: "claude",
            model: "claude-old",
            project_path: "/work/old",
            first_prompt: "",
            file_path: p("/sessions/claude/project/existing.jsonl"),
            created_at: "2026-01-01T00:00:00.000Z",
            modified_at: "2026-01-01T00:00:00.000Z",
          },
        ],
        files: [
          {
            session_id: "existing",
            provider: "claude",
            path: p("/sessions/claude/project/existing.jsonl"),
            mtimeMs: Date.parse("2026-01-01T00:00:00.000Z"),
          },
        ],
        directories: [
          { provider: "claude", path: p("/sessions/claude"), mtimeMs: 1 },
          { provider: "claude", path: p("/sessions/claude/project"), mtimeMs: 1 },
        ],
      })
    );
    addDir(p("/sessions/claude/project"), ["existing.jsonl"]);
    addFile(p("/sessions/claude/project/existing.jsonl"), Date.parse("2026-01-01T00:00:00.000Z"));
    const { findIndexedSessionById } = await import("../src/lib/sessionIndex.js");

    const session = await findIndexedSessionById("existing");

    expect(session?.session_id).toBe("existing");
    expect(parsedFiles).toEqual([`full:${p("/sessions/claude/project/existing.jsonl")}`]);
  });
});
