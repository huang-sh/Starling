import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let root = "";

vi.mock("../src/constants.js", () => ({
  DEFAULT_CONFIG_DIR: join(root, ".config", "starling"),
  CLI_CONFIG_PATH: join(root, ".config", "starling", "config.json"),
  DEFAULT_STARLING_HOME: join(root, ".starling"),
  DEFAULT_STARLING_SETTINGS_DIR: join(root, ".starling", "settings"),
  DEFAULT_CLAUDE_SETTINGS_DIR: join(root, ".starling", "settings", "claude"),
  DEFAULT_CODEX_SETTINGS_DIR: join(root, ".starling", "settings", "codex"),
  DEFAULT_CODEX_HOME: join(root, ".codex"),
  DEFAULT_STORE_PATH: join(root, ".starling", "store.json"),
  CLAUDE_SESSIONS_DIR: join(root, ".claude", "projects"),
  CODEX_SESSIONS_DIR: join(root, ".codex", "sessions"),
}));

// Keep the real parseAgentSpec / specLabel; only stub the spawning function.
vi.mock("../src/diagnose/agentRunner.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    runAgentCapture: vi.fn(),
  };
});

describe("parseAgentSpec", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "starling-diag-"));
    vi.resetModules();
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  async function loadParse() {
    const { parseAgentSpec } = await import("../src/diagnose/agentRunner.js");
    return parseAgentSpec as (s: string) => unknown;
  }

  it("parses provider with empty profile (default config)", async () => {
    const parse = await loadParse();
    const spec = parse("claude:") as { provider: string; profile: string; raw: string };
    expect(spec.provider).toBe("claude");
    expect(spec.profile).toBe("");
    expect(spec.raw).toBe("claude:");
  });

  it("parses provider:profile", async () => {
    const parse = await loadParse();
    const spec = parse("codex:gpt5") as { provider: string; profile: string };
    expect(spec.provider).toBe("codex");
    expect(spec.profile).toBe("gpt5");
  });

  it("parses bare provider as default config (no colon)", async () => {
    const parse = await loadParse();
    const claude = parse("claude") as { provider: string; profile: string; raw: string };
    expect(claude.provider).toBe("claude");
    expect(claude.profile).toBe("");
    expect(claude.raw).toBe("claude");
    const codex = parse("codex") as { provider: string; profile: string };
    expect(codex.provider).toBe("codex");
    expect(codex.profile).toBe("");
  });

  it("rejects unknown provider", async () => {
    const parse = await loadParse();
    expect(() => parse("foo:bar")).toThrow(/unknown provider/);
    expect(() => parse("foo")).toThrow(/unknown provider/);
  });

  it("rejects empty spec", async () => {
    const parse = await loadParse();
    expect(() => parse("   ")).toThrow(/Empty agent spec/);
  });
});

describe("task registry", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "starling-diag-"));
    vi.resetModules();
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("lists the personality task", async () => {
    const { listTaskIds } = await import("../src/diagnose/tasks/index.js");
    expect(listTaskIds()).toEqual(["personality"]);
  });

  it("loads the personality task with 10 questions and 10 scoring dimensions", async () => {
    const { loadTask } = await import("../src/diagnose/tasks/index.js");
    const task = loadTask("personality");
    expect(task.id).toBe("personality");
    expect(task.questions).toHaveLength(10);
    expect(task.scoringDimensions).toHaveLength(10);
    expect(task.questions[0].id).toBe("q1");
    expect(task.judgeInstructions.length).toBeGreaterThan(0);
  });

  it("throws on unknown task with the available list", async () => {
    const { loadTask } = await import("../src/diagnose/tasks/index.js");
    expect(() => loadTask("nope")).toThrow(/Unknown task: nope[\s\S]*personality/);
  });
});

describe("buildJudgePrompt", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "starling-diag-"));
    vi.resetModules();
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("includes every question prompt, every response, and the JSON contract", async () => {
    const { loadTask } = await import("../src/diagnose/tasks/index.js");
    const { buildJudgePrompt } = await import("../src/diagnose/prompt.js");
    const task = loadTask("personality");
    const evaluatees = [
      {
        spec: "claude:ds",
        profileLabel: "claude:ds",
        provider: "claude" as const,
        results: task.questions.slice(0, 2).map((q) => ({
          questionId: q.id,
          prompt: q.prompt,
          response: `answer-to-${q.id}`,
          exitCode: 0,
          durationMs: 10,
          timedOut: false,
        })),
      },
    ];
    const prompt = buildJudgePrompt(task, evaluatees);
    expect(prompt).toContain(task.questions[0].prompt);
    expect(prompt).toContain(task.questions[1].prompt);
    expect(prompt).toContain("answer-to-q1");
    expect(prompt).toContain("answer-to-q2");
    expect(prompt).toContain("assessments");
    expect(prompt).toContain("personalityType");
    expect(prompt).toContain("scores");
  });
});

describe("parseJudgeVerdict", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "starling-diag-"));
    vi.resetModules();
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  async function loadParser() {
    const { parseJudgeVerdict } = await import("../src/diagnose/prompt.js");
    return parseJudgeVerdict;
  }

  const evaluatees = [
    { spec: "claude:a", profileLabel: "claude:a", provider: "claude" as const, results: [] },
    { spec: "claude:b", profileLabel: "claude:b", provider: "claude" as const, results: [] },
  ];

  it("parses a clean JSON verdict", async () => {
    const parse = await loadParser();
    const raw = JSON.stringify({
      assessments: [
        { profileLabel: "claude:a", personalityType: "边界清晰型", scores: { 服从性: 4, 边界感: 5 }, rationale: "r1" },
        { profileLabel: "claude:b", personalityType: "理性工具型", scores: { 服从性: 3 }, rationale: "r2" },
      ],
    });
    const verdict = parse(raw, evaluatees);
    expect(verdict.parseError).toBeUndefined();
    expect(verdict.assessments).toHaveLength(2);
    expect(verdict.assessments[0].personalityType).toBe("边界清晰型");
    expect(verdict.assessments[0].scores["服从性"]).toBe(4);
  });

  it("parses markdown-fenced JSON", async () => {
    const parse = await loadParser();
    const raw = "Here you go:\n```json\n" + JSON.stringify({
      assessments: [{ profileLabel: "claude:a", personalityType: "T", scores: {}, rationale: "" }],
    }) + "\n```\n";
    const verdict = parse(raw, evaluatees);
    expect(verdict.parseError).toBeUndefined();
    expect(verdict.assessments).toHaveLength(1);
  });

  it("clamps scores into 1-5", async () => {
    const parse = await loadParser();
    const raw = JSON.stringify({
      assessments: [{ profileLabel: "claude:a", personalityType: "T", scores: { 服从性: 99, 边界感: -3 }, rationale: "" }],
    });
    const verdict = parse(raw, evaluatees);
    expect(verdict.assessments[0].scores["服从性"]).toBe(5);
    expect(verdict.assessments[0].scores["边界感"]).toBe(1);
  });

  it("sets parseError and keeps raw on garbage input without throwing", async () => {
    const parse = await loadParser();
    const verdict = parse("this is not json at all", evaluatees);
    expect(verdict.parseError).toBeTruthy();
    expect(verdict.assessments).toHaveLength(0);
    expect(verdict.raw).toBe("this is not json at all");
  });
});

describe("diagnose orchestration (mocked agent capture)", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "starling-diag-"));
    vi.resetModules();
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  async function setupCaptureMock() {
    const agentRunner = await import("../src/diagnose/agentRunner.js");
    const mock = agentRunner.runAgentCapture as ReturnType<typeof vi.fn>;
    mock.mockReset();
    return mock;
  }

  it("runs each evaluatee over all questions, then the judge once", async () => {
    const captureMock = await setupCaptureMock();
    // Two evaluatees (claude:a, claude:b) → 10 questions each, then 1 judge call.
    let callIndex = 0;
    captureMock.mockImplementation(async (_spec: unknown, prompt: string) => {
      callIndex++;
      if (callIndex <= 20) {
        return { stdout: `resp-${callIndex}`, exitCode: 0, durationMs: 5, timedOut: false };
      }
      // judge call: the prompt is long and contains the rubric.
      expect(prompt).toContain("assessments");
      return {
        stdout: JSON.stringify({
          assessments: [
            { profileLabel: "claude:a", personalityType: "T1", scores: { 服从性: 3 }, rationale: "ra" },
            { profileLabel: "claude:b", personalityType: "T2", scores: { 服从性: 4 }, rationale: "rb" },
          ],
        }),
        exitCode: 0,
        durationMs: 9,
        timedOut: false,
      };
    });

    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { runDiagnose } = await import("../src/commands/diagnose.js");
    await runDiagnose({
      task: "personality",
      judge: "claude:judge",
      agent: ["claude:a", "claude:b"],
      timeout: "1000",
      concurrency: "1",
      json: true,
      out: undefined,
    });

    expect(captureMock).toHaveBeenCalledTimes(21); // 2 * 10 + 1 judge
    expect(stdoutSpy).toHaveBeenCalled();
    const out = stdoutSpy.mock.calls.map((c) => String(c[0])).join("");
    const report = JSON.parse(out);
    expect(report.task).toBe("personality");
    expect(report.evaluatees).toHaveLength(2);
    expect(report.evaluatees[0].results).toHaveLength(10);
    expect(report.evaluatees[0].results[0].response).toBe("resp-1");
    expect(report.verdict.assessments).toHaveLength(2);
    expect(report.verdict.assessments[0].personalityType).toBe("T1");

    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it("marks a timed-out question and keeps going", async () => {
    const captureMock = await setupCaptureMock();
    captureMock.mockImplementation(async (_spec: unknown, _prompt: string) => ({
      stdout: "",
      exitCode: 124,
      durationMs: 1000,
      timedOut: true,
    }));
    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const { runDiagnose } = await import("../src/commands/diagnose.js");
    await runDiagnose({
      task: "personality",
      judge: "claude:judge",
      agent: ["claude:a"],
      timeout: "1000",
      concurrency: "1",
      json: true,
      out: undefined,
    });

    const out = stdoutSpy.mock.calls.map((c) => String(c[0])).join("");
    const report = JSON.parse(out);
    expect(report.evaluatees[0].results.every((r: { timedOut: boolean }) => r.timedOut)).toBe(true);
    expect(report.evaluatees[0].error).toBeTruthy();
    expect(report.verdict.parseError).toBeTruthy();

    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it("writes a JSON report file with --out", async () => {
    const { existsSync, mkdirSync } = await import("fs");
    const captureMock = await setupCaptureMock();
    captureMock.mockResolvedValue({ stdout: "ok", exitCode: 0, durationMs: 1, timedOut: false });
    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const { runDiagnose } = await import("../src/commands/diagnose.js");
    const outFile = join(root, "report.json");
    await runDiagnose({
      task: "personality",
      judge: "claude:judge",
      agent: ["claude:a"],
      timeout: "1000",
      concurrency: "1",
      json: false,
      out: outFile,
    });

    expect(existsSync(outFile)).toBe(true);
    // sanity: file dir created
    mkdirSync(join(root, "nested"), { recursive: true });

    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it("runs evaluatees in parallel by default (concurrency 0 = all at once)", async () => {
    const captureMock = await setupCaptureMock();
    // Suspending mock so real concurrency is observable via peak in-flight count.
    let inflight = 0;
    let peak = 0;
    captureMock.mockImplementation(async (_spec: unknown, prompt: string) => {
      inflight++;
      if (inflight > peak) peak = inflight;
      await new Promise((r) => setTimeout(r, 5));
      inflight--;
      if (typeof prompt === "string" && prompt.includes("assessments")) {
        return {
          stdout: JSON.stringify({
            assessments: [
              { profileLabel: "claude:a", personalityType: "Ta", scores: {}, rationale: "" },
              { profileLabel: "claude:b", personalityType: "Tb", scores: {}, rationale: "" },
              { profileLabel: "claude:c", personalityType: "Tc", scores: {}, rationale: "" },
            ],
          }),
          exitCode: 0,
          durationMs: 5,
          timedOut: false,
        };
      }
      return { stdout: "resp", exitCode: 0, durationMs: 5, timedOut: false };
    });

    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const { runDiagnose } = await import("../src/commands/diagnose.js");
    await runDiagnose({
      task: "personality",
      judge: "claude:judge",
      agent: ["claude:a", "claude:b", "claude:c"],
      timeout: "1000",
      concurrency: "0", // default: all evaluatees in parallel
      json: true,
      out: undefined,
    });

    // 3 evaluatees must have been in flight simultaneously at some point.
    expect(peak).toBe(3);

    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });
});

describe("diagnose CLI validation", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "starling-diag-"));
    vi.resetModules();
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("exits when --judge is missing", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit:${code}`);
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { runDiagnose } = await import("../src/commands/diagnose.js");
    await expect(
      runDiagnose({
        task: "personality",
        judge: undefined,
        agent: ["claude:a"],
        timeout: "1000",
        concurrency: "1",
        json: false,
        out: undefined,
      })
    ).rejects.toThrow(/exit:1/);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("--judge"));
    exitSpy.mockRestore();
    errSpy.mockRestore();
  });

  it("exits when --agent is missing", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit:${code}`);
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { runDiagnose } = await import("../src/commands/diagnose.js");
    await expect(
      runDiagnose({
        task: "personality",
        judge: "claude:judge",
        agent: [],
        timeout: "1000",
        concurrency: "1",
        json: false,
        out: undefined,
      })
    ).rejects.toThrow(/exit:1/);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("--agent"));
    exitSpy.mockRestore();
    errSpy.mockRestore();
  });

  it("exits on unknown task", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit:${code}`);
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { runDiagnose } = await import("../src/commands/diagnose.js");
    await expect(
      runDiagnose({
        task: "nope",
        judge: "claude:judge",
        agent: ["claude:a"],
        timeout: "1000",
        concurrency: "1",
        json: false,
        out: undefined,
      })
    ).rejects.toThrow(/exit:1/);
    exitSpy.mockRestore();
    errSpy.mockRestore();
  });

  it("exits on invalid judge spec", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit:${code}`);
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { runDiagnose } = await import("../src/commands/diagnose.js");
    await expect(
      runDiagnose({
        task: "personality",
        judge: "notaspec",
        agent: ["claude:a"],
        timeout: "1000",
        concurrency: "1",
        json: false,
        out: undefined,
      })
    ).rejects.toThrow(/exit:1/);
    exitSpy.mockRestore();
    errSpy.mockRestore();
  });
});
