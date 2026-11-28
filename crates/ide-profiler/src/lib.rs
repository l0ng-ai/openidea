//! Run with Profiler.
//!
//! [`prepare`] turns a run configuration into the command that runs it under
//! a sampling profiler (or explains which profiler is missing); [`collect`]
//! reads what the run left behind into one call-tree model ([`Profile`]):
//!
//! | runtime | profiler | output |
//! |---|---|---|
//! | Node.js (scripts, npm scripts) | `node --cpu-prof` (via `NODE_OPTIONS`) | `.cpuprofile` JSON |
//! | Python | cProfile (`python_profile.py`), or `py-spy record --format raw` | pstats, or collapsed stacks |
//! | JVM applications | async-profiler agent (`JAVA_TOOL_OPTIONS`) | collapsed stacks |
//! | native / `cargo run` (Linux) | `perf record -g`, then `perf script` | perf script text |
//!
//! Saved snapshots open too: V8 `.cpuprofile` files and cProfile / profile `pstats` files.

mod formats;
mod jvm;
mod live;
mod plan;
mod pstats;
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
    /// Calls, when the profiler counts them (cProfile); sampling profilers don't.
    pub calls: Option<f64>,
    /// Calls that were not recursive (`pstats`' primitive calls).
    pub primitive_calls: Option<f64>,
}

/// What one function spent when called from another, as a call-graph profiler (cProfile)
/// records it. Sampling profilers leave [`Profile::calls`] empty; their callers and callees
/// come from the call tree.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CallEdge {
    /// Index into [`Profile::frames`].
    pub caller: u32,
    pub callee: u32,
    /// Weight spent in the callee itself on these calls.
    pub self_weight: f64,
    /// Weight of these calls, including what the callee called.
    pub total: f64,
    pub calls: f64,
    pub primitive_calls: f64,
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
    /// Exact caller → callee totals of a call-graph profile; its call tree is then rebuilt
    /// from them, so below the first level it is an estimate. Empty for sampled profiles.
    pub calls: Vec<CallEdge>,
}

/// Where a prepared run's profile will be, and how to read it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ProfileSpec {
    /// Every `*.cpuprofile` in `dir` (one per Node.js process). Processes that
    /// ran no code of `root` (the package manager of an npm script) are left
    /// out when another one did.
    CpuProfiles { dir: IpcPath, root: IpcPath },
    /// A snapshot file the user opened: a V8 `.cpuprofile` (`node --cpu-prof`, Chrome
    /// DevTools, CI) or a `pstats` file (cProfile, profile, yappi), told apart by content.
    /// Relative source files of a `pstats` file resolve against `root`, then its directory.
    SnapshotFile { path: IpcPath, root: Option<IpcPath> },
    /// What `python_profile.py` wrote in `dir` for a profiled Python run: `profile.pstats`.
    /// Relative source files resolve against `root`.
    PythonRun { profiler: String, dir: IpcPath, root: IpcPath },
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
        ProfileSpec::SnapshotFile { path, root } => {
            let path: &Path = path.as_ref();
            let name =
                path.file_name().map_or_else(|| path.display().to_string(), |n| n.to_string_lossy().into_owned());
            let bytes = std::fs::read(path).map_err(|e| IdeError::invalid(format!("Cannot read {name}: {e}")))?;
            let ext = path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
            // The content decides (`node --cpu-prof-name=cpu.prof` writes JSON); the extension only
            // names what a file that is neither failed to be.
            let json = bytes.iter().find(|b| !b.is_ascii_whitespace()) == Some(&b'{');
            if pstats::looks_like_pstats(&bytes) || (!json && matches!(ext.as_str(), "pstats" | "pstat" | "prof")) {
                let bases: Vec<&Path> = root.iter().map(|r| r.as_ref()).chain(path.parent()).collect();
                let profile = pstats::read(&bytes, &bases, "cProfile")
                    .map_err(|e| IdeError::invalid(format!("{name} is not a cProfile snapshot ({e}).")))?;
                if profile.methods.is_empty() {
                    return Err(IdeError::invalid(format!("{name} has no calls.")));
                }
                return Ok(profile);
            }
            let text = String::from_utf8_lossy(&bytes);
            formats::add_cpuprofile(&mut b, &text)
                .map_err(|e| IdeError::invalid(format!("{name} is not a V8 CPU profile ({e}).")))?;
            if b.is_empty() {
                return Err(IdeError::invalid(format!("{name} has no samples.")));
            }
            let mut profile = b.finish("V8 CPU profile", "ms", ProfileMode::Cpu);
            // A profile recorded on another machine (CI) names files that aren't here.
            for f in &mut profile.frames {
                if f.file.as_ref().is_some_and(|p| !p.is_file()) {
                    (f.file, f.line) = (None, None);
                }
            }
            Ok(profile)
        }
        ProfileSpec::PythonRun { profiler, dir, root } => {
            let bytes = std::fs::read(Path::new(dir.as_ref()).join("profile.pstats")).map_err(|e| match e.kind() {
                // A run that was killed (a second Stop) or left through `os._exit`.
                std::io::ErrorKind::NotFound => nothing_recorded(&format!("{profiler} wrote no profile")),
                _ => IdeError::invalid(format!("Cannot read the {profiler} profile: {e}")),
            })?;
            let bases: [&Path; 2] = [root.as_ref(), dir.as_ref()];
            let profile = pstats::read(&bytes, &bases, profiler)
                .map_err(|e| IdeError::invalid(format!("Cannot read the {profiler} profile: {e}")))?;
            if profile.methods.is_empty() {
                return Err(nothing_recorded(&format!("{profiler} recorded no calls")));
            }
            Ok(profile)
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
    fn an_opened_cpuprofile_keeps_only_local_sources() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("index.js");
        std::fs::write(&src, "").unwrap();
        let url = |p: &Path| format!("file://{}", p.display()).replace('\\', "/");
        let json = format!(
            r#"{{"nodes":[
            {{"id":1,"callFrame":{{"functionName":"(root)","url":"","lineNumber":-1}},"children":[2,3]}},
            {{"id":2,"callFrame":{{"functionName":"here","url":"{}","lineNumber":3}}}},
            {{"id":3,"callFrame":{{"functionName":"onCi","url":"file:///home/runner/work/app/x.js","lineNumber":1}}}}],
            "samples":[2,3,2],"timeDeltas":[0,1000,1000]}}"#,
            url(&src)
        );
        let path = dir.path().join("CPU.cpuprofile");
        std::fs::write(&path, json).unwrap();
        let p = collect(&ProfileSpec::SnapshotFile { path: path.into(), root: None }).unwrap();
        assert_eq!((p.unit.as_str(), p.mode), ("ms", ProfileMode::Cpu));
        let frame = |name: &str| p.frames.iter().find(|f| f.name == name).unwrap();
        assert_eq!(frame("here").file.as_deref(), Some(src.as_path()));
        assert_eq!(frame("here").line, Some(3));
        assert_eq!((frame("onCi").file.as_ref(), frame("onCi").line), (None, None));
    }

    #[test]
    fn an_opened_file_that_is_no_cpuprofile_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        for (file, text, says) in [
            ("notes.cpuprofile", "hello", "is not a V8 CPU profile"),
            ("other.cpuprofile", r#"{"a":1}"#, "is not a V8 CPU profile (no nodes)"),
            ("empty.cpuprofile", r#"{"nodes":[],"samples":[],"timeDeltas":[]}"#, "has no samples"),
        ] {
            let path = dir.path().join(file);
            std::fs::write(&path, text).unwrap();
            let err = collect(&ProfileSpec::SnapshotFile { path: path.into(), root: None }).unwrap_err();
            assert_eq!(err.message.split_once(' ').unwrap().0, file);
            assert!(err.message.contains(says), "{}", err.message);
        }
        let missing =
            collect(&ProfileSpec::SnapshotFile { path: dir.path().join("gone.cpuprofile").into(), root: None });
        assert!(missing.unwrap_err().message.starts_with("Cannot read gone.cpuprofile"));
    }

    #[test]
    fn an_opened_pstats_file_is_told_apart_by_content() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("run.out");
        std::fs::write(&path, include_bytes!("../testdata/fib.prof")).unwrap();
        std::fs::write(dir.path().join("work.py"), "").unwrap();
        let p = collect(&ProfileSpec::SnapshotFile { path: path.into(), root: None }).unwrap();
        assert_eq!((p.profiler.as_str(), p.unit.as_str()), ("cProfile", "ms"));
        assert!(!p.calls.is_empty());
        let fib = p.frames.iter().find(|f| f.name == "fib").unwrap();
        assert_eq!(fib.file.as_deref(), Some(dir.path().join("work.py").as_path()), "relative to the snapshot");

        // A Go pprof profile (gzip) named `.prof`.
        let bad = dir.path().join("bad.prof");
        std::fs::write(&bad, b"\x1f\x8b\x08\x00").unwrap();
        let err = collect(&ProfileSpec::SnapshotFile { path: bad.into(), root: None }).unwrap_err();
        assert!(err.message.starts_with("bad.prof is not a cProfile snapshot"), "{}", err.message);

        // `node --cpu-prof --cpu-prof-name=cpu.prof`.
        let v8 = dir.path().join("cpu.prof");
        let json = r#"{"nodes":[{"id":1,"callFrame":{"functionName":"(root)","url":"","lineNumber":-1},"children":[2]},
            {"id":2,"callFrame":{"functionName":"work","url":"","lineNumber":0}}],"samples":[2,2],"timeDeltas":[0,1000]}"#;
        std::fs::write(&v8, json).unwrap();
        let p = collect(&ProfileSpec::SnapshotFile { path: v8.into(), root: None }).unwrap();
        assert_eq!(p.profiler, "V8 CPU profile");
    }

    #[test]
    fn cpu_profile_stays_in_samples() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("profile-1.collapsed"), "A.main;work_[j] 3\n").unwrap();
        let p = collect(&folded(dir.path(), ProfileMode::Cpu)).unwrap();
        assert_eq!((p.unit.as_str(), p.mode), ("samples", ProfileMode::Cpu));
    }
}
