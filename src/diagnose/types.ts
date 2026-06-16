// Shared types for the `starling diagnose` benchmark harness.

export type Provider = "claude" | "codex";

/**
 * A parsed agent spec from the `provider:profile` CLI syntax.
 * `profile` is the empty string when the user passes `provider:` (agent default config).
 */
export interface AgentSpec {
  provider: Provider;
  profile: string;
  /** Original spec string, e.g. `claude:ds`. */
  raw: string;
}

/** A single benchmark question with its scoring rubric. */
export interface Question {
  id: string;
  dimension: string;
  prompt: string;
  /** Response-pattern -> personality-type guidance for the judge. */
  rubric: string;
}

/** A named anchor for a 1-5 scoring dimension. */
export interface ScoringDimension {
  name: string;
  low: string;
  high: string;
}

/** A diagnosable task definition. */
export interface Task {
  id: string;
  name: string;
  description: string;
  questions: Question[];
  scoringDimensions: ScoringDimension[];
  /** Closing guidance for the judge (overall classification + scoring notes). */
  judgeInstructions: string;
}

/** One captured answer from an evaluatee. */
export interface QuestionResult {
  questionId: string;
  prompt: string;
  response: string;
  exitCode: number;
  durationMs: number;
  timedOut: boolean;
  error?: string;
}

/** All answers from one evaluatee agent across the task. */
export interface EvaluateeResult {
  spec: string;
  profileLabel: string;
  provider: Provider;
  results: QuestionResult[];
  error?: string;
}

/** The judge's assessment of one evaluatee. */
export interface PersonalityAssessment {
  profileLabel: string;
  personalityType: string;
  scores: Record<string, number>;
  rationale: string;
}

/** Parsed (or raw fallback) output from the judge agent. */
export interface JudgeVerdict {
  assessments: PersonalityAssessment[];
  raw: string;
  exitCode: number;
  durationMs: number;
  parseError?: string;
}

/** The full diagnose run report. */
export interface DiagnoseReport {
  task: string;
  taskName: string;
  startedAt: string;
  judge: string;
  timeoutMs: number;
  evaluatees: EvaluateeResult[];
  verdict: JudgeVerdict;
}

/** Result of a single non-interactive agent invocation. */
export interface AgentCaptureResult {
  stdout: string;
  exitCode: number;
  durationMs: number;
  timedOut: boolean;
  /** Stderr snippet (capped) for diagnostics when exitCode != 0. */
  stderr?: string;
  /** Set when the binary failed to spawn (ENOENT etc.). */
  spawnError?: string;
}
