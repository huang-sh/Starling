use anyhow::Result;
use clap::Parser;

mod types;
mod constants;
mod cli;
mod commands;
mod core;
mod diagnose;

fn main() -> Result<()> {
    let args = cli::Cli::parse();
    args.run()
}
