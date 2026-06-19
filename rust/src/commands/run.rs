//! `starling run` — agent launch (Phase 6).

use anyhow::Result;
use colored::*;

use crate::cli::*;

pub fn handle(cmd: RunCommand) -> Result<()> {
    match cmd {
        RunCommand::Claude { args } => launch("claude", &args),
        RunCommand::Codex { args } => launch("codex", &args),
        RunCommand::Status { run_id } => status(run_id.as_deref()),
        RunCommand::Stop { run_id } => stop(&run_id),
    }
}

fn launch(provider: &str, args: &[String]) -> Result<()> {
    eprintln!("{}: launch not yet implemented (Phase 6); spawning bare {}.", "starling".cyan(), provider);
    let mut cmd = std::process::Command::new(provider);
    cmd.args(args);
    cmd.stdin(std::process::Stdio::inherit())
        .stdout(std::process::Stdio::inherit())
        .stderr(std::process::Stdio::inherit());
    match cmd.status() {
        Ok(s) => std::process::exit(s.code().unwrap_or(0)),
        Err(e) => {
            eprintln!("{}: failed to spawn {}: {}", "error".red(), provider, e);
            std::process::exit(1);
        }
    }
}

fn status(_run_id: Option<&str>) -> Result<()> {
    println!("{}", "run status: Phase 6".normal());
    Ok(())
}

fn stop(_run_id: &str) -> Result<()> {
    eprintln!("{}", "run stop: Phase 6".yellow());
    Ok(())
}
