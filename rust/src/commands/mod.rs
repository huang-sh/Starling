//! Command dispatch.

use anyhow::Result;

pub mod session;
pub mod pin;
pub mod catalog;
pub mod project;
pub mod config_cmd;
pub mod status;
pub mod monitor;
pub mod resume;
pub mod run;
pub mod model;
pub mod diagnose;

use crate::cli::*;

pub fn dispatch(command: Command) -> Result<()> {
    match command {
        Command::Session(c) => session::handle(c),
        Command::Pin { session_id, title, tags, to, current } => pin::run(session_id, title, tags, to, current),
        Command::Catalog(c) => catalog::handle(c),
        Command::Project(c) => project::handle(c),
        Command::Run(c) => run::handle(c),
        Command::Model(c) => model::handle(c),
        Command::Config(c) => config_cmd::handle(c),
        Command::Diagnose(c) => diagnose::handle(c),
        Command::Status(c) => status::handle(c),
        Command::Monitor(c) => monitor::handle(c),
        Command::Resume { session_id } => resume::run(&session_id),
    }
}
