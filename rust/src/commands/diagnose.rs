//! `starling diagnose` — benchmark suite (Phase 7).

use anyhow::Result;
use colored::*;

use crate::cli::*;

pub fn handle(cmd: DiagnoseCommand) -> Result<()> {
    match cmd {
        DiagnoseCommand::Run { agent } => run(agent.as_deref()),
        DiagnoseCommand::List => list(),
    }
}

fn run(_agent: Option<&str>) -> Result<()> {
    eprintln!("{}", "diagnose: Phase 7".yellow());
    Ok(())
}

fn list() -> Result<()> {
    println!("{}", "diagnose list: Phase 7".normal());
    Ok(())
}
