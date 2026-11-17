use crate::{Host, Project};
use ide_command::command;
use ide_core::settings::Settings;
use ide_core::{IdeEvent, IdeResult, RequestId, TaskId};
use ide_workspace::settings::SettingsScope;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::{Path, PathBuf};
use std::sync::Arc;

#[derive(Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInfo {
    pub trusted: bool,
    pub root: ide_core::IpcPath,
    pub name: String,
    #[serde(default)]
    pub display_name: String,
    pub is_git: bool,
    pub settings: Settings,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace: Option<ide_workspace::workspace::Workspace>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unity: Option<ide_workspace::unity::UnityProjectInfo>,
}

pub fn info(project: &Project) -> ProjectInfo {
    let settings = project.settings.effective();
    let custom = settings.general.project_name.trim();
    let primary = if custom.is_empty() {
        project.root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
    } else {
        custom.to_owned()
    };
    let workspace = ide_workspace::workspace::Workspace::load(&project.root).ok().flatten();
    ProjectInfo {
        trusted: project.is_trusted(),
        display_name: workspace
            .as_ref()
            .map(|w| w.display_name(&project.root, &primary))
            .unwrap_or_else(|| primary.clone()),
        name: workspace.as_ref().filter(|w| w.is_container(&project.root)).map(|w| w.name.clone()).unwrap_or(primary),
        is_git: !project.repos.read().is_empty(),
        settings,
        root: project.root.clone().into(),
        workspace,
        unity: ide_workspace::unity::detect(&project.root),
    }
}

/// Opens `path` in `window` (off the async workers: it touches the disk).
pub async fn open(host: &Arc<Host>, window: &str, path: &Path) -> IdeResult<Arc<Project>> {
    let (h, window, path) = (host.clone(), window.to_owned(), path.to_path_buf());
    host.blocking(move || h.open_project(&window, &path)).await
}

#[command(trust = always, desktop_body = async)]
pub async fn open_project(host: &Arc<Host>, window: &str, path: PathBuf) -> IdeResult<ProjectInfo> {
    let project = open(host, window, &path).await?;
    Ok(info(&project))
}

/// The project open in this window (a settings window: its parent's), if any.
#[command(trust = always, desktop_body = sync)]
pub fn project_current(host: &Host, window: &str) -> Option<ProjectInfo> {
    host.project(window).ok().filter(|p| !p.light).map(|p| info(&p))
}

#[command(trust = always, desktop_body = spawn)]
pub fn close_project(host: &Host, window: &str) {
    host.close_project(window);
}

/// Effective settings for the window's project, or global settings without one.
#[command(trust = always, desktop_body = sync)]
pub fn settings_get(host: &Host, window: &str) -> Settings {
    host.with_proxy_password(match host.project(window) {
        Ok(p) => p.settings.effective(),
        Err(_) => host.global_settings.effective(),
    })
}

/// The removed built-in theme id a settings file of this window still names, if any:
/// `settings_get` reports the built-in that stands in for it, so the notice about
/// a theme that moved to a plugin can address the installs it concerns.
#[command(trust = always, desktop_body = sync)]
pub fn settings_removed_theme(host: &Host, window: &str) -> Option<String> {
    match host.project(window) {
        Ok(p) => p.settings.named_removed_theme().or_else(|| host.global_settings.named_removed_theme()),
        Err(_) => host.global_settings.named_removed_theme(),
    }
}

/// `value` is JSON text, e.g. `14` or `"dark"`. Every window (for a project
/// value: that project's windows) is told (`IdeEvent::SettingsChanged`) so it
/// re-reads its effective settings.
#[command(trust = always, desktop_body = sync)]
pub fn settings_set(
    host: &Host,
    window: &str,
    scope: SettingsScope,
    key: String,
    value: String,
) -> IdeResult<Settings> {
    let applied = set_settings(host, window, scope, &key, &value)?;
    let sink = host.window_sink(window);
    sink.emit(IdeEvent::SettingsChanged { key });
    if let Some(root) = applied.roots_changed {
        sink.emit(IdeEvent::ProjectRootsChanged { root });
    }
    Ok(applied.settings)
}

/// Effective source / test / resource / excluded roots of the window's project:
/// auto-detected from build files, overridden by Settings › Project Structure.
#[command(trust = always)]
pub fn project_roots(host: &Host, window: &str) -> IdeResult<ide_workspace::ProjectRoots> {
    Ok(host.project(window)?.roots())
}

#[command(trust = always)]
pub fn cancel_request(host: &Host, id: RequestId) {
    host.cancel_request(id);
}

/// Stops a background task the backend reported with `cancellable` set; false when it
/// has ended or can't be cancelled.
#[command(trust = always)]
pub fn cancel_task(id: TaskId) -> bool {
    ide_core::task::cancel(id)
}

#[command(trust = always)]
pub fn project_trust_status(host: &Host, path: PathBuf) -> IdeResult<crate::trust::TrustStatus> {
    host.trust.status(&path)
}

#[command(trust = always)]
pub fn project_trust_list(host: &Host) -> IdeResult<crate::trust::TrustDecisions> {
    host.trust.decisions()
}

#[command(trust = always, desktop_body = async)]
pub async fn project_trust_set(host: &Host, path: PathBuf, trusted: bool, folder: bool) -> IdeResult<()> {
    host.set_project_trust(&path, trusted, folder).await
}

#[command(trust = always, desktop_body = async)]
pub async fn project_trust_remove_location(host: &Host, path: PathBuf) -> IdeResult<()> {
    host.trust.remove_location(&path)?;
    host.refresh_project_trust().await
}

pub fn save_workspace(host: &Host, window: &str, name: &str, paths: Vec<std::path::PathBuf>) -> IdeResult<ProjectInfo> {
    let project = host.project(window)?;
    let previous = ide_workspace::workspace::Workspace::load(&project.root)?
        .ok_or_else(|| ide_core::IdeError::invalid("This folder is not a workspace"))?;
    for path in paths.iter().filter(|p| !previous.projects.contains(p)) {
        require_attachment_trust(host, path)?;
    }
    if !previous.is_container(&project.root) && paths.first() != Some(&project.root) {
        return Err(ide_core::IdeError::invalid("The primary project cannot be detached"));
    }
    if !previous.is_container(&project.root) && paths == [project.root.clone()] {
        std::fs::remove_file(project.root.join(ide_workspace::workspace::FILE))?;
    } else {
        let workspace = ide_workspace::workspace::Workspace::save(&project.root, name, paths, false)?;
        keep_attachment_private(&project.root, &workspace)?;
    }
    refresh_workspace(&project);
    Ok(info(&project))
}

fn require_attachment_trust(host: &Host, path: &Path) -> IdeResult<()> {
    if !host.trust.trusted(path)? {
        return Err(ide_core::IdeError::invalid("Trust the project before attaching it"));
    }
    Ok(())
}

fn keep_attachment_private(root: &Path, workspace: &ide_workspace::workspace::Workspace) -> IdeResult<()> {
    if !workspace.is_container(root) {
        ide_vcs::changelists::ensure_ignored(&root.join(".openidea"), &["/workspace.json"])?;
    }
    Ok(())
}

fn refresh_workspace(project: &Project) {
    project.settings.reload();
    project.refresh_index_scope();
    project.refresh_repositories();
    project.sink.emit(ide_core::IdeEvent::ProjectRootsChanged { root: project.root.clone().into() });
}

/// Attaches a trusted folder without replacing the current project.
pub fn attach_workspace(host: &Host, window: &str, path: &Path) -> IdeResult<ide_core::IpcPath> {
    let project = host.project(window)?;
    let path = dunce::canonicalize(path)?;
    if project.light {
        return Err(ide_core::IdeError::invalid("Open a project before attaching a folder"));
    }
    if path == project.root {
        return Ok(project.root.clone().into());
    }
    require_attachment_trust(host, &path)?;
    if let Some(mut workspace) = ide_workspace::workspace::Workspace::load(&project.root)? {
        if !workspace.projects.contains(&path) {
            workspace.projects.push(path);
            save_workspace(host, window, &workspace.name, workspace.projects)?;
        }
    } else {
        let workspace = ide_workspace::workspace::Workspace::attach(
            &project.root,
            &info(&project).name,
            vec![project.root.clone(), path],
        )?;
        keep_attachment_private(&project.root, &workspace)?;
        refresh_workspace(&project);
    }
    Ok(project.root.clone().into())
}

/// What [`set_settings`] changed; the caller tells the windows.
pub struct SettingsApplied {
    pub settings: Settings,
    /// A project value (else a global one).
    pub project_scope: bool,
    /// The project's root, when its content roots changed.
    pub roots_changed: Option<ide_core::IpcPath>,
}

/// Sets `key` to `value` (JSON text, e.g. `14` or `"dark"`) for the window's
/// project or globally, and applies it to the open projects: file defaults,
/// file types, language servers, index scope, SSH configurations and the HTTP proxy
/// (whose password goes to the saved passwords, not the settings file).
pub fn set_settings(
    host: &Host,
    window: &str,
    scope: SettingsScope,
    key: &str,
    value: &str,
) -> IdeResult<SettingsApplied> {
    let value: serde_json::Value =
        serde_json::from_str(value).map_err(|e| ide_core::IdeError::invalid(e.to_string()))?;
    let current = host.project(window).ok();
    // A LightEdit window has no project layer: its values are global.
    let project_scope = matches!(scope, SettingsScope::Project) && current.as_ref().is_some_and(|p| !p.light);
    let is_proxy = key == "proxy" || key.starts_with("proxy.");
    let Some(mut value) = host.take_proxy_password(key, value)? else {
        host.apply_proxy();
        return Ok(SettingsApplied { settings: settings_get(host, window), project_scope, roots_changed: None });
    };
    // One canonical spelling per linked POM, including a project outside the opened root.
    if project_scope
        && key == "languages.java.maven.linkedProjects"
        && let Some(project) = current.as_ref()
        && let Some(list) = value.as_array()
    {
        let poms: Vec<String> = list.iter().filter_map(|item| item.as_str().map(str::to_owned)).collect();
        if poms.len() == list.len() {
            value = serde_json::json!(ide_build::maven::normalize_linked_poms(&project.root, &poms));
        }
    }
    let settings = match &current {
        Some(p) if project_scope => p.settings.set(scope, key, value)?,
        Some(p) => {
            host.global_settings.set(SettingsScope::Global, key, value)?;
            p.settings.reload()
        }
        None => host.global_settings.set(SettingsScope::Global, key, value)?,
    };
    if let Some(p) = &current {
        p.documents.set_file_defaults(ide_workspace::FileDefaults::from_settings(&settings, Some(&p.root)));
    }
    // A global value reaches every other open project too.
    if !project_scope {
        for project in host.projects() {
            if current.as_ref().is_some_and(|c| Arc::ptr_eq(c, &project)) {
                continue;
            }
            let effective = project.settings.reload();
            project
                .documents
                .set_file_defaults(ide_workspace::FileDefaults::from_settings(&effective, Some(&project.root)));
        }
    }
    let affected = || if project_scope { current.iter().cloned().collect() } else { host.projects() };
    if key == "editor" || key == "editor.encodings" || key == "editor.encodings.nativeToAscii" {
        let affected = affected();
        host.runtime.spawn_blocking(move || {
            for project in affected {
                project.documents.reload_properties();
            }
        });
    }
    // File type associations re-detect open documents (off the command thread).
    if key == "files" || key.starts_with("files.fileType") {
        let affected = affected();
        host.runtime.spawn_blocking(move || {
            for project in affected {
                project.apply_file_types(&project.settings.effective());
            }
        });
    }
    if key == "ssh" || key.starts_with("ssh.") {
        host.ssh.set_configs(host.global_settings.effective().ssh.configs);
    }
    if key == "languages" || key == "languages.java" || key.starts_with("languages.java.addedJdks") {
        host.apply_added_jdks();
    }
    if is_proxy {
        host.apply_proxy();
    }
    if key == "agents" || key == "agents.mcpServers" || key.starts_with("agents.mcpServers.") {
        for project in affected() {
            project.agents.notify_mcp_servers_changed();
        }
    }
    // A new interpreter / toolchain / server executable restarts the language servers it affects.
    // So do inspections that are compiler options (`ide-sdk` `configure_java_compiler`).
    let code_style = key == "editor"
        || key == "editor.codeStyle"
        || key.starts_with("editor.codeStyle.")
        || key == "inspections"
        || key.starts_with("inspections.")
        || key == "files"
        || key == "files.composeFileOverrides"
        || key.starts_with("files.composeFileOverrides.");
    let toolchain = ["languages", "tools", "languageServers", "projectStructure"]
        .iter()
        .any(|k| key == *k || key.starts_with(&format!("{k}.")));
    // A run target chosen as the Python interpreter (or changed) needs a snapshot of its libraries.
    if ["languages", "languages.python", "languages.python.interpreter", "runTargets"].contains(&key) {
        for project in affected() {
            crate::ops::sdk::container_python::ensure(host, &project);
        }
    }
    // Code style only reaches servers as settings (e.g. jdtls' formatter profile); builds don't depend on it.
    if code_style || toolchain {
        for project in affected() {
            if toolchain && let Some(bridge) = &project.kotlin_bridge {
                bridge.schedule();
            }
            let lsp = project.lsp.clone();
            host.runtime.spawn(async move { lsp.reconfigure().await });
        }
    }
    let roots_changed = key == "projectStructure"
        || key.starts_with("projectStructure.")
        || "languages.java.maven.unlinkedProjects".starts_with(key)
        || "languages.java.maven.linkedProjects".starts_with(key)
        || "languages.java.gradle.linkedProjects".starts_with(key);
    // Content roots and excludes (files.exclude, ignored names, excluded folders) reach the
    // index and the watchers without reopening the project (the rescan runs in the background).
    if roots_changed || key == "files" || key.starts_with("files.") {
        let affected = affected();
        host.runtime.spawn_blocking(move || {
            for project in affected {
                project.refresh_index_scope();
            }
        });
    }
    let roots_changed = current.as_ref().filter(|_| roots_changed && project_scope).map(|p| p.root.clone().into());
    Ok(SettingsApplied { settings: host.with_proxy_password(settings), project_scope, roots_changed })
}

ide_command::domain!(
    project:
    cancel_request,
    cancel_task,
    close_project,
    open_project,
    project_current,
    project_roots,
    project_trust_list,
    project_trust_remove_location,
    project_trust_set,
    project_trust_status,
    settings_get,
    settings_removed_theme,
    settings_set,
);
