//! Java launch support: classpath / JDK resolution and the java-debug server (jdtls).

use super::build::load;
use crate::state::AppState;
use ide_build::compile;
use ide_core::{CancellationToken, IdeError, IdeResult};
use ide_lsp::jdtls::JavaLaunchInfo;
use std::path::PathBuf;
use tauri::{State, Window};

/// Builds the workspace (when `build`), then resolves the runtime (or test)
/// classpath and the JDK of the module at `module` (absolute, or relative to the project root).
/// A module with Kotlin / Groovy / Scala sources is built by its build system, whose class directories come first.
#[tauri::command]
#[specta::specta]
pub async fn java_resolve_launch(
    window: Window,
    state: State<'_, AppState>,
    module: PathBuf,
    test: bool,
    build: bool,
) -> IdeResult<JavaLaunchInfo> {
    let project = state.project(window.label())?;
    let module = project.root.join(module);
    let settings = project.settings.effective();
    let built = if build && compile::has_non_java_sources(&module) {
        let (root, cache, module, settings) =
            (project.root.clone(), project.build_cache_dir(), module.clone(), settings.clone());
        tauri::async_runtime::spawn_blocking(move || {
            compile::build_for_launch(&root, &load(&root, &cache, &settings), &module, test, &CancellationToken::new())
        })
        .await
        .map_err(|e| IdeError::internal(e.to_string()))??
    } else {
        Vec::new()
    };
    let mut info = project.lsp.java_launch(&module, test, build).await?;
    let mut class_paths: Vec<String> = built.iter().map(|p| p.to_string_lossy().into_owned()).collect();
    for p in std::mem::take(&mut info.class_paths) {
        if !class_paths.contains(&p) {
            class_paths.push(p);
        }
    }
    info.class_paths = class_paths;
    // The project JDK, else the JDK jdtls compiles the module against, else one matching its Java version.
    let project_jdk = ide_sdk::apply::project_jdk(&project.root, &settings);
    let from_jdtls = info.java_home.as_deref().map(ide_sdk::java::java_executable).filter(|p| p.is_file());
    let java = project_jdk.map(|j| ide_sdk::java::java_executable(&j.home)).or(from_jdtls).or_else(|| {
        let release = ide_sdk::java::project_java_version(&module);
        let jdks = ide_sdk::java::installed_jdks();
        info.hints.extend(ide_sdk::java::missing_jdk_message(&jdks, release));
        ide_sdk::java::pick_jdk(&jdks, release).map(|j| ide_sdk::java::java_executable(&j.home))
    });
    info.java_exec = Some(java.map(|p| p.to_string_lossy().into_owned()).unwrap_or_else(|| "java".to_owned()));
    let exec = PathBuf::from(info.java_exec.as_deref().unwrap_or("java"));
    let shorten = ide_run::java_cmdline::shortening_for(&exec, &info.class_paths, &info.module_paths, cfg!(windows));
    info.shorten_command_line = Some(shorten.as_str().to_owned());
    if info.error_count > 0 {
        let own = ide_sdk::lombok::agent_in_args(settings.languages.java.jdtls_vm_args.split_whitespace());
        let managed = ide_tools::managed_bundle(&state.data_dir, "lombok");
        let repo = ide_sdk::apply::maven_local_repository(&project.root, &settings);
        let root = project.root.clone();
        // Detection may read the project's sources.
        let lombok =
            tauri::async_runtime::spawn_blocking(move || ide_sdk::lombok::lombok_agent(&root, own, managed, repo))
                .await
                .map_err(|e| IdeError::internal(e.to_string()))?;
        info.hints.extend(lombok.problem());
    }
    Ok(info)
}

/// Port of java-debug's DAP server inside the jdtls serving `module` (started on demand).
#[tauri::command]
#[specta::specta]
pub async fn java_debug_server(window: Window, state: State<'_, AppState>, module: PathBuf) -> IdeResult<u16> {
    let project = state.project(window.label())?;
    let module = project.root.join(module);
    project.lsp.java_debug_server(&module).await
}

/// Incremental build of the jdtls workspace serving `module` (e.g. before HotSwap).
#[tauri::command]
#[specta::specta]
pub async fn java_build_workspace(
    window: Window,
    state: State<'_, AppState>,
    module: PathBuf,
) -> IdeResult<ide_lsp::jdtls::JavaBuildStatus> {
    let project = state.project(window.label())?;
    let module = project.root.join(module);
    project.lsp.java_build(&module).await
}
