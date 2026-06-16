import { Command } from "commander";
import chalk from "chalk";
import { writeFileSync } from "fs";
import { loadTask } from "../diagnose/tasks/index.js";
import { parseAgentSpec, specLabel, runAgentCapture } from "../diagnose/agentRunner.js";
import { buildJudgePrompt, parseJudgeVerdict } from "../diagnose/prompt.js";
import { formatReportHuman, formatReportJson } from "../diagnose/format.js";
import type {
  AgentSpec,
  DiagnoseReport,
  EvaluateeResult,
  JudgeVerdict,
  QuestionResult,
} from "../diagnose/types.js";

export interface DiagnoseOptions {
  task: string;
  judge: string | undefined;
  agent: string[];
  timeout: string;
  concurrency: string;
  json: boolean;
  out: string | undefined;
}

export function registerDiagnoseCommand(program: Command): void {
  const diagnose = new Command("diagnose")
    .alias("diag")
    .description("Run a benchmark task against one or more agents and have a judge agent assess them")
    .option("--task <task>", "benchmark task id", "personality")
    .option("--judge <provider[:profile]>", "judge/launcher agent, e.g. claude:sonnet / codex:gpt5 / claude (bare provider = default config)")
    .option("--agent <provider[:profile]>", "evaluatee agent (repeatable)", accumulate, [] as string[])
    .option("--timeout <ms>", "per-call timeout in ms", "120000")
    .option("--concurrency <n>", "max evaluatees to run in parallel; 0 = all at once", "0")
    .option("--json", "emit full report as JSON on stdout")
    .option("--out <file>", "write the JSON report to a file")
    .action(async (opts: DiagnoseOptions) => {
      await runDiagnose(opts).catch((err) => {
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      });
    });

  program.addCommand(diagnose);
}

function accumulate(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export async function runDiagnose(opts: DiagnoseOptions): Promise<void> {
  const timeoutMs = parsePositiveInt(opts.timeout, "timeout");
  const concurrencyRaw = parseNonNegativeInt(opts.concurrency, "concurrency");

  // Validate task up front.
  let task;
  try {
    task = loadTask(opts.task);
  } catch (err) {
    console.error(chalk.red(err instanceof Error ? err.message : String(err)));
    process.exit(1);
  }

  if (!opts.judge) {
    console.error(chalk.red("Missing required option: --judge <provider:profile>"));
    console.error(chalk.gray("Example: --judge claude:sonnet"));
    process.exit(1);
  }
  if (!opts.agent || opts.agent.length === 0) {
    console.error(chalk.red("Missing required option: --agent <provider:profile> (repeatable)"));
    console.error(chalk.gray("Example: --agent claude:ds --agent codex:gpt5"));
    process.exit(1);
  }

  // Parse all specs up front so we fail fast on typos.
  const judgeSpec = parseSpecOrExit(opts.judge, "--judge");
  const evaluateeSpecs = opts.agent.map((s) => parseSpecOrExit(s, "--agent"));

  // 0 = run every evaluatee at once (parallel by default).
  const concurrency = concurrencyRaw === 0 ? evaluateeSpecs.length : concurrencyRaw;

  const judgeLabel = specLabel(judgeSpec);
  const startedAt = new Date().toISOString();

  logProgress(chalk.bold.cyan(`Diagnose: ${task.name} (${task.id})`));
  logProgress(
    chalk.gray(
      `judge=${judgeLabel}  evaluatees=${evaluateeSpecs.length}  questions=${task.questions.length}  timeout=${timeoutMs}ms  concurrency=${concurrency}`
    )
  );

  // Distribute questions to evaluatees (concurrency-limited).
  const evaluateeResults = await runWithConcurrency(
    evaluateeSpecs,
    concurrency,
    async (spec: AgentSpec): Promise<EvaluateeResult> => {
      const label = specLabel(spec);
      logProgress(chalk.cyan(`▸ ${label}  starting (${task.questions.length} questions)`));
      const results: QuestionResult[] = [];
      for (let i = 0; i < task.questions.length; i++) {
        const question = task.questions[i];
        logProgress(chalk.gray(`  ${label}  Q${i + 1}/${task.questions.length} [${question.dimension}]`));
        const capture = await runAgentCapture(spec, question.prompt, timeoutMs);
        const result: QuestionResult = {
          questionId: question.id,
          prompt: question.prompt,
          response: capture.stdout.trim(),
          exitCode: capture.exitCode,
          durationMs: capture.durationMs,
          timedOut: capture.timedOut,
        };
        if (capture.spawnError) result.error = capture.spawnError;
        else if (capture.exitCode !== 0 && !capture.timedOut) {
          result.error = capture.stderr ? `exit ${capture.exitCode}: ${capture.stderr.slice(0, 500)}` : `exit ${capture.exitCode}`;
        } else if (capture.timedOut) {
          result.error = `timed out after ${timeoutMs}ms`;
        }
        results.push(result);
      }
      const errored = results.every((r) => r.error);
      const evaluatee: EvaluateeResult = {
        spec: spec.raw,
        profileLabel: label,
        provider: spec.provider,
        results,
        ...(errored ? { error: "all questions failed" } : {}),
      };
      logProgress(
        errored
          ? chalk.red(`  ${label}  done (all questions failed)`)
          : chalk.green(`  ${label}  done`)
      );
      return evaluatee;
    }
  );

  // Hand everything to the judge.
  logProgress(chalk.cyan(`▸ ${judgeLabel}  judging ${evaluateeResults.length} evaluatee(s)`));
  const judgePrompt = buildJudgePrompt(task, evaluateeResults);
  const judgeCapture = await runAgentCapture(judgeSpec, judgePrompt, timeoutMs);
  const verdict: JudgeVerdict = {
    ...parseJudgeVerdict(judgeCapture.stdout, evaluateeResults),
    exitCode: judgeCapture.exitCode,
    durationMs: judgeCapture.durationMs,
  };
  if (judgeCapture.spawnError) {
    verdict.parseError = `judge failed to start: ${judgeCapture.spawnError}`;
  } else if (judgeCapture.timedOut) {
    verdict.parseError = `judge timed out after ${timeoutMs}ms`;
  } else if (judgeCapture.exitCode !== 0 && !verdict.assessments.length) {
    verdict.parseError = `judge exited ${judgeCapture.exitCode}${judgeCapture.stderr ? `: ${judgeCapture.stderr.slice(0, 500)}` : ""}`;
  }
  logProgress(chalk.green(`▸ ${judgeLabel}  done (${verdict.assessments.length} assessments)`));

  const report: DiagnoseReport = {
    task: task.id,
    taskName: task.name,
    startedAt,
    judge: judgeLabel,
    timeoutMs,
    evaluatees: evaluateeResults,
    verdict,
  };

  if (opts.out) {
    writeFileSync(opts.out, formatReportJson(report), "utf-8");
    logProgress(chalk.gray(`report written to ${opts.out}`));
  }

  if (opts.json) {
    process.stdout.write(formatReportJson(report) + "\n");
  } else {
    process.stdout.write(formatReportHuman(report) + "\n");
  }
}

function parseSpecOrExit(spec: string, flag: string): AgentSpec {
  try {
    return parseAgentSpec(spec);
  } catch (err) {
    console.error(chalk.red(`Invalid ${flag} spec: ${err instanceof Error ? err.message : String(err)}`));
    process.exit(1);
  }
}

function parsePositiveInt(value: string, name: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    console.error(chalk.red(`--${name} must be a positive integer, got "${value}".`));
    process.exit(1);
  }
  return n;
}

function parseNonNegativeInt(value: string, name: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    console.error(chalk.red(`--${name} must be a non-negative integer, got "${value}".`));
    process.exit(1);
  }
  return n;
}

/** Log to stderr so stdout stays clean for --json. */
function logProgress(message: string): void {
  console.error(message);
}

/** Run async tasks with a max concurrency limit, preserving input order in the output. */
async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const size = Math.max(1, Math.min(limit, items.length));
  async function runOne(): Promise<void> {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index]);
    }
  }
  await Promise.all(Array.from({ length: size }, () => runOne()));
  return results;
}
