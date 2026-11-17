//! Java Stream Debugger engine. Pure computation: no IO, no debugger transport.

mod catalog;
mod chain;
mod model;
mod real_run;
mod resolve;

pub use catalog::{OpRole, SourceFamily, step_kind};
pub use chain::*;
pub use model::*;
pub use real_run::*;
pub use resolve::{distinct_drops, resolve, sorted_pass_through};
