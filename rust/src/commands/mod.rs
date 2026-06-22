//! Command dispatch.

use anyhow::Result;

pub mod catalog;
pub mod config_cmd;
pub mod diagnose;
pub mod model;
pub mod monitor;
pub mod pin;
pub mod project;
pub mod resume;
pub mod run;
pub mod session;

use crate::cli::*;

pub fn dispatch(command: Command) -> Result<()> {
    match command {
        Command::Session(c) => session::handle(c),
        Command::Pin {
            session_id,
            title,
            tags,
            to,
            current,
            json,
        } => pin::run(session_id, title, tags, to, current, json),
        Command::Catalog(c) => catalog::handle(c),
        Command::Project(c) => project::handle(c),
        Command::Run(c) => run::handle(c),
        Command::Model(c) => model::handle(c),
        Command::Config(c) => config_cmd::handle(c),
        Command::Diagnose(c) => diagnose::handle(c),
        Command::Top(c) => monitor::handle(c),
        Command::Resume { session_id } => resume::run(&session_id),
    }
}

pub fn print_json_result(action: &str, message: &str, data: serde_json::Value) -> Result<()> {
    let payload = serde_json::json!({
        "ok": true,
        "action": action,
        "message": message,
        "data": data,
    });
    println!("{}", serde_json::to_string_pretty(&payload)?);
    Ok(())
}
