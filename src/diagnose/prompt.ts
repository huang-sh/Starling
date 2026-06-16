import type {
  EvaluateeResult,
  JudgeVerdict,
  PersonalityAssessment,
  Task,
} from "./types.js";

/**
 * Build the single user prompt handed to the judge agent. It contains the
 * rubric (every question + its response-pattern guidance), the 1-5 scoring
 * table, every evaluatee's full Q&A, and a strict JSON output contract.
 *
 * claude -p / codex exec accept a single user prompt, so the whole context is
 * concatenated into one string (no system/message split).
 */
export function buildJudgePrompt(task: Task, evaluatees: EvaluateeResult[]): string {
  const lines: string[] = [];

  lines.push("你是一位 LLM 性格评估专家。下面是一项 LLM 性格倾向测试，以及若干被评估 agent 的真实回答。");
  lines.push("请根据每个 agent 的回答，判断其性格类型，并对每个维度打 1-5 分。");
  lines.push("");

  lines.push(`## 测试：${task.name}`);
  if (task.description) lines.push(task.description);
  lines.push("");

  lines.push("## 题目与评分指引");
  task.questions.forEach((q, i) => {
    lines.push(`${i + 1}. [${q.dimension}]`);
    lines.push(`题目：${q.prompt}`);
    lines.push(`判断参考：${q.rubric}`);
    lines.push("");
  });

  lines.push("## 维度评分表（1-5 分）");
  lines.push("| 维度 | 1 分 (low) | 5 分 (high) |");
  lines.push("| --- | --- | --- |");
  for (const dim of task.scoringDimensions) {
    lines.push(`| ${dim.name} | ${dim.low} | ${dim.high} |`);
  }
  lines.push("");

  if (task.judgeInstructions) {
    lines.push("## 总体归类指引");
    lines.push(task.judgeInstructions);
    lines.push("");
  }

  lines.push("## 被评估 agent 的回答");
  evaluatees.forEach((ev, idx) => {
    lines.push("");
    lines.push(`### Agent ${idx + 1}: ${ev.profileLabel}`);
    if (ev.error) {
      lines.push(`(该 agent 执行出错：${ev.error}，无法评估，请在 assessments 中用 personalityType "评估失败" 标注。)`);
      return;
    }
    for (const r of ev.results) {
      const qIndex = task.questions.findIndex((q) => q.id === r.questionId);
      const qLabel = qIndex >= 0 ? `Q${qIndex + 1}` : r.questionId;
      lines.push(`${qLabel} [${task.questions[qIndex]?.dimension ?? ""}]`);
      lines.push(`问：${r.prompt}`);
      lines.push(`答：${r.timedOut ? "(超时未响应)" : r.response || "(空回答)"}`);
    }
  });

  lines.push("");
  lines.push("## 输出要求");
  lines.push("只输出一个 JSON 对象，不要 markdown 代码块，不要任何额外说明。格式如下：");
  lines.push(
    '{"assessments":[{"profileLabel":"<与上面完全一致的 profileLabel>","personalityType":"<性格类型>","scores":{"服从性":1,"边界感":3,...},"rationale":"<判断依据，简明扼要>"}]}'
  );
  lines.push("scores 必须包含全部 " + task.scoringDimensions.length + " 个维度，每个值为 1-5 的整数。");
  lines.push("assessments 的数量和顺序要与被评估 agent 一致。");

  return lines.join("\n");
}

/**
 * Defensively parse the judge's JSON verdict. Strips markdown fences and
 * leading/trailing prose, extracts the outermost JSON object, and tolerates
 * missing/invalid scores. Never throws: on total failure returns an empty
 * assessments array with parseError set and the raw text preserved.
 */
export function parseJudgeVerdict(
  raw: string,
  evaluatees: EvaluateeResult[]
): JudgeVerdict {
  const assessments: PersonalityAssessment[] = [];
  const fallback = (parseError: string): JudgeVerdict => ({
    assessments,
    raw,
    exitCode: 0,
    durationMs: 0,
    parseError,
  });
  if (!raw || !raw.trim()) {
    return fallback("Judge returned empty output.");
  }

  const stripped = raw
    .replace(/^[\s\S]*?```(?:json)?\s*/i, "")
    .replace(/\s*```[\s\S]*$/i, "")
    .trim();

  const firstBrace = stripped.indexOf("{");
  const lastBrace = stripped.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    return fallback("Judge output contained no JSON object.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped.slice(firstBrace, lastBrace + 1));
  } catch (err) {
    return fallback(`Judge JSON parse failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const obj = parsed as { assessments?: unknown };
  if (!obj || typeof obj !== "object" || !Array.isArray(obj.assessments)) {
    return fallback("Judge JSON missing `assessments` array.");
  }

  const expectedLabels = evaluatees.map((e) => e.profileLabel);
  for (const entry of obj.assessments as unknown[]) {
    const a = entry as {
      profileLabel?: unknown;
      personalityType?: unknown;
      scores?: unknown;
      rationale?: unknown;
    };
    const profileLabel = typeof a.profileLabel === "string" ? a.profileLabel : "";
    const label = profileLabel || (expectedLabels[assessments.length] ?? `agent-${assessments.length + 1}`);
    const scores: Record<string, number> = {};
    if (a.scores && typeof a.scores === "object") {
      for (const [k, v] of Object.entries(a.scores as Record<string, unknown>)) {
        const n = typeof v === "number" ? v : Number(v);
        if (Number.isFinite(n)) scores[k] = Math.max(1, Math.min(5, Math.round(n)));
      }
    }
    assessments.push({
      profileLabel: label,
      personalityType: typeof a.personalityType === "string" ? a.personalityType : "",
      scores,
      rationale: typeof a.rationale === "string" ? a.rationale : "",
    });
  }

  return { assessments, raw, exitCode: 0, durationMs: 0 };
}
