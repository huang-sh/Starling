use anyhow::Result;
use clap::{Parser, Subcommand};

/// Agent session manager — discover, pin, and organize AI coding sessions.
#[derive(Parser)]
#[command(name = "starling", version, about)]
pub struct Cli {
    #[command(subcommand)]
    pub command: Command,
}

#[derive(Subcommand)]
pub enum Command {
    /// Resume an agent session directly
    Resume { session_id: String },
}

impl Cli {
    pub fn run(self) -> Result<()> {
        match self.command {
            Command::Resume { session_id } => crate::commands::resume::run(&session_id),
        }
    }
}
