//! Java Stream Debugger engine. Pure computation: no IO, no debugger transport.

mod catalog;
mod chain;
mod model;

pub use catalog::OpRole;
pub use chain::*;
pub use model::*;
