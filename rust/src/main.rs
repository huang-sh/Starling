use anyhow::Result;
use clap::Parser;
use std::any::Any;

mod types;
mod constants;
mod cli;
mod commands;
mod core;
mod diagnose;

fn main() -> Result<()> {
    std::panic::set_hook(Box::new(|info| {
        if !is_broken_pipe_panic(info.payload()) {
            eprintln!("{info}");
        }
    }));

    match std::panic::catch_unwind(|| {
        let args = cli::Cli::parse();
        args.run()
    }) {
        Ok(result) => result,
        Err(payload) if is_broken_pipe_panic(payload.as_ref()) => Ok(()),
        Err(payload) => std::panic::resume_unwind(payload),
    }
}

fn is_broken_pipe_panic(payload: &(dyn Any + Send)) -> bool {
    let message = payload
        .downcast_ref::<&str>()
        .map(|s| (*s).to_string())
        .or_else(|| payload.downcast_ref::<String>().cloned())
        .unwrap_or_default();
    message.contains("failed printing to stdout") && message.contains("Broken pipe")
}
