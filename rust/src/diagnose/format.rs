//! Report formatters (human + JSON).

use crate::diagnose::{DiagnoseReport, EvaluateeResult, JudgeVerdict};
use colored::*;

/// Human-readable report.
pub fn format_report_human(report: &DiagnoseReport) -> String {
    let mut out: Vec<String> = Vec::new();
    out.push(String::new());
    out.push(format!("{}", "═".repeat(64).cyan().bold()));
    out.push(format!(
        "{}",
        format!("  Diagnosis report — {}", report.task_name)
            .cyan()
            .bold()
    ));
    out.push(format!(
        "{}",
        format!(
            "  task: {}   judge: {}   started: {}",
            report.task, report.judge, report.started_at
        )
        .normal()
    ));
    out.push(format!("{}", "═".repeat(64).cyan().bold()));

    for ev in &report.evaluatees {
        out.push(String::new());
        out.push(format_evaluatee(ev));
    }

    out.push(String::new());
    out.push(format!("{}", "─".repeat(64).cyan().bold()));
    out.push(format!("{}", "  Judge verdict".cyan().bold()));
    out.push(format!("{}", "─".repeat(64).cyan().bold()));
    out.push(format_verdict(&report.verdict, &report.evaluatees));
    out.push(String::new());
    out.join("\n")
}

fn format_evaluatee(ev: &EvaluateeResult) -> String {
    let mut out: Vec<String> = Vec::new();
    let provider_str = match ev.provider {
        crate::diagnose::Provider::Claude => "claude",
        crate::diagnose::Provider::Codex => "codex",
    };
    out.push(format!(
        "{}  {}",
        format!("▸ {}", ev.profile_label).yellow().bold(),
        format!("({})", provider_str).normal()
    ));
    if let Some(err) = &ev.error {
        out.push(format!("{}", format!("  error: {}", err).red()));
        return out.join("\n");
    }
    for r in &ev.results {
        let status = if r.timed_out {
            " TIMEOUT ".on_red().white().to_string()
        } else if r.exit_code == 0 {
            "ok".green().to_string()
        } else {
            format!("exit {}", r.exit_code).red().to_string()
        };
        out.push(format!(
            "  {} {} {}",
            r.question_id.cyan(),
            format!("({}ms)", r.duration_ms).normal(),
            status
        ));
        if let Some(err) = &r.error {
            out.push(format!("{}", format!("    {}", err).normal()));
        }
        let body = if r.response.trim().is_empty() {
            "(empty)"
        } else {
            r.response.trim()
        };
        for line in body.lines() {
            out.push(format!("    {}", line));
        }
    }
    out.join("\n")
}

fn format_verdict(verdict: &JudgeVerdict, evaluatees: &[EvaluateeResult]) -> String {
    let mut out: Vec<String> = Vec::new();
    if let Some(err) = &verdict.parse_error {
        out.push(format!(
            "{}",
            format!("Could not parse structured verdict: {}", err).red()
        ));
        out.push(format!("{}", "Raw judge output:".normal()));
        out.push(verdict.raw.trim().to_string());
        return out.join("\n");
    }
    if verdict.assessments.is_empty() {
        out.push(format!("{}", "Judge returned no assessments.".yellow()));
        out.push(verdict.raw.trim().to_string());
        return out.join("\n");
    }
    for a in &verdict.assessments {
        out.push(String::new());
        out.push(format!(
            "{}  {}",
            format!("▸ {}", a.profile_label).yellow().bold(),
            if a.personality_type.is_empty() {
                "(no type)".to_string()
            } else {
                a.personality_type.clone()
            }
            .green()
        ));
        if !a.scores.is_empty() {
            let cols: Vec<String> = a
                .scores
                .iter()
                .map(|(k, v)| format!("{}:{}", k, v))
                .collect();
            out.push(format!("{}  {}", "scores  ".normal(), cols.join("  ")));
        }
        if !a.rationale.is_empty() {
            out.push(format!("{}  {}", "why     ".normal(), a.rationale));
        }
    }
    // Surface evaluatees the judge skipped.
    let assessed: std::collections::HashSet<&str> = verdict
        .assessments
        .iter()
        .map(|a| a.profile_label.as_str())
        .collect();
    for ev in evaluatees {
        if !assessed.contains(ev.profile_label.as_str()) {
            out.push(format!(
                "{}",
                format!("  (no assessment for {})", ev.profile_label).normal()
            ));
        }
    }
    out.join("\n")
}
