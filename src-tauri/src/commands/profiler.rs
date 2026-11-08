//! Run with Profiler: launch plans and profiles.

use super::coverage::{KEEP_RUNS, blocking};
use crate::state::AppState;
use ide_core::{IdeResult, RunId};
use ide_profiler::{Profile, ProfileMode, ProfilePrepared, ProfileSpec};
use ide_run::{RunConfig, RunInfo};
use tauri::{State, Window};

/// How to run `config` under a sampling profiler, or which profiler is missing.
#[tauri::command]
#[specta::specta]
pub async fn profiler_prepare(
    window: Window,
    state: State<'_, AppState>,
    config: RunConfig,
    mode: ProfileMode,
) -> IdeResult<ProfilePrepared> {
    let project = state.project(window.label())?;
    let (root, cache) = (project.root.clone(), project.cache_dir.join("profiles"));
    blocking(move || {
        let out = ide_run::wrap::new_output_dir(&cache, KEEP_RUNS)?;
        Ok(ide_profiler::prepare(&root, &config, &out, mode))
    })
    .await
}

/// Reads the profile a profiled run left behind.
#[tauri::command]
#[specta::specta]
pub async fn profiler_collect(spec: ProfileSpec) -> IdeResult<Profile> {
    blocking(move || ide_profiler::collect(&spec)).await
}

/// Runs a full garbage collection in the JVMs of a running local run, so a live-object profile
/// written when it stops holds only reachable objects. Returns how many JVMs collected; 0 for a
/// run that is gone, remote, or has no JVM with an attach listener.
#[tauri::command]
#[specta::specta]
pub async fn profiler_gc_before_stop(window: Window, state: State<'_, AppState>, run: RunId) -> IdeResult<u32> {
    state.project(window.label())?;
    let remote = state.host.remote.runs.contains(run);
    let Some(pid) = local_pid(remote, &state.host.processes.list(), run) else { return Ok(0) };
    gc_process_tree(pid).await
}

/// The pid of a live local run. A remote run's pid belongs to another machine; handed to the
/// local `jcmd` it would attach to whatever local JVM happens to have that number.
fn local_pid(remote: bool, local: &[RunInfo], run: RunId) -> Option<u32> {
    if remote {
        return None;
    }
    local.iter().find(|r| r.id == run && r.running).and_then(|r| r.pid)
}

#[cfg(unix)]
async fn gc_process_tree(pid: u32) -> IdeResult<u32> {
    let Ok(pid) = i32::try_from(pid) else { return Ok(0) };
    blocking(move || Ok(ide_profiler::gc_before_stop(&ide_core::process::process_tree(pid)))).await
}

#[cfg(not(unix))]
async fn gc_process_tree(_pid: u32) -> IdeResult<u32> {
    Ok(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn info(id: u32, pid: Option<u32>, running: bool) -> RunInfo {
        RunInfo { id: RunId(id), config_id: String::new(), name: String::new(), pid, running, pty: false }
    }

    #[test]
    fn local_pid_finds_the_live_run() {
        let runs = [info(1, Some(100), true), info(2, Some(200), true)];
        assert_eq!(local_pid(false, &runs, RunId(2)), Some(200));
    }

    #[test]
    fn local_pid_ignores_exited_unknown_and_pidless_runs() {
        let runs = [info(1, Some(100), false), info(2, None, true)];
        assert_eq!(local_pid(false, &runs, RunId(1)), None);
        assert_eq!(local_pid(false, &runs, RunId(2)), None);
        assert_eq!(local_pid(false, &runs, RunId(3)), None);
    }

    #[test]
    fn local_pid_never_returns_a_remote_runs_pid() {
        let runs = [info(1, Some(100), true)];
        assert_eq!(local_pid(true, &runs, RunId(1)), None);
    }
}
