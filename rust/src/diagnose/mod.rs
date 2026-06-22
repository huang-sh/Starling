//! Diagnose framework — types + agent runner.

pub mod format;
pub mod prompt;
pub mod tasks;

use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Claude,
    Codex,
}

/// A parsed agent spec from the `provider:profile` CLI syntax.
#[derive(Debug, Clone)]
pub struct AgentSpec {
    pub provider: Provider,
    pub profile: String,
    pub raw: String,
}

/// Parse a `provider:profile` spec string.
/// `claude:` → Claude with empty profile (agent default config).
/// `claude:ds` → Claude with profile "ds".
/// A bare provider name (e.g. "claude", "codex") = default config.
pub fn parse_agent_spec(spec: &str) -> Result<AgentSpec> {
    let trimmed = spec.trim();
    if trimmed.is_empty() {
        return Err(anyhow!(
            "Empty agent spec. Use the form `provider:profile`, e.g. `claude:ds`."
        ));
    }
    let (provider_str, profile) = match trimmed.find(':') {
        Some(i) => (&trimmed[..i], &trimmed[i + 1..]),
        None => (trimmed, ""),
    };
    let provider = match provider_str {
        "claude" => Provider::Claude,
        "codex" => Provider::Codex,
        other => {
            return Err(anyhow!(
                "Invalid agent spec \"{}\": unknown provider \"{}\". Allowed: claude, codex.",
                spec,
                other
            ))
        }
    };
    Ok(AgentSpec {
        provider,
        profile: profile.to_string(),
        raw: spec.to_string(),
    })
}

/// A human-readable label for an agent spec.
pub fn spec_label(spec: &AgentSpec) -> String {
    let p = match spec.provider {
        Provider::Claude => "claude",
        Provider::Codex => "codex",
    };
    if spec.profile.is_empty() {
        format!("{}:default", p)
    } else {
        format!("{}:{}", p, spec.profile)
    }
}

/// A single benchmark question with its scoring rubric.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Question {
    pub id: String,
    pub dimension: String,
    pub prompt: String,
    /// Response-pattern -> personality-type guidance for the judge.
    pub rubric: String,
}

/// A named anchor for a 1-5 scoring dimension.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScoringDimension {
    pub name: String,
    pub low: String,
    pub high: String,
}

/// A diagnosable task definition.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Task {
    pub id: String,
    pub name: String,
    pub description: String,
    pub questions: Vec<Question>,
    pub scoring_dimensions: Vec<ScoringDimension>,
    /// Closing guidance for the judge.
    pub judge_instructions: String,
}

/// One captured answer from an evaluatee.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuestionResult {
    pub question_id: String,
    pub prompt: String,
    pub response: String,
    pub exit_code: i32,
    pub duration_ms: u64,
    pub timed_out: bool,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub error: Option<String>,
}

/// All answers from one evaluatee agent across the task.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EvaluateeResult {
    pub spec: String,
    pub profile_label: String,
    pub provider: Provider,
    pub results: Vec<QuestionResult>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub error: Option<String>,
}

/// The judge's assessment of one evaluatee.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PersonalityAssessment {
    pub profile_label: String,
    pub personality_type: String,
    pub scores: std::collections::BTreeMap<String, i32>,
    pub rationale: String,
}

/// Parsed (or raw fallback) output from the judge agent.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JudgeVerdict {
    pub assessments: Vec<PersonalityAssessment>,
    pub raw: String,
    pub exit_code: i32,
    pub duration_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub parse_error: Option<String>,
}

/// The full diagnose run report.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiagnoseReport {
    pub task: String,
    pub task_name: String,
    pub started_at: String,
    pub judge: String,
    pub timeout_ms: u64,
    pub evaluatees: Vec<EvaluateeResult>,
    pub verdict: JudgeVerdict,
}

/// Result of a single non-interactive agent invocation.
#[derive(Debug, Clone)]
pub struct AgentCaptureResult {
    pub stdout: String,
    pub exit_code: i32,
    pub duration_ms: u64,
    pub timed_out: bool,
    pub stderr: Option<String>,
    pub spawn_error: Option<String>,
}

const CAPTURE_STDOUT_MAX_BYTES: usize = 2 * 1024 * 1024;
const CAPTURE_STDERR_MAX_BYTES: usize = 64 * 1024;
const CAPTURE_SIGKILL_GRACE_MS: u64 = 5000;

/// Run a single non-interactive agent invocation (`claude -p` or `codex exec`)
/// capturing stdout/stderr with a timeout. Profile application is a stub —
/// for now the bare agent binary is invoked. (Phase 7 baseline.)
pub fn run_agent_capture(
    spec: &AgentSpec,
    user_prompt: &str,
    timeout_ms: u64,
) -> AgentCaptureResult {
    let start = Instant::now();
    let bin = match spec.provider {
        Provider::Claude => "claude",
        Provider::Codex => "codex",
    };

    let mut cmd = match spec.provider {
        Provider::Claude => {
            let mut c = Command::new(bin);
            c.arg("-p").arg(user_prompt);
            c
        }
        Provider::Codex => {
            let mut c = Command::new(bin);
            c.arg("exec").arg(user_prompt);
            c
        }
    };
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            return AgentCaptureResult {
                stdout: String::new(),
                exit_code: -1,
                duration_ms: start.elapsed().as_millis() as u64,
                timed_out: false,
                stderr: None,
                spawn_error: Some(format!("{}: {}", bin, e)),
            };
        }
    };
    let child_id = child.id();

    // Wait with timeout. We poll wait() in 50ms slices.
    let mut waited_ok: Option<std::io::Result<std::process::ExitStatus>> = None;
    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    while Instant::now() < deadline {
        match child.try_wait() {
            Ok(Some(status)) => {
                waited_ok = Some(Ok(status));
                break;
            }
            Ok(None) => {
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => {
                waited_ok = Some(Err(e));
                break;
            }
        }
    }

    let timed_out = waited_ok.is_none();
    if timed_out {
        terminate_child(&mut child, child_id, false);
        let kill_deadline = Instant::now() + Duration::from_millis(CAPTURE_SIGKILL_GRACE_MS);
        while Instant::now() < kill_deadline {
            if let Ok(Some(_)) = child.try_wait() {
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        if child.try_wait().ok().flatten().is_none() {
            terminate_child(&mut child, child_id, true);
        }
    }

    let output = match child.wait_with_output() {
        Ok(o) => o,
        Err(_) => {
            return AgentCaptureResult {
                stdout: String::new(),
                exit_code: -1,
                duration_ms: start.elapsed().as_millis() as u64,
                timed_out,
                stderr: Some("wait_with_output failed".to_string()),
                spawn_error: None,
            };
        }
    };

    let duration_ms = start.elapsed().as_millis() as u64;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stdout = if stdout.len() > CAPTURE_STDOUT_MAX_BYTES {
        stdout[..CAPTURE_STDOUT_MAX_BYTES].to_string()
    } else {
        stdout.to_string()
    };
    let stderr = String::from_utf8_lossy(&output.stderr);
    let stderr_capped = if stderr.len() > CAPTURE_STDERR_MAX_BYTES {
        stderr[..CAPTURE_STDERR_MAX_BYTES].to_string()
    } else {
        stderr.to_string()
    };

    AgentCaptureResult {
        stdout,
        exit_code: output.status.code().unwrap_or(-1),
        duration_ms,
        timed_out,
        stderr: if stderr_capped.is_empty() {
            None
        } else {
            Some(stderr_capped)
        },
        spawn_error: None,
    }
}

#[cfg(unix)]
fn terminate_child(_child: &mut std::process::Child, child_id: u32, force: bool) {
    let signal = if force { libc::SIGKILL } else { libc::SIGTERM };
    unsafe {
        libc::kill(child_id as i32, signal);
    }
}

#[cfg(not(unix))]
fn terminate_child(child: &mut std::process::Child, _child_id: u32, _force: bool) {
    let _ = child.kill();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_bare_provider() {
        let s = parse_agent_spec("claude").unwrap();
        assert!(matches!(s.provider, Provider::Claude));
        assert_eq!(s.profile, "");
    }

    #[test]
    fn parses_provider_with_profile() {
        let s = parse_agent_spec("codex:gpt5").unwrap();
        assert!(matches!(s.provider, Provider::Codex));
        assert_eq!(s.profile, "gpt5");
    }

    #[test]
    fn rejects_unknown_provider() {
        assert!(parse_agent_spec("gemini").is_err());
        assert!(parse_agent_spec("foo:bar").is_err());
    }

    #[test]
    fn rejects_empty_spec() {
        assert!(parse_agent_spec("").is_err());
        assert!(parse_agent_spec("   ").is_err());
    }

    #[test]
    fn spec_label_includes_profile_or_default() {
        let with_profile = parse_agent_spec("claude:ds").unwrap();
        assert!(spec_label(&with_profile).contains("claude"));
        assert!(spec_label(&with_profile).contains("ds"));

        let bare = parse_agent_spec("claude").unwrap();
        assert!(spec_label(&bare).contains("default"));
    }

    #[test]
    fn trailing_profile_segment_after_colon_is_kept() {
        // claude:foo:bar keeps "foo:bar" as the profile (colons allowed in profile names)
        let s = parse_agent_spec("claude:foo:bar").unwrap();
        assert_eq!(s.profile, "foo:bar");
    }
}
