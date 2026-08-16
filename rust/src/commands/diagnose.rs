//! `starling diagnose` — benchmark suite.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Instant;

use anyhow::{anyhow, Result};
use colored::*;

use crate::cli::DiagnoseCommand;
use crate::constants::now_iso;
use crate::diagnose::format::format_report_human;
use crate::diagnose::prompt::{build_judge_prompt, parse_judge_verdict};
use crate::diagnose::tasks::load_task;
use crate::diagnose::{
    parse_agent_spec, run_agent_capture, spec_label, EvaluateeResult, JudgeVerdict,
    PersonalityAssessment, Provider, QuestionResult,
};

pub fn handle(cmd: DiagnoseCommand) -> Result<()> {
    let timeout_ms: u64 = cmd
        .timeout
        .parse()
        .map_err(|_| anyhow!("--timeout must be a positive integer ms"))?;
    let concurrency: usize = cmd
        .concurrency
        .parse()
        .map_err(|_| anyhow!("--concurrency must be a non-negative integer (0 = all at once)"))?;

    if cmd.agent.is_empty() {
        return Err(anyhow!("diagnose requires at least one --agent <provider[:profile]>. Example: --agent claude:ds"));
    }

    let task = load_task(&cmd.task)?;

    // Validate all agent specs up front.
    let evaluatee_specs: Vec<_> = cmd
        .agent
        .iter()
        .map(|s| parse_agent_spec(s))
        .collect::<Result<Vec<_>>>()?;

    let judge_spec = match &cmd.judge {
        Some(j) => Some(parse_agent_spec(j)?),
        None => None,
    };

    let started_at = now_iso();
    eprintln!(
        "{}",
        format!(
            "Diagnosing task: {} ({} agents)",
            task.id,
            evaluatee_specs.len()
        )
        .cyan()
        .bold()
    );
    eprintln!(
        "{}",
        format!(
            "Judge: {}",
            judge_spec
                .as_ref()
                .map(|s| spec_label(s))
                .unwrap_or_else(|| "(none — no verdict)".into())
        )
        .normal()
    );

    // Run all evaluatees concurrently (bounded by concurrency).
    let evaluatees = run_evaluatees(&evaluatee_specs, &task, timeout_ms, concurrency);

    // Run the judge if specified.
    let verdict = if let Some(j) = judge_spec {
        eprintln!(
            "{}",
            format!("\nRunning judge: {}", spec_label(&j)).cyan().bold()
        );
        run_judge(&j, &task, &evaluatees, timeout_ms)
    } else {
        JudgeVerdict {
            assessments: vec![],
            raw: String::new(),
            exit_code: 0,
            duration_ms: 0,
            parse_error: Some("No judge configured (--judge).".to_string()),
        }
    };

    let report = crate::diagnose::DiagnoseReport {
        task: task.id.clone(),
        task_name: task.name.clone(),
        started_at,
        judge: cmd.judge.unwrap_or_default(),
        timeout_ms,
        evaluatees,
        verdict,
    };

    // Write JSON to file if --out.
    if let Some(out_path) = &cmd.out {
        let json = serde_json::to_string_pretty(&report)?;
        std::fs::write(out_path, json)?;
        eprintln!("{}", format!("Wrote JSON report: {}", out_path).green());
    }

    if cmd.json {
        println!("{}", serde_json::to_string_pretty(&report)?);
    } else {
        println!("{}", format_report_human(&report));
    }
    Ok(())
}

fn run_evaluatees(
    specs: &[crate::diagnose::AgentSpec],
    task: &crate::diagnose::Task,
    timeout_ms: u64,
    concurrency: usize,
) -> Vec<EvaluateeResult> {
    let n = specs.len();
    let workers = if concurrency == 0 {
        n.max(1)
    } else {
        concurrency.min(n)
    };
    let results: Arc<std::sync::Mutex<Vec<Option<EvaluateeResult>>>> =
        Arc::new(std::sync::Mutex::new(vec![None; n]));
    let next_idx: Arc<AtomicUsize> = Arc::new(AtomicUsize::new(0));
    let task_arc: Arc<crate::diagnose::Task> = Arc::new(task.clone());

    let mut handles = Vec::new();
    for _ in 0..workers {
        let specs_arc: Arc<Vec<crate::diagnose::AgentSpec>> = Arc::new(specs.to_vec());
        let results_clone = results.clone();
        let next_clone = next_idx.clone();
        let task_clone = task_arc.clone();
        let handle = std::thread::spawn(move || loop {
            let idx = next_clone.fetch_add(1, Ordering::SeqCst);
            if idx >= specs_arc.len() {
                break;
            }
            let spec = &specs_arc[idx];
            let label = spec_label(spec);
            eprintln!(
                "{}",
                format!("▸ Running {} (Q{}/{})", label, idx + 1, specs_arc.len()).normal()
            );
            let result = run_one_evaluatee(spec, &task_clone, timeout_ms);
            if let Ok(mut guard) = results_clone.lock() {
                guard[idx] = Some(result);
            }
        });
        handles.push(handle);
    }
    for h in handles {
        let _ = h.join();
    }

    let guard = results.lock().unwrap();
    guard
        .iter()
        .cloned()
        .map(|opt| {
            opt.unwrap_or_else(|| EvaluateeResult {
                spec: String::new(),
                profile_label: "(unknown)".to_string(),
                provider: Provider::Claude,
                results: vec![],
                error: Some("Internal error: evaluatee result missing".to_string()),
            })
        })
        .collect()
}

fn run_one_evaluatee(
    spec: &crate::diagnose::AgentSpec,
    task: &crate::diagnose::Task,
    timeout_ms: u64,
) -> EvaluateeResult {
    let label = spec_label(spec);
    let mut results: Vec<QuestionResult> = Vec::new();
    let mut had_error = false;

    for q in &task.questions {
        let cap = run_agent_capture(spec, &q.prompt, timeout_ms);
        let mut error: Option<String> = None;
        if let Some(spawn_err) = &cap.spawn_error {
            error = Some(spawn_err.clone());
            had_error = true;
        } else if cap.timed_out {
            error = Some(format!("timeout after {}ms", timeout_ms));
        } else if cap.exit_code != 0 {
            if let Some(stderr) = &cap.stderr {
                error = Some(format!("exit {}: {}", cap.exit_code, stderr));
            } else {
                error = Some(format!("exit {}", cap.exit_code));
            }
        }
        results.push(QuestionResult {
            question_id: q.id.clone(),
            prompt: q.prompt.clone(),
            response: cap.stdout,
            exit_code: cap.exit_code,
            duration_ms: cap.duration_ms,
            timed_out: cap.timed_out,
            error,
        });
        // Short-circuit if spawn failed — agent binary is missing entirely.
        if cap.spawn_error.is_some() {
            had_error = true;
            break;
        }
    }

    EvaluateeResult {
        spec: spec.raw.clone(),
        profile_label: label,
        provider: spec.provider.clone(),
        results,
        error: if had_error {
            Some("One or more questions failed to capture.".to_string())
        } else {
            None
        },
    }
}

fn run_judge(
    spec: &crate::diagnose::AgentSpec,
    task: &crate::diagnose::Task,
    evaluatees: &[EvaluateeResult],
    timeout_ms: u64,
) -> JudgeVerdict {
    let prompt = build_judge_prompt(task, evaluatees);
    let start = Instant::now();
    let cap = run_agent_capture(spec, &prompt, timeout_ms);
    let duration_ms = start.elapsed().as_millis() as u64;

    if let Some(spawn_err) = &cap.spawn_error {
        return JudgeVerdict {
            assessments: vec![],
            raw: String::new(),
            exit_code: -1,
            duration_ms,
            parse_error: Some(format!("Judge spawn failed: {}", spawn_err)),
        };
    }

    let mut verdict = parse_judge_verdict(&cap.stdout, evaluatees);
    verdict.exit_code = cap.exit_code;
    verdict.duration_ms = duration_ms;
    if cap.timed_out {
        verdict.parse_error = Some(format!("Judge timed out after {}ms", timeout_ms));
    } else if cap.exit_code != 0 {
        // Keep the parsed verdict (might still be salvageable) but note the error.
        if verdict.parse_error.is_none() {
            let stderr = cap.stderr.unwrap_or_default();
            verdict.parse_error = Some(format!("Judge exit {}: {}", cap.exit_code, stderr));
        }
    }
    verdict
}

// Allow constructing PersonalityAssessment in tests / external callers.
#[allow(dead_code)]
fn _anchor_pa(label: &str, t: &str) -> PersonalityAssessment {
    PersonalityAssessment {
        profile_label: label.to_string(),
        personality_type: t.to_string(),
        scores: Default::default(),
        rationale: String::new(),
    }
}
