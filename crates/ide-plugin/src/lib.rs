//! The WebAssembly runtime for plugins (wasmtime, component model, WASI
//! preview 2). Package handling, extension points and grants live in
//! `ide-extension`; the host that assembles them is `ide-host::plugins`.
//!
//! Each plugin with code runs in its own wasmtime `Store`: no files, env or
//! network beyond what [`HostApi`] grants, a fuel budget and wall-clock
//! deadline per call, and a linear-memory cap. A trap (panic, budget
//! exhausted, permission violation, cancellation) poisons the instance; the
//! host drops it. Each active plugin's runtime lives on its own [`Actor`] thread.

mod actor;
pub mod indexing;
mod runtime;
mod sandbox;
mod types;
mod wit_host;

pub use actor::{Actor, ActorError, Pending};
pub use runtime::{
    API_VERSION, CANCELLED, CallCancel, CallError, GuestError, HostApi, PluginEngine, Runtime, RuntimeSetup, check_api,
    component_api, host_api,
};
pub use sandbox::{MAX_READ_BYTES, inside_root, read_text, resolve_in_root, resolve_new_in_root, resolve_real};
pub use types::*;
pub use wasmtime::component::Component;

mod execution;
pub use execution::*;

pub use ide_core::remote_settings::PluginRunTarget;

pub mod language_features;
