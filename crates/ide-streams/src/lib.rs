//! Java Stream Debugger engine. Pure computation: no IO, no debugger transport.

mod catalog;
mod chain;
mod facts;
mod generate;
mod model;
mod normalize;
mod qualify;
mod qualify_tables;
mod resolve;

pub use catalog::OpRole;
pub use chain::*;
pub use facts::{Adjustment, Capture, ChainFacts, TextEdit, TypeQuery};
pub use generate::*;
pub use model::*;
pub use normalize::*;
pub use resolve::{distinct_drops, resolve, sorted_pass_through};
