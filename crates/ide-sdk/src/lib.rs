//! SDKs and toolchains (IDEA's "Project SDK" / PyCharm's "Python Interpreter").
//!
//! - discovery of installed interpreters / toolchains per language ([`detect`]),
//! - Python virtualenv creation and package management via pip (or uv),
//! - applying the selected toolchains from settings to language-server launch
//!   configs, run configurations and new terminal sessions ([`apply`]).

mod angular;
pub mod apply;
pub mod arduino;
mod astro;
mod discover;
mod exec;
pub mod go;
pub mod godot;
pub mod java;
pub mod jdtls;
pub mod libraries;
pub mod locate;
pub mod lombok;
pub mod maven_profiles;
mod npm;
pub mod php;
pub mod pinned;
pub mod python;
pub mod ruby;
mod vue;

use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::{Path, PathBuf};

pub use discover::{detect, jdk_sdk, python_interpreter_sdk};

/// What [`detect`] looks for.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum SdkKind {
    Python,
    Node,
    /// `php` CLI executables.
    Php,
    /// npm / pnpm / yarn executables.
    PackageManager,
    Rust,
    Go,
    TypeScript,
    /// JDK homes.
    Jdk,
    /// Maven homes.
    Maven,
    Ruby,
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

/// `path` with symlinks resolved (Homebrew's `bin/mvn` → its Cellar), except that a Windows
/// mapped drive letter is kept when the target stays inside that drive: canonicalizing gives
/// `\\?\UNC\server\share\…` or another drive, and cmd.exe can't start a script from a
/// `\\?\` path (`mvn.cmd`, or `mvn.cmd` with such a `JAVA_HOME`), nor is it the path the user knows.
pub(crate) fn launch_path(path: &Path) -> std::io::Result<PathBuf> {
    let real = dunce::canonicalize(path)?;
    #[cfg(windows)]
    {
        use std::path::{Component, Prefix};
        let drive = |p: &Path| match p.components().next() {
            Some(Component::Prefix(x)) => match x.kind() {
                Prefix::Disk(d) | Prefix::VerbatimDisk(d) => Some(d.to_ascii_uppercase()),
                _ => None,
            },
            _ => None,
        };
        if let Some(d) = drive(path)
            && drive(&real) != Some(d)
        {
            let root = PathBuf::from(format!("{}:\\", char::from(d)));
            if let Ok(mapped) = dunce::canonicalize(&root)
                && let Ok(relative) = real.strip_prefix(mapped)
            {
                return Ok(root.join(relative));
            }
        }
    }
    Ok(real)
}

pub(crate) fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(PathBuf::from)
}

#[cfg(test)]
mod tests;
