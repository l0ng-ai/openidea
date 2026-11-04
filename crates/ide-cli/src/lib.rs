//! The `openidea` command.
//!
//! The command is the app's own executable run in CLI mode: it parses its
//! arguments ([`args`]), sends one [`Request`] to the running app over a local
//! socket ([`socket`]) and exits. [`install`] links the bundle's launcher
//! script into a directory on `PATH`.

pub mod args;
pub mod install;
pub mod socket;

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Bumped when [`Request`] changes incompatibly; an app still running an older
/// version answers with an error instead of misreading it.
pub const PROTOCOL_VERSION: u32 = 1;

/// A file or folder to open, with an optional 1-based position in a file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Target {
    /// Absolute.
    pub path: PathBuf,
    pub line: Option<u32>,
    pub column: Option<u32>,
}

/// What the command asks the running app to do. No targets: bring the app to the front.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Request {
    pub version: u32,
    pub targets: Vec<Target>,
}

impl Request {
    pub fn open(targets: Vec<Target>) -> Self {
        Self { version: PROTOCOL_VERSION, targets }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Response {
    Ok,
    Error { message: String },
}
