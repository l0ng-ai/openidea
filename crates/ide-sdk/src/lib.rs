//! SDKs and toolchains (IDEA's "Project SDK" / PyCharm's "Python Interpreter").
//!
//! - discovery of installed interpreters / toolchains per language ([`detect`]),
//! - Python virtualenv creation and package management via pip (or uv),
//! - applying the selected toolchains from settings to language-server launch
//!   configs, run configurations and new terminal sessions ([`apply`]).

mod angular;
pub mod apply;
mod discover;
mod exec;
pub mod godot;
pub mod java;
pub mod jdtls;
pub mod libraries;
pub mod locate;
pub mod lombok;
mod npm;
pub mod pinned;
pub mod python;
mod vue;

use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::{Path, PathBuf};

pub use discover::{detect, jdk_sdk};
pub use exec::search_path;

/// What [`detect`] looks for.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum SdkKind {
    Python,
    Node,
    /// npm / pnpm / yarn executables.
    PackageManager,
    Rust,
    Go,
    TypeScript,
    /// JDK homes.
    Jdk,
    /// Maven homes.
    Maven,
}

/// One installed interpreter / toolchain.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Sdk {
    /// Executable (`python`, `node`, `pnpm`) or directory (Rust toolchain bin
    /// dir, GOROOT, TypeScript `lib` dir) that the setting stores.
    pub path: ide_core::IpcPath,
    /// Display name, e.g. `Python 3.12 (.venv)` or `stable-aarch64-apple-darwin`.
    pub name: String,
    pub version: Option<String>,
    /// Where it was found: `venv` | `system` | `pyenv` | `conda` | `uv` | `nvm` |
    /// `rustup` | `bundled` | `workspace` | `path` …
    pub source: String,
    /// Environment / toolchain root (virtualenv dir, rustup toolchain dir, GOROOT).
    pub home: Option<ide_core::IpcPath>,
    /// Rust standard library sources, Go default GOPATH.
    pub extra: Option<ide_core::IpcPath>,
}

/// Virtualenv directory of a Python executable (`<venv>/bin/python`), if it is one.
pub fn venv_of(python: &Path) -> Option<PathBuf> {
    let home = python.parent()?.parent()?;
    home.join("pyvenv.cfg").is_file().then(|| home.to_path_buf())
}

pub(crate) fn bin_dir() -> &'static str {
    if cfg!(windows) { "Scripts" } else { "bin" }
}

pub(crate) fn exe(name: &str) -> String {
    if cfg!(windows) { format!("{name}.exe") } else { name.to_owned() }
}

pub(crate) fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(PathBuf::from)
}

#[cfg(test)]
mod tests;
