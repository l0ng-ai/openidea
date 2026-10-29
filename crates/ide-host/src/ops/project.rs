use crate::{Host, Project};
use ide_core::IdeResult;
use ide_core::settings::Settings;
use ide_workspace::settings::SettingsScope;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::Path;
use std::sync::Arc;

#[derive(Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInfo {
    pub root: ide_core::IpcPath,
    pub name: String,
    pub is_git: bool,
    pub settings: Settings,
}

pub fn info(project: &Project) -> ProjectInfo {
    let settings = project.settings.effective();
    let custom = settings.general.project_name.trim();
    ProjectInfo {
        name: if custom.is_empty() {
            project.root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
        } else {
            custom.to_owned()
        },
        is_git: !project.repos.read().is_empty(),
        settings,
        root: project.root.clone().into(),
    }
}

/// Opens `path` in `window` (off the async workers: it touches the disk).
pub async fn open(host: &Arc<Host>, window: &str, path: &Path) -> IdeResult<Arc<Project>> {
    let (h, window, path) = (host.clone(), window.to_owned(), path.to_path_buf());
    host.blocking(move || h.open_project(&window, &path)).await
}

pub fn current(host: &Host, window: &str) -> Option<ProjectInfo> {
    host.project(window).ok().filter(|p| !p.light).map(|p| info(&p))
}

/// Effective settings for the window's project, or global settings without one.
pub fn settings(host: &Host, window: &str) -> Settings {
    host.with_proxy_password(match host.project(window) {
        Ok(p) => p.settings.effective(),
        Err(_) => host.global_settings.effective(),
    })
}

pub fn roots(host: &Host, window: &str) -> IdeResult<ide_workspace::ProjectRoots> {
    Ok(host.project(window)?.roots())
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
    let Some(value) = host.take_proxy_password(key, value)? else {
        host.apply_proxy();
        return Ok(SettingsApplied { settings: settings(host, window), project_scope, roots_changed: None });
    };
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
    if is_proxy {
        host.apply_proxy();
    }
    // A new interpreter / toolchain / server executable restarts the language servers it affects.
    if ["languages", "tools", "languageServers"].iter().any(|k| key == *k || key.starts_with(&format!("{k}."))) {
        for project in affected() {
            let lsp = project.lsp.clone();
            host.runtime.spawn(async move { lsp.reconfigure().await });
        }
    }
    let roots_changed = key == "projectStructure" || key.starts_with("projectStructure.");
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
