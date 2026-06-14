import { beforeEach, describe, expect, it, vi } from "vitest";

const files = new Map<string, string>();
const stats = new Map<string, { mtimeMs: number; directory: boolean }>();
const children = new Map<string, string[]>();
const parsedFiles: string[] = [];
const statCalls: string[] = [];
let writtenJson: unknown = null;

function addDir(path: string, names: string[]): void {
  stats.set(path, { mtimeMs: 1, directory: true });
  children.set(path, names);
}

function addFile(path: string, mtimeMs: number): void {
  stats.set(path, { mtimeMs, directory: false });
}

vi.mock("fs", () => ({
  existsSync: vi.fn((path: string) => files.has(path) || stats.has(path)),
  readFileSync: vi.fn((path: string) => {
    const content = files.get(path);
    if (content === undefined) throw new Error(`missing file: ${path}`);
    return content;
  }),
  readdirSync: vi.fn((path: string) => {
    const names = children.get(path);
    if (!names) throw new Error(`missing directory: ${path}`);
    return names;
  }),
  statSync: vi.fn((path: string) => {
    statCalls.push(path);
    const st = stats.get(path);
    if (!st) throw new Error(`missing stat: ${path}`);
    return {
      mtimeMs: st.mtimeMs,
      isDirectory: () => st.directory,
    };
  }),
  unlinkSync: vi.fn(),
}));

vi.mock("../src/constants.js", () => ({
  CLAUDE_SESSIONS_DIR: "/sessions/claude",
  CODEX_SESSIONS_DIR: "/sessions/codex",
  DEFAULT_STARLING_HOME: "/starling",
}));

vi.mock("../src/utils/fs.js", () => ({
  atomicWriteJSON: vi.fn((_path: string, value: unknown) => {
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
    session_id: filePath.split("/").pop()?.replace(".jsonl", "") ?? filePath,
    provider: "claude",
    model: "claude-test",
    project_path: "/work/new",
    first_prompt: "",
    file_path: filePath,
    created_at: modifiedAt,
    modified_at: modifiedAt,
  })),
  extractCodexSessionMeta: vi.fn((_entries, filePath: string, modifiedAt: string) => ({
    session_id: filePath.split("/").pop()?.replace(".jsonl", "") ?? filePath,
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

    files.set(
      "/starling/session-index.json",
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
            file_path: "/sessions/claude/project/existing.jsonl",
            created_at: "2026-01-01T00:00:00.000Z",
            modified_at: "2026-01-01T00:00:00.000Z",
          },
        ],
      })
    );
    addFile("/starling/session-index.json", 100);
    addDir("/sessions/claude", ["project"]);
    addDir("/sessions/claude/project", ["existing.jsonl", "new.jsonl"]);
    addFile("/sessions/claude/project/existing.jsonl", 200);
    addFile("/sessions/claude/project/new.jsonl", 300);
    addDir("/sessions/codex", []);
  });

  it("parses only new session files and persists the updated index", async () => {
    const { loadSessionIndexWithNewFiles } = await import("../src/lib/sessionIndex.js");

    const index = await loadSessionIndexWithNewFiles();

    expect(parsedFiles).toEqual(["head:/sessions/claude/project/new.jsonl"]);
    expect(index.session_count).toBe(2);
    expect(index.project_count).toBe(2);
    expect(index.sessions.map((session) => session.session_id).sort()).toEqual(["existing", "new"]);
    expect(writtenJson).toMatchObject({
      version: 1,
      session_count: 2,
      project_count: 2,
    });
  });

  it("refreshes indexed sessions by id when their files changed", async () => {
    addDir("/sessions/claude/project", ["existing.jsonl"]);
    addFile("/sessions/claude/project/existing.jsonl", Date.parse("2026-01-02T00:00:00.000Z"));
    const { refreshIndexedSessionsById } = await import("../src/lib/sessionIndex.js");

    const index = await refreshIndexedSessionsById(["existing"]);

    expect(parsedFiles).toEqual(["head:/sessions/claude/project/existing.jsonl"]);
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
      "/starling/session-index.json",
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
            file_path: "/sessions/claude/project/existing.jsonl",
            created_at: "2026-01-01T00:00:00.000Z",
            modified_at: "2026-01-01T00:00:00.000Z",
          },
        ],
        files: [
          {
            session_id: "existing",
            provider: "claude",
            path: "/sessions/claude/project/existing.jsonl",
            mtimeMs: Date.parse("2026-01-01T00:00:00.000Z"),
          },
        ],
        directories: [
          { provider: "claude", path: "/sessions/claude", mtimeMs: 1 },
          { provider: "claude", path: "/sessions/claude/project", mtimeMs: 1 },
          { provider: "codex", path: "/sessions/codex", mtimeMs: 1 },
        ],
      })
    );
    addFile("/sessions/claude/project/existing.jsonl", Date.parse("2026-01-02T00:00:00.000Z"));
    const { loadSessionIndexWithNewFiles } = await import("../src/lib/sessionIndex.js");

    const index = await loadSessionIndexWithNewFiles();

    expect(index.session_count).toBe(1);
    expect(parsedFiles).toEqual([]);
    expect(statCalls).not.toContain("/sessions/claude/project/existing.jsonl");
    expect(writtenJson).toBeNull();
  });

  it("fully parses matched sessions when refreshing exact session candidates", async () => {
    files.set(
      "/starling/session-index.json",
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
            file_path: "/sessions/claude/project/existing.jsonl",
            created_at: "2026-01-01T00:00:00.000Z",
            modified_at: "2026-01-01T00:00:00.000Z",
          },
        ],
        files: [
          {
            session_id: "existing",
            provider: "claude",
            path: "/sessions/claude/project/existing.jsonl",
            mtimeMs: Date.parse("2026-01-01T00:00:00.000Z"),
          },
        ],
        directories: [
          { provider: "claude", path: "/sessions/claude", mtimeMs: 1 },
          { provider: "claude", path: "/sessions/claude/project", mtimeMs: 1 },
        ],
      })
    );
    addDir("/sessions/claude/project", ["existing.jsonl"]);
    addFile("/sessions/claude/project/existing.jsonl", Date.parse("2026-01-01T00:00:00.000Z"));
    const { findIndexedSessionById } = await import("../src/lib/sessionIndex.js");

    const session = await findIndexedSessionById("existing");

    expect(session?.session_id).toBe("existing");
    expect(parsedFiles).toEqual(["full:/sessions/claude/project/existing.jsonl"]);
  });
});
