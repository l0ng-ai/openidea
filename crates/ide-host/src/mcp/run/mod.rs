//! Run configurations and builds; every call asks the user first.

mod build;
mod configs;
mod output;
mod process;
mod targets;

use crate::mcp::tool::{Call, Tool};
use ide_core::IdeResult;
use std::time::Duration;

pub fn tools() -> Vec<Tool> {
    vec![configs::get_run_configurations(), configs::execute_run_configuration(), build::build_project()]
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
