//! Resume an agent session. Mirrors src/index.ts resume + session.resume.

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

fn launch_resume(provider: &str, session_id: &str, _file_path: &str) -> Result<()> {
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
