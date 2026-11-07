//! Java Stream Debugger engine. Pure computation: no IO, no debugger transport.

#[cfg_attr(not(test), expect(dead_code, reason = "consumed by chain discovery, which lands next"))]
mod catalog;
mod model;

pub use catalog::OpRole;
pub use model::*;
