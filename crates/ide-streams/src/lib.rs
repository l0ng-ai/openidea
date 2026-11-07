//! Java Stream Debugger engine. Pure computation: no IO, no debugger transport.

mod catalog;
mod chain;
mod facts;
mod model;
mod normalize;
mod qualify;
mod qualify_tables;

pub use catalog::OpRole;
pub use chain::*;
pub use facts::{Adjustment, Capture, ChainFacts, TextEdit, TypeQuery};
pub use model::*;
pub use normalize::*;
