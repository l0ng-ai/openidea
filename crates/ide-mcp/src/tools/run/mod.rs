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

/// The `timeout` argument: `default` when absent, at most `max` milliseconds.
fn timeout(call: &Call, default: usize, max: usize) -> IdeResult<Duration> {
    Ok(Duration::from_millis(call.count("timeout", default, max)? as u64))
}
