//! Run configurations, builds and agent commands; every start asks the user first.

pub(crate) mod agent;
mod agent_tools;
mod build;
mod configs;
mod output;
mod process;
mod targets;

use crate::mcp::tool::{Call, Tool};
use ide_core::IdeResult;
use std::time::Duration;

pub fn tools() -> Vec<Tool> {
    let mut tools =
        vec![configs::get_run_configurations(), configs::execute_run_configuration(), build::build_project()];
    tools.extend(agent_tools::tools());
    tools
}

/// Longest wait: far enough to be no limit, near enough not to overflow a deadline.
const FOREVER_MS: u64 = 365 * 24 * 60 * 60 * 1000;

/// The `timeout` argument in milliseconds, `default` when absent: the agent decides how long
/// to wait (long waits are answered on an event stream, see `ide_mcp`). As in JetBrains
/// (`withTimeoutOrNull`), zero or a negative value times out at once.
pub(crate) fn timeout(call: &Call, default: usize) -> IdeResult<Duration> {
    Ok(match call.opt_i64("timeout")? {
        None => Duration::from_millis(default as u64),
        Some(n) if n <= 0 => Duration::ZERO,
        Some(n) => Duration::from_millis((n as u64).min(FOREVER_MS)),
    })
}
