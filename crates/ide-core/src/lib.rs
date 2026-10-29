//! Shared vocabulary for every OpenIDEA crate.
//!
//! Anything that crosses a crate boundary or the IPC boundary lives here, so
//! feature crates depend on `ide-core` and never on each other's internals.
//! All IPC-facing types derive `specta::Type`, which generates `src/bindings.ts`.

pub mod editor_settings;
pub mod error;
pub mod event;
pub mod ids;
pub mod ignored;
pub mod inspection_settings;
pub mod ipc_path;
pub mod jsonc;
pub mod output_encoding;
pub mod process;
pub mod project_dir;
pub mod proxy_settings;
pub mod remote_settings;
pub mod settings;
pub mod task;
pub mod text;
pub mod version_managers;
pub mod workflow_settings;

pub use error::{IdeError, IdeResult};
pub use event::{EventSink, IdeEvent, NullSink, SharedSink};
pub use ids::*;
pub use ipc_path::IpcPath;
pub use text::*;
pub use tokio_util::sync::CancellationToken;
