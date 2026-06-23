//! Resume an agent session. Mirrors src/index.ts resume + session.resume.

use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{anyhow, Result};
use colored::*;

use crate::core::discovery::find_session_by_id;
use crate::core::session_display::short_session_id;

pub fn run(session_id: &str) -> Result<()> {
    let meta = match find_session_by_id(session_id) {
        Some(m) => m,
        None => {
            eprintln!("{}: session not found: {}", "error".red(), session_id);
            std::process::exit(1);
        }
    };
    launch_resume(&meta.provider, &meta.session_id, &meta.file_path)
}

fn launch_resume(provider: &str, session_id: &str, file_path: &str) -> Result<()> {
    eprintln!(
        "{}: resuming {} {}",
        "starling".cyan(),
        provider,
        short_session_id(session_id)
    );
    let mut cmd = match provider {
        "codex" => {
            let mut c = Command::new("codex");
            c.arg("resume").arg(session_id);
            if let Some(home) = codex_home_from_session_path(file_path) {
                c.env("CODEX_HOME", home);
            }
            c
        }
        _ => {
            let mut c = Command::new("claude");
            c.arg("--resume").arg(session_id);
            c
        }
    };
    cmd.stdin(std::process::Stdio::inherit())
        .stdout(std::process::Stdio::inherit())
        .stderr(std::process::Stdio::inherit());
    let status = cmd.status().map_err(|e| anyhow!("spawn {provider}: {e}"))?;
    if !status.success() {
        std::process::exit(status.code().unwrap_or(1));
    }
    Ok(())
}

fn codex_home_from_session_path(file_path: &str) -> Option<PathBuf> {
    let path = Path::new(file_path);
    let mut cursor = path.parent();
    while let Some(dir) = cursor {
        let name = dir.file_name().and_then(|s| s.to_str()).unwrap_or_default();
        if name == "sessions" || name == "archived_sessions" {
            let home = dir.parent()?;
            let home_name = home
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or_default();
            if home_name.starts_with("codex-") {
                return Some(home.to_path_buf());
            }
            return None;
        }
        cursor = dir.parent();
    }
    None
}

#[cfg(test)]
mod tests {
    use super::codex_home_from_session_path;
    use std::path::PathBuf;

    #[test]
    fn derives_codex_home_from_starling_run_home_session() {
        let path = "/home/u/.starling/run-homes/codex-run-1/sessions/2026/06/22/rollout.jsonl";
        assert_eq!(
            codex_home_from_session_path(path),
            Some(PathBuf::from("/home/u/.starling/run-homes/codex-run-1"))
        );
    }

    #[test]
    fn leaves_default_codex_sessions_alone() {
        let path = "/home/u/.codex/sessions/2026/06/22/rollout.jsonl";
        assert_eq!(codex_home_from_session_path(path), None);
    }
}
