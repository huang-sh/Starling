import chalk from "chalk";
import type { DiagnoseReport, EvaluateeResult, JudgeVerdict } from "./types.js";

/** Human-readable report. Progress lines go to stderr during the run; this is the final summary. */
export function formatReportHuman(report: DiagnoseReport): string {
  const out: string[] = [];
  out.push("");
  out.push(chalk.bold.cyan("═".repeat(64)));
  out.push(chalk.bold.cyan(`  Diagnosis report — ${report.taskName}`));
  out.push(chalk.gray(`  task: ${report.task}   judge: ${report.judge}   started: ${report.startedAt}`));
  out.push(chalk.cyan("═".repeat(64)));

  for (const ev of report.evaluatees) {
    out.push("");
    out.push(formatEvaluatee(ev));
  }

  out.push("");
  out.push(chalk.bold.cyan("─".repeat(64)));
  out.push(chalk.bold.cyan("  Judge verdict"));
  out.push(chalk.cyan("─".repeat(64)));
  out.push(formatVerdict(report.verdict, report.evaluatees));
  out.push("");
  return out.join("\n");
}

function formatEvaluatee(ev: EvaluateeResult): string {
  const out: string[] = [];
  out.push(chalk.bold.yellow(`▸ ${ev.profileLabel}  `) + chalk.gray(`(${ev.provider})`));
  if (ev.error) {
    out.push(chalk.red(`  error: ${ev.error}`));
    return out.join("\n");
  }
  for (const r of ev.results) {
    const status = r.timedOut
      ? chalk.bgRed.white(" TIMEOUT ")
      : r.exitCode === 0
        ? chalk.green("ok")
        : chalk.red(`exit ${r.exitCode}`);
    out.push(`  ${chalk.cyan(r.questionId)} ${chalk.gray(`(${r.durationMs}ms)`)} ${status}`);
    if (r.error) out.push(chalk.gray(`    ${r.error}`));
    const body = (r.response || "(empty)").trim();
    const indented = body.split("\n").map((l) => `    ${l}`).join("\n");
    out.push(indented);
  }
  return out.join("\n");
}

function formatVerdict(verdict: JudgeVerdict, evaluatees: EvaluateeResult[]): string {
  const out: string[] = [];
  if (verdict.parseError) {
    out.push(chalk.red(`Could not parse structured verdict: ${verdict.parseError}`));
    out.push(chalk.gray("Raw judge output:"));
    out.push(verdict.raw.trim());
    return out.join("\n");
  }
  if (verdict.assessments.length === 0) {
    out.push(chalk.yellow("Judge returned no assessments."));
    out.push(verdict.raw.trim());
    return out.join("\n");
  }
  for (const a of verdict.assessments) {
    out.push("");
    out.push(chalk.bold.yellow(`▸ ${a.profileLabel}`) + "  " + chalk.green(a.personalityType || "(no type)"));
    const scoreKeys = Object.keys(a.scores);
    if (scoreKeys.length > 0) {
      const cols = scoreKeys.map((k) => `${k}:${a.scores[k]}`);
      out.push(chalk.gray("  scores  ") + cols.join("  "));
    }
    if (a.rationale) {
      out.push(chalk.gray("  why     ") + a.rationale);
    }
  }
  // Surface evaluatees the judge skipped.
  const assessed = new Set(verdict.assessments.map((a) => a.profileLabel));
  for (const ev of evaluatees) {
    if (!assessed.has(ev.profileLabel)) {
      out.push(chalk.gray(`  (no assessment for ${ev.profileLabel})`));
    }
  }
  return out.join("\n");
}

/** Full structured JSON report (also used by --out and --json). */
export function formatReportJson(report: DiagnoseReport): string {
  return JSON.stringify(report, null, 2);
}
