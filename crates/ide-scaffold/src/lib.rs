//! File › New Project: a catalog of project generators declared in `generators/*.toml`.
//! Each one writes built-in template files, runs a framework's official CLI, or
//! downloads the project a generation service (Spring Initializr, Quarkus, Micronaut)
//! builds, in any combination. See `engine` for how a project is created.

mod catalog;
mod engine;
mod model;
mod providers;
mod template;

pub use catalog::catalog;
pub use engine::{Emit, create, name_error, options, requirements};
pub use model::{
    ChoiceOption, CreateRequest, Dependency, DependencyGroup, Field, FieldKind, GeneratorInfo, Requirement,
    ScaffoldEvent, Values,
};
