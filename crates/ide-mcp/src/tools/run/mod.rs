//! Run configurations, builds and terminal commands (they ask the user first unless brave mode is on).

mod build;
mod configs;
mod output;
mod process;
mod targets;
mod terminal;

use crate::tool::{Call, Tool};
use ide_core::IdeResult;
use std::time::Duration;

pub fn tools() -> Vec<Tool> {
    vec![
        configs::get_run_configurations(),
        configs::execute_run_configuration(),
        terminal::execute_terminal_command(),
        build::build_project(),
    ]
}

/// The `timeout` argument: `default` when absent, at most `max` milliseconds. As in JetBrains
/// (`withTimeoutOrNull`), zero or a negative value times out at once.
fn timeout(call: &Call, default: usize, max: usize) -> IdeResult<Duration> {
    Ok(match call.opt_i64("timeout")? {
        None => Duration::from_millis(default as u64),
        Some(n) if n <= 0 => Duration::ZERO,
        Some(n) => Duration::from_millis((n as u64).min(max as u64)),
    })
}
