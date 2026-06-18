import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  encodeClaudeCwd,
  extractResumeUuid,
  extractSessionIdFromPath,
  findSessionFileById,
  isSessionFilePath,
  mapProcessesToSessions,
  parseProcEnviron,
  parseProcStat,
  providerFromCmdline,
  resolveAgentHome,
  sessionRootForHome,
} from "../src/lib/processMap.js";

describe("processMap pure helpers", () => {
  it("parses /proc/<pid>/environ into a key/value map", () => {
    const raw = "PATH=/usr/bin\0CLAUDE_CONFIG_DIR=/tmp/iso\0FOO=bar=baz\0\0";
    expect(parseProcEnviron(raw)).toEqual({
      PATH: "/usr/bin",
      CLAUDE_CONFIG_DIR: "/tmp/iso",
      FOO: "bar=baz",
    });
  });

  it("parses /proc/<pid>/stat including comm with spaces and parens", () => {
    // comm "ClAUDE (agent) helper" contains spaces and a paren pair.
    const raw = "1234 (ClAUDE (agent) helper) S 7 1234 1234 0 -1 0 0 0 0 0 250 130 0 0 20 0 1 0 99000 1000000 200 1";
    const stat = parseProcStat(raw);
    expect(stat).not.toBeNull();
    expect(stat!.pid).toBe(1234);
    expect(stat!.comm).toBe("ClAUDE (agent) helper");
    expect(stat!.state).toBe("S");
    expect(stat!.ppid).toBe(7);
    expect(stat!.utime).toBe(250);
    expect(stat!.stime).toBe(130);
    expect(stat!.starttime).toBe(99000);
  });

  it("detects provider from various cmdline shapes", () => {
    expect(providerFromCmdline(["claude", "--resume", "x"])).toBe("claude");
    expect(providerFromCmdline(["codex", "run"])).toBe("codex");
    expect(providerFromCmdline(["/usr/local/bin/claude"])).toBe("claude");
    expect(providerFromCmdline(["node", "/opt/claude.js", "--print"])).toBe("claude");
    expect(providerFromCmdline(["node", "/opt/codex.js"])).toBe("codex");
    expect(providerFromCmdline(["bash", "-c", "ls"])).toBeNull();
  });

  it("extracts a resume uuid and lowercases it", () => {
    const uuid = "AA71D672-adb9-4bb3-88a1-0541f26c58e3";
    expect(extractResumeUuid(["claude", "--resume", uuid])).toBe(uuid.toLowerCase());
    expect(extractResumeUuid(["claude", "-r", uuid])).toBeNull();
    expect(extractResumeUuid(["claude", "--print"])).toBeNull();
  });

  it("encodes a project cwd the way Claude does", () => {
    expect(encodeClaudeCwd("/work/demo")).toBe("-work-demo");
    expect(encodeClaudeCwd("/a/b/c")).toBe("-a-b-c");
  });

  it("extracts a session id from a file path", () => {
    const uuid = "aa71d672-adb9-4bb3-88a1-0541f26c58e3";
    expect(extractSessionIdFromPath(`/x/y/${uuid}.jsonl`)).toBe(uuid);
    expect(extractSessionIdFromPath(`${uuid}.jsonl`)).toBe(uuid);
  });

  it("treats only UUID/rollout .jsonl files as session files", () => {
    const uuid = "aa71d672-adb9-4bb3-88a1-0541f26c58e3";
    expect(isSessionFilePath(`/home/u/.claude/projects/-work/${uuid}.jsonl`)).toBe(true);
    expect(isSessionFilePath(`/home/u/.codex/sessions/rollout-2026-06-01T00-00-00-${uuid}.jsonl`)).toBe(true);
    // Non-session jsonl files that live in the agent home — must be rejected
    // so the open-file cascade falls through to the cwd+mtime fallback.
    expect(isSessionFilePath(`/home/u/.claude/history.jsonl`)).toBe(false);
    expect(isSessionFilePath(`/home/u/.claude/todos.jsonl`)).toBe(false);
    expect(isSessionFilePath(`/home/u/.claude/statsig/evt.jsonl`)).toBe(false);
    expect(isSessionFilePath("readme.txt")).toBe(false);
  });
});

describe("processMap home resolution", () => {
  const prevClaude = process.env.CLAUDE_CONFIG_DIR;
  const prevCodex = process.env.CODEX_HOME;
  beforeEach(() => {
    delete process.env.CLAUDE_CONFIG_DIR;
    delete process.env.CODEX_HOME;
  });
  afterEach(() => {
    if (prevClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prevClaude;
    if (prevCodex === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodex;
  });

  it("defaults to ~/.claude / ~/.codex when env unset", () => {
    expect(resolveAgentHome("claude", {})).toBe(join(process.env.HOME ?? "", ".claude"));
    expect(resolveAgentHome("codex", {})).toBe(join(process.env.HOME ?? "", ".codex"));
  });

  it("honors CLAUDE_CONFIG_DIR / CODEX_HOME from the target process environ", () => {
    expect(resolveAgentHome("claude", { CLAUDE_CONFIG_DIR: "/tmp/iso-claude" })).toBe("/tmp/iso-claude");
    expect(resolveAgentHome("codex", { CODEX_HOME: "/tmp/iso-codex" })).toBe("/tmp/iso-codex");
  });

  it("maps a home to the correct session root", () => {
    expect(sessionRootForHome("claude", "/tmp/iso")).toBe(join("/tmp/iso", "projects"));
    expect(sessionRootForHome("codex", "/tmp/iso")).toBe(join("/tmp/iso", "sessions"));
  });
});

describe("processMap findSessionFileById", () => {
  let root = "";
  const uuid = "aa71d672-adb9-4bb3-88a1-0541f26c58e3";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "starling-pmap-"));
    // Claude layout: <root>/<encoded-cwd>/<uuid>.jsonl
    mkdirSync(join(root, "-work-demo"), { recursive: true });
    writeFileSync(join(root, "-work-demo", `${uuid}.jsonl`), "{}\n");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("finds a Claude session nested under an encoded-cwd dir", () => {
    expect(findSessionFileById(root, uuid)).toBe(join(root, "-work-demo", `${uuid}.jsonl`));
  });

  it("returns null when the session is absent", () => {
    expect(findSessionFileById(root, "11111111-1111-4111-8111-111111111111")).toBeNull();
  });

  it("finds a Codex session living directly under the root", () => {
    const codexRoot = mkdtempSync(join(tmpdir(), "starling-pmap-cdx-"));
    try {
      writeFileSync(join(codexRoot, `${uuid}.jsonl`), "{}\n");
      expect(findSessionFileById(codexRoot, uuid)).toBe(join(codexRoot, `${uuid}.jsonl`));
    } finally {
      rmSync(codexRoot, { recursive: true, force: true });
    }
  });
});

describe("processMap mapProcessesToSessions", () => {
  it("returns a Map without throwing (empty off-linux, live /proc on linux)", async () => {
    const map = await mapProcessesToSessions();
    expect(map).toBeInstanceOf(Map);
  });
});
