//! Java Stream Debugger engine. Pure computation: no IO, no debugger transport.

mod catalog;
mod chain;
mod facts;
mod model;
mod normalize;

pub use catalog::OpRole;
pub use chain::*;
pub use facts::{Adjustment, ChainFacts, TextEdit};
pub use model::*;
pub use normalize::*;
