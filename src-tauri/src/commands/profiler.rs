//! Run with Profiler: launch plans and profiles.

use super::coverage::{KEEP_RUNS, blocking};
use crate::state::AppState;
use ide_core::IdeResult;
use ide_profiler::{Profile, ProfileMode, ProfilePrepared, ProfileSpec};
use ide_run::RunConfig;
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
