//! `starling model` — model profiles (Phase 6).

use anyhow::Result;
use colored::*;

use crate::cli::*;

pub fn handle(cmd: ModelCommand) -> Result<()> {
    match cmd {
        ModelCommand::List => list(),
        ModelCommand::Add { name } => add(&name),
        ModelCommand::Delete { name } => delete(&name),
        ModelCommand::Use { name } => use_cmd(&name),
    }
}

fn list() -> Result<()> {
    println!("{}", "model list: Phase 6".normal());
    Ok(())
}

fn add(_name: &str) -> Result<()> {
    eprintln!("{}", "model add: Phase 6".yellow());
    Ok(())
}

fn delete(_name: &str) -> Result<()> {
    eprintln!("{}", "model delete: Phase 6".yellow());
    Ok(())
}

fn use_cmd(_name: &str) -> Result<()> {
    eprintln!("{}", "model use: Phase 6".yellow());
    Ok(())
}
