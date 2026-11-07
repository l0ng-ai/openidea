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
    #[serde(default)]
    pub diff: bool,
}

impl Request {
    pub fn open(targets: Vec<Target>) -> Self {
        Self { version: PROTOCOL_VERSION, targets, diff: false }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Response {
    Ok,
    Error { message: String },
}

/// A GUI subsystem executable inherits redirected handles, but needs its parent's
/// console for interactive help and errors. Batch launchers wait for this process.
#[cfg(windows)]
pub fn attach_console() {
    use windows_sys::Win32::Storage::FileSystem::{FILE_TYPE_DISK, FILE_TYPE_PIPE, GetFileType};
    use windows_sys::Win32::System::Console::{
        ATTACH_PARENT_PROCESS, AttachConsole, GetStdHandle, STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE,
        SetStdHandle,
    };
    // SAFETY: attaches only this CLI process, without allocating a new console.
    unsafe {
        let redirected = [STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE].map(|kind| {
            let handle = GetStdHandle(kind);
            (kind, handle, matches!(GetFileType(handle), FILE_TYPE_DISK | FILE_TYPE_PIPE))
        });
        AttachConsole(ATTACH_PARENT_PROCESS);
        for (kind, handle, keep) in redirected {
            if keep {
                SetStdHandle(kind, handle);
            }
        }
    }
}
