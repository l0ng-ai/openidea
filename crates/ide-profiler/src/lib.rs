//! Run with Profiler.
//!
//! [`prepare`] turns a run configuration into the command that runs it under
//! a sampling profiler (or explains which profiler is missing); [`collect`]
//! reads what the run left behind into one call-tree model ([`Profile`]):
//!
//! | runtime | profiler | output |
//! |---|---|---|
//! | Node.js (scripts, npm scripts) | `node --cpu-prof` (via `NODE_OPTIONS`) | `.cpuprofile` JSON |
//! | Python | `py-spy record --format raw` | collapsed stacks |
//! | JVM applications | async-profiler agent (`JAVA_TOOL_OPTIONS`) | collapsed stacks |
//! | native / `cargo run` (Linux) | `perf record -g`, then `perf script` | perf script text |

mod formats;
mod jvm;
mod live;
mod plan;
mod tree;

pub use live::gc_before_stop;
pub use plan::prepare;

use ide_core::{IdeError, IdeResult, IpcPath};
use ide_run::RunConfig;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use tree::TreeBuilder;

/// What a profile measures.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ProfileMode {
    /// Sampled CPU time.
    #[default]
    Cpu,
    /// Bytes allocated, by allocation stack.
    Allocations,
    /// Objects still alive when the run stopped, by allocation stack.
    LiveObjects,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ProfileFrameKind {
    /// A function; `file` / `line` locate its source.
    #[default]
    Code,
    /// The leaf of an allocation stack: the type that was allocated, not a source line.
    AllocatedType,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ProfileFrame {
    pub name: String,
    pub file: Option<IpcPath>,
    /// 0-based.
    pub line: Option<u32>,
    pub kind: ProfileFrameKind,
}

/// A call-tree node; node 0 is the synthetic root (`all`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ProfileNode {
    /// Index into [`Profile::frames`].
    pub frame: u32,
    /// Weight of this node and everything it called.
    pub total: f64,
    /// Weight sampled in this node itself.
    pub self_weight: f64,
    /// Indices into [`Profile::nodes`], heaviest first.
    pub children: Vec<u32>,
}

/// Per-function totals (a recursive function's samples count once in `total`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MethodStat {
    pub frame: u32,
    pub self_weight: f64,
    pub total: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    /// `node --cpu-prof`, `py-spy`, `async-profiler`, `perf`.
    pub profiler: String,
    /// `ms` (time-weighted), `samples` (sample or live-object counts) or `bytes` (allocated).
    pub unit: String,
    pub mode: ProfileMode,
    pub total: f64,
    pub frames: Vec<ProfileFrame>,
    /// Depth-first; `nodes[0]` is the root.
    pub nodes: Vec<ProfileNode>,
    /// Sorted by self weight, heaviest first.
    pub methods: Vec<MethodStat>,
}

/// Where a prepared run's profile will be, and how to read it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ProfileSpec {
    /// Every `*.cpuprofile` in `dir` (one per Node.js process). Processes that
    /// ran no code of `root` (the package manager of an npm script) are left
    /// out when another one did.
    CpuProfiles { dir: IpcPath, root: IpcPath },
    /// Collapsed-stack files with extension `ext` in `dir`; relative frame files resolve
    /// against `base`. `jvm_root`: map JVM class frames to sources below it. For the
    /// allocation modes the last frame of a JVM stack is the allocated type.
    Folded { profiler: String, dir: IpcPath, ext: String, base: IpcPath, jvm_root: Option<IpcPath>, mode: ProfileMode },
    /// `perf script -i <data>` output.
    Perf { perf: String, data: IpcPath, cwd: IpcPath, env: BTreeMap<String, String> },
}

/// A command line that installs a missing profiler.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ProfilerInstall {
    pub command: String,
    pub args: Vec<String>,
    pub cwd: Option<IpcPath>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum ProfilePrepared {
    Ready { profiler: String, launch: Box<RunConfig>, spec: ProfileSpec },
    MissingTool { tool: String, message: String, install: Option<ProfilerInstall>, homepage: Option<String> },
    Unsupported { reason: String },
}

fn files_with_ext(dir: &Path, ext: &str) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = std::fs::read_dir(dir)
        .map(|it| it.flatten().map(|e| e.path()).filter(|p| p.extension().is_some_and(|x| x == ext)).collect())
        .unwrap_or_default();
    out.sort();
    out
}

fn nothing_recorded(what: &str) -> IdeError {
    let mut msg = format!("The run produced no profile ({what}).");
    if cfg!(target_os = "macos") && what.contains("py-spy") {
        msg.push_str(" On macOS py-spy can only sample processes when it runs as root.");
    }
    IdeError::not_found(msg)
}

/// Reads the profile described by `spec`. Blocking: call from a blocking thread.
pub fn collect(spec: &ProfileSpec) -> IdeResult<Profile> {
    let mut b = TreeBuilder::new();
    match spec {
        ProfileSpec::CpuProfiles { dir, root } => {
            let mut texts = Vec::new();
            for f in files_with_ext(dir, "cpuprofile") {
                texts.push((std::fs::read_to_string(&f)?, f));
            }
            if texts.iter().any(|(t, _)| formats::cpuprofile_runs_code_of(t, root)) {
                texts.retain(|(t, _)| formats::cpuprofile_runs_code_of(t, root));
            }
            for (text, f) in texts {
                if let Err(e) = formats::add_cpuprofile(&mut b, &text) {
                    tracing::debug!("{}: {e}", f.display());
                }
            }
            if b.is_empty() {
                return Err(nothing_recorded("no .cpuprofile was written"));
            }
            Ok(b.finish("node --cpu-prof", "ms", ProfileMode::Cpu))
        }
        ProfileSpec::Folded { profiler, dir, ext, base, jvm_root, mode } => {
            for f in files_with_ext(dir, ext) {
                formats::add_folded(&mut b, &std::fs::read_to_string(&f)?, base, *mode != ProfileMode::Cpu);
            }
            if b.is_empty() {
                let mut err = nothing_recorded(&format!("{profiler} recorded no samples"));
                if *mode == ProfileMode::LiveObjects {
                    err.message.push_str(" Profiling live objects needs JDK 11 or newer.");
                }
                return Err(err);
            }
            let unit = if *mode == ProfileMode::Allocations { "bytes" } else { "samples" };
            let mut profile = b.finish(profiler, unit, *mode);
            if let Some(root) = jvm_root {
                jvm::resolve_sources(&mut profile, root);
            }
            Ok(profile)
        }
        ProfileSpec::Perf { perf, data, cwd, env } => {
            if !data.is_file() {
                return Err(nothing_recorded("perf wrote no data"));
            }
            let out = ide_core::process::prepare(&mut Command::new(perf))
                .args(["script", "-i"])
                .arg(data.as_ref() as &Path)
                .current_dir(cwd)
                .envs(env)
                .output()
                .map_err(|e| IdeError::unavailable(format!("cannot run {perf}: {e}")))?;
            if !out.status.success() {
                return Err(IdeError::internal(format!(
                    "perf script failed: {}",
                    String::from_utf8_lossy(&out.stderr).trim()
                )));
            }
            formats::add_perf_script(&mut b, &String::from_utf8_lossy(&out.stdout));
            if b.is_empty() {
                return Err(nothing_recorded("perf recorded no samples"));
            }
            Ok(b.finish("perf", "samples", ProfileMode::Cpu))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn folded(dir: &Path, mode: ProfileMode) -> ProfileSpec {
        ProfileSpec::Folded {
            profiler: "async-profiler".into(),
            dir: dir.to_path_buf().into(),
            ext: "collapsed".into(),
            base: dir.to_path_buf().into(),
            jvm_root: None,
            mode,
        }
    }

    #[test]
    fn live_without_samples_mentions_jdk11() {
        let dir = tempfile::tempdir().unwrap();
        let err = collect(&folded(dir.path(), ProfileMode::LiveObjects)).unwrap_err();
        assert!(err.message.contains("JDK 11"), "{}", err.message);
        let err = collect(&folded(dir.path(), ProfileMode::Allocations)).unwrap_err();
        assert!(!err.message.contains("JDK 11"), "{}", err.message);
    }

    #[test]
    fn allocation_profile_is_in_bytes() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("profile-1.collapsed"), "A.main;byte[]_[i] 1024\n").unwrap();
        let p = collect(&folded(dir.path(), ProfileMode::Allocations)).unwrap();
        assert_eq!(p.unit, "bytes");
        assert_eq!(p.mode, ProfileMode::Allocations);
        assert_eq!(p.total, 1024.0);
        assert!(p.frames.iter().any(|f| f.name == "byte[]" && f.kind == ProfileFrameKind::AllocatedType));
    }

    #[test]
    fn cpu_profile_stays_in_samples() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("profile-1.collapsed"), "A.main;work_[j] 3\n").unwrap();
        let p = collect(&folded(dir.path(), ProfileMode::Cpu)).unwrap();
        assert_eq!((p.unit.as_str(), p.mode), ("samples", ProfileMode::Cpu));
    }
}
