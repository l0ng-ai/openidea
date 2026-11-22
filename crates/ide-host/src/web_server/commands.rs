//! Shell-level commands registered in web server mode alongside `Dispatcher::standard()`.
//!
//! Project-host commands (`#[command]`) already live in `ide-host::ops` and are served directly.
//! This module supplies the web equivalents of desktop shell commands (`app_info`, `languages`,
//! `recent_projects`, `window_take_launch`, `menu_model`, `light_edit_open`, workspace helpers,
//! HTTP client helpers, and benign no-ops for native-window-only commands).

use crate::Host;
use crate::catalogue::TrustClass;
use crate::ops::project::ProjectInfo;
use crate::rpc::Dispatcher;
use ide_core::settings::Settings;
use ide_core::{IdeError, IpcPath, RequestId};
use ide_language::LanguageInfo;
use ide_workspace::settings::SettingsScope;
use ide_workspace::{RecentProject, RecentProjectGroup, RecentProjects};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

/// Shared state for shell-level commands in a web server process.
pub struct WebShellState {
    pub recent: RecentProjects,
    /// Per-window pending launch (taken once by `window_take_launch`).
    launches: Mutex<HashMap<String, PathBuf>>,
    /// Default workspace directory configured via `--project` / `OPENIDEA_WORKSPACE_DIR`.
    default_project: Option<PathBuf>,
    /// Whether the default project should be auto-trusted on startup.
    trust_default_project: bool,
}

impl WebShellState {
    pub fn new(config_dir: &std::path::Path, default_project: Option<PathBuf>, trust_default_project: bool) -> Self {
        Self {
            recent: RecentProjects::load(config_dir),
            launches: Mutex::new(HashMap::new()),
            default_project,
            trust_default_project,
        }
    }

    /// Seeds a pending project launch for `window` (from URL `?project=...` or `--project`),
    /// if the window does not already have a project open.
    pub fn seed_launch(&self, host: &Host, window: &str, requested_project: Option<PathBuf>) {
        if host.project(window).is_ok() {
            return;
        }
        let target = requested_project.or_else(|| self.default_project.clone());
        if let Some(path) = target {
            if self.trust_default_project
                && self.default_project.as_ref().is_some_and(|p| p == &path)
                && let Err(e) = host.trust.inherit(&path)
            {
                tracing::warn!("cannot trust {}: {e}", path.display());
            }
            self.launches.lock().insert(window.to_owned(), path);
        }
    }

    pub fn take_launch(&self, window: &str) -> Option<PathBuf> {
        self.launches.lock().remove(window)
    }

    pub fn record_project(&self, project: &crate::Project) {
        if project.light {
            return;
        }
        let info = crate::ops::project::info(project);
        let attached = info.workspace.as_ref().is_some_and(|w| !w.is_container(&project.root));
        let branch = if attached {
            None
        } else {
            project.repos.read().primary().and_then(|r| r.branch_info().ok()).and_then(|b| b.head)
        };
        let _ = self.recent.touch(&project.root, branch);
        let _ = self.recent.rename(&project.root, Some(&info.display_name));
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppInfo {
    version: String,
    platform: String,
    windows_build_number: Option<u32>,
    config_dir: IpcPath,
    data_dir: IpcPath,
    wayland: bool,
    window_buttons: ide_core::platform::WindowButtonLayout,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BuildInfo {
    version: String,
    build: String,
    profile: String,
    os: String,
    arch: String,
    tauri: String,
    updates: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CloseContext {
    quitting: bool,
    windows: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenProject {
    name: String,
    root: PathBuf,
    current: bool,
    remote: Option<Value>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalDataInfo {
    current: String,
    default_dir: String,
    custom_root: Option<String>,
    env_override: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LogLocation {
    dir: IpcPath,
    file: Option<IpcPath>,
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum MenuNode {
    Submenu {
        id: String,
        label: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        current: Option<bool>,
        children: Vec<MenuNode>,
    },
    Action {
        id: String,
        label: String,
        hint: Option<String>,
        arg: Option<String>,
        checked: Option<bool>,
    },
    Placeholder {
        id: String,
        label: String,
    },
    Separator,
}

fn action(id: &str, label: &str) -> MenuNode {
    MenuNode::Action { id: id.into(), label: label.into(), hint: None, arg: None, checked: None }
}

fn submenu(id: &str, label: &str, children: Vec<MenuNode>) -> MenuNode {
    MenuNode::Submenu { id: id.into(), label: label.into(), current: None, children }
}

fn web_menu_model(recent: &[RecentProject]) -> Vec<MenuNode> {
    let recent_children: Vec<MenuNode> = if recent.is_empty() {
        vec![MenuNode::Placeholder { id: "file.openRecent.empty".into(), label: "No Recent Projects".into() }]
    } else {
        recent
            .iter()
            .take(15)
            .map(|r| MenuNode::Action {
                id: "file.openRecentProject".into(),
                label: r.name.clone(),
                hint: None,
                arg: Some(r.path.to_string_lossy().into_owned()),
                checked: None,
            })
            .collect()
    };

    vec![
        submenu(
            "menu.file",
            "File",
            vec![
                action("file.newProject", "New Project…"),
                action("file.openProject", "Open…"),
                submenu("file.openRecent", "Open Recent", recent_children),
                MenuNode::Separator,
                action("file.newFile", "New File…"),
                action("file.save", "Save All"),
                action("file.reloadFromDisk", "Reload All from Disk"),
                MenuNode::Separator,
                action("file.settings", "Settings…"),
                action("file.projectStructure", "Project Structure…"),
                MenuNode::Separator,
                action("file.closeProject", "Close Project"),
            ],
        ),
        submenu(
            "menu.edit",
            "Edit",
            vec![
                action("edit.undo", "Undo"),
                action("edit.redo", "Redo"),
                MenuNode::Separator,
                action("edit.cut", "Cut"),
                action("edit.copy", "Copy"),
                action("edit.paste", "Paste"),
                action("edit.selectAll", "Select All"),
                MenuNode::Separator,
                action("search.find", "Find…"),
                action("search.replace", "Replace…"),
                action("search.findInFiles", "Find in Files…"),
                action("search.replaceInFiles", "Replace in Files…"),
            ],
        ),
        submenu(
            "menu.view",
            "View",
            vec![
                action("view.toolWindow.project", "Project"),
                action("view.toolWindow.terminal", "Terminal"),
                action("view.toolWindow.problems", "Problems"),
                action("view.toolWindow.structure", "Structure"),
                action("view.toolWindow.git", "Git"),
                action("view.toolWindow.run", "Run"),
                action("view.toolWindow.debug", "Debug"),
                MenuNode::Separator,
                action("view.quickSwitch", "Quick Switch Scheme…"),
                action("view.distractionFree", "Distraction Free Mode"),
                action("view.zoomIn", "Zoom In"),
                action("view.zoomOut", "Zoom Out"),
                action("view.zoomReset", "Reset Zoom"),
            ],
        ),
        submenu(
            "menu.navigate",
            "Navigate",
            vec![
                action("navigate.searchEverywhere", "Search Everywhere"),
                action("navigate.goToFile", "File…"),
                action("navigate.goToSymbol", "Symbol…"),
                action("navigate.goToLine", "Line:Column…"),
                MenuNode::Separator,
                action("navigate.back", "Back"),
                action("navigate.forward", "Forward"),
                MenuNode::Separator,
                action("navigate.declaration", "Declaration or Usages"),
                action("navigate.implementation", "Implementation(s)"),
                action("navigate.findUsages", "Find Usages"),
            ],
        ),
        submenu(
            "menu.code",
            "Code",
            vec![
                action("code.reformat", "Reformat Code"),
                action("code.optimizeImports", "Optimize Imports"),
                action("code.commentLine", "Comment with Line Comment"),
                action("code.commentBlock", "Comment with Block Comment"),
            ],
        ),
        submenu(
            "menu.refactor",
            "Refactor",
            vec![
                action("refactor.rename", "Rename…"),
                action("refactor.extractVariable", "Extract Variable…"),
                action("refactor.extractMethod", "Extract Method…"),
            ],
        ),
        submenu(
            "menu.run",
            "Run",
            vec![
                action("run.run", "Run"),
                action("run.debug", "Debug"),
                action("run.stop", "Stop"),
                MenuNode::Separator,
                action("run.editConfigurations", "Edit Configurations…"),
            ],
        ),
        submenu(
            "menu.git",
            "Git",
            vec![
                action("vcs.commit", "Commit…"),
                action("vcs.update", "Update Project"),
                action("vcs.push", "Push…"),
                MenuNode::Separator,
                action("vcs.branches", "Branches…"),
                action("vcs.showLog", "Show Git Log"),
            ],
        ),
        submenu(
            "menu.help",
            "Help",
            vec![action("navigate.findAction", "Find Action…"), action("help.about", "About OpenIDEA")],
        ),
    ]
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum LogLevel {
    Error,
    Warn,
    Info,
    Debug,
}

/// Registers all web-mode shell commands onto `dispatcher` (which should already contain
/// `Dispatcher::standard()`).
pub fn register(dispatcher: &mut Dispatcher, shell: Arc<WebShellState>) {
    // Wrap `open_project` so opened projects are recorded in RecentProjects.
    let s = shell.clone();
    dispatcher.replace("open_project", TrustClass::Always, move |c| {
        let s = s.clone();
        async move {
            let path: PathBuf = c.arg("path")?;
            let project = crate::ops::project::open(&c.host, &c.window, &path).await?;
            s.record_project(&project);
            Ok(crate::ops::project::info(&project))
        }
    });

    // App info & metadata.
    dispatcher.add("app_info", TrustClass::Always, |c| async move {
        Ok(AppInfo {
            version: env!("CARGO_PKG_VERSION").into(),
            platform: std::env::consts::OS.into(),
            windows_build_number: None,
            config_dir: c.host.config_dir.clone().into(),
            data_dir: c.host.data_dir.clone().into(),
            wayland: false,
            window_buttons: ide_core::platform::WindowButtonLayout { left: vec![], right: vec![] },
        })
    });

    dispatcher.add("app_build_info", TrustClass::Always, |_| async move {
        Ok(BuildInfo {
            version: env!("CARGO_PKG_VERSION").into(),
            build: option_env!("OPENIDEA_BUILD").unwrap_or("web").into(),
            profile: if cfg!(debug_assertions) { "debug" } else { "release" }.into(),
            os: std::env::consts::OS.into(),
            arch: std::env::consts::ARCH.into(),
            tauri: "web".into(),
            updates: false,
        })
    });

    dispatcher.add("app_log_location", TrustClass::Always, |c| async move {
        Ok(LogLocation { dir: c.host.local_data_dir.join("logs").into(), file: None })
    });

    dispatcher.add("app_update_status", TrustClass::Always, |_| async move {
        Ok(json!({ "lastChecked": null, "checking": false }))
    });
    dispatcher.add("app_update_announcement", TrustClass::Always, |_| async move { Ok(false) });
    dispatcher.add("app_update_window_ready", TrustClass::Always, |_| async move { Ok(Value::Null) });
    dispatcher.add("app_check_update", TrustClass::Always, |_| async move {
        Err::<Value, _>(IdeError::unavailable("Software updates are managed externally in web server mode"))
    });
    dispatcher.add("app_release_notes", TrustClass::Always, |_| async move { Ok(Value::Null) });
    dispatcher.add("app_quit", TrustClass::Always, |_| async move { Ok(Value::Null) });
    dispatcher.add("app_cancel_quit", TrustClass::Always, |_| async move { Ok(Value::Null) });
    dispatcher.add("app_restart", TrustClass::Always, |_| async move { Ok(Value::Null) });

    dispatcher.add("languages", TrustClass::Always, |c| async move {
        Ok(c.host.languages.all().iter().map(LanguageInfo::from).collect::<Vec<_>>())
    });

    dispatcher.add("log_frontend", TrustClass::Always, |c| async move {
        let level: LogLevel = c.arg("level")?;
        let message: String = c.arg("message")?;
        match level {
            LogLevel::Error => tracing::error!(target: "frontend", "{message}"),
            LogLevel::Warn => tracing::warn!(target: "frontend", "{message}"),
            LogLevel::Info => tracing::info!(target: "frontend", "{message}"),
            LogLevel::Debug => tracing::debug!(target: "frontend", "{message}"),
        }
        Ok(Value::Null)
    });

    // Recent projects & groups.
    let s = shell.clone();
    dispatcher.add("recent_projects", TrustClass::Always, move |c| {
        let s = s.clone();
        async move {
            let items = s.recent.list();
            c.host
                .blocking(move || Ok(ide_workspace::recent::with_live_branches(items)))
                .await
                .or_else(|_| Ok(s.recent.list()))
        }
    });

    let s = shell.clone();
    dispatcher.add("remove_recent_project", TrustClass::Always, move |c| {
        let s = s.clone();
        async move {
            let path: PathBuf = c.arg("path")?;
            s.recent.remove(&path)?;
            Ok(Value::Null)
        }
    });

    let s = shell.clone();
    dispatcher.add("recent_project_groups", TrustClass::Always, move |_| {
        let s = s.clone();
        async move { Ok(s.recent.groups()) }
    });

    let s = shell.clone();
    dispatcher.add("set_recent_project_groups", TrustClass::Always, move |c| {
        let s = s.clone();
        async move {
            let groups: Vec<RecentProjectGroup> = c.arg("groups")?;
            s.recent.set_groups(groups)
        }
    });

    // LightEdit.
    dispatcher.add("light_edit_open", TrustClass::Always, |c| async move {
        let path: PathBuf = c.arg("path")?;
        let (host, window) = (c.host.clone(), c.window.clone());
        let project = c.host.blocking(move || host.open_light(&window, &path)).await?;
        Ok::<Settings, IdeError>(project.settings.effective())
    });

    dispatcher.add("light_edit_open_untitled", TrustClass::Always, |c| async move {
        let (host, window) = (c.host.clone(), c.window.clone());
        let project = c.host.blocking(move || host.open_light_empty(&window)).await?;
        Ok::<Settings, IdeError>(project.settings.effective())
    });

    // Project rename & trust locations.
    let s = shell.clone();
    dispatcher.add("project_rename", TrustClass::Always, move |c| {
        let s = s.clone();
        async move {
            let name: String = c.arg("name")?;
            let project = c.host.project(&c.window)?;
            let trimmed = name.trim();
            if let Some(workspace) = ide_workspace::workspace::Workspace::load(&project.root)?
                && workspace.is_container(&project.root)
            {
                crate::ops::project::save_workspace(&c.host, &c.window, trimmed, workspace.projects)?;
            } else {
                let value = if trimmed.is_empty() { Value::Null } else { Value::String(trimmed.to_owned()) };
                project.settings.set(SettingsScope::Project, "general.projectName", value)?;
            }
            s.record_project(&project);
            Ok::<ProjectInfo, IdeError>(crate::ops::project::info(&project))
        }
    });

    dispatcher.add("project_trust_add_location", TrustClass::Always, |c| async move {
        let path: PathBuf = c.arg("path")?;
        c.host.trust.add_location(&path)?;
        Ok(Value::Null)
    });

    // Launch & window lifecycle.
    let s = shell.clone();
    dispatcher.add("window_take_launch", TrustClass::Always, move |c| {
        let s = s.clone();
        async move {
            let Some(project) = s.take_launch(&c.window) else {
                return Ok(Value::Null);
            };
            Ok(json!({
                "project": IpcPath::from(project),
                "files": [],
                "remote": null,
                "settingsPage": null,
                "newProjects": false,
                "positions": [],
                "comparison": null,
                "diffWindow": null,
                "diff": null,
                "diffBeforeFiles": false,
                "deployment": null,
                "editor": null
            }))
        }
    });

    dispatcher.add("window_complete_launch", TrustClass::Always, |_| async move { Ok(Value::Null) });

    dispatcher.add("window_open_projects", TrustClass::Always, |c| async move {
        let current_root = c.host.project(&c.window).ok().filter(|p| !p.light).map(|p| p.root.clone());
        let list: Vec<OpenProject> = c
            .host
            .projects()
            .into_iter()
            .filter(|p| !p.light)
            .map(|p| OpenProject {
                name: p.root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
                current: current_root.as_ref() == Some(&p.root),
                root: p.root.clone(),
                remote: None,
            })
            .collect();
        Ok(list)
    });

    dispatcher.add("window_open_project", TrustClass::Always, |_| async move { Ok(json!({ "kind": "current" })) });

    dispatcher.add("window_open_files", TrustClass::Always, |c| async move {
        let files: Vec<IpcPath> = c.arg("files")?;
        Ok(files)
    });

    dispatcher.add("window_is_fullscreen", TrustClass::Always, |_| async move { Ok(false) });
    dispatcher.add("window_close_context", TrustClass::Always, |_| async move {
        Ok(CloseContext { quitting: false, windows: 1 })
    });
    for noop in [
        "window_set_titlebar_height",
        "window_set_smooth_scrolling",
        "window_flash_taskbar",
        "window_cycle",
        "menu_configure",
        "menu_refresh",
        "menu_set_disabled",
        "show_system_notification",
        "window_group_cancel_close",
        "plugin_subscribe",
        "plugin_activation_event",
        "plugin_set_theme_frame",
    ] {
        dispatcher.add(noop, TrustClass::Always, |_| async move { Ok(Value::Null) });
    }
    for noop_false in [
        "window_toggle_fullscreen",
        "window_toggle_zoom",
        "window_start_drag",
        "window_drag_files",
        "file_dialog_needs_gtk",
        "clipboard_has_files",
        "clipboard_has_image",
    ] {
        dispatcher.add(noop_false, TrustClass::Always, |_| async move { Ok(false) });
    }

    let s = shell.clone();
    dispatcher.add("menu_model", TrustClass::Always, move |_| {
        let s = s.clone();
        async move { Ok(web_menu_model(&s.recent.list())) }
    });

    // Empty desktop-only collections so UI components render cleanly without errors.
    for empty_list in [
        "window_group_current",
        "system_font_families",
        "system_probe_hotkeys",
        "wsl_distros",
        "web_browsers",
        "plugin_catalog",
        "plugin_installed_intellij_themes",
        "git_credentials",
        "android_devices",
        "clipboard_file_list",
    ] {
        dispatcher.add(empty_list, TrustClass::Always, |_| async move { Ok(Vec::<Value>::new()) });
    }

    for null_opt in ["wsl_resolve", "remote_current", "plugin_market_url", "clipboard_text", "clipboard_image"] {
        dispatcher.add(null_opt, TrustClass::Always, |_| async move { Ok(Value::Null) });
    }

    dispatcher.add("plugin_list", TrustClass::Always, |_| async move {
        Ok(json!({ "plugins": [], "activeTheme": null, "ui": [] }))
    });

    // Caches & LSP & Web & Workspace & HTTP helpers already available through ide-host dependencies.
    dispatcher.add("caches_local_data_info", TrustClass::Always, |c| async move {
        let current = c.host.local_data_dir.to_string_lossy().into_owned();
        Ok(LocalDataInfo {
            default_dir: current.clone(),
            current,
            custom_root: None,
            env_override: std::env::var_os("OPENIDEA_SERVER_HOME").is_some(),
        })
    });

    dispatcher.add("caches_schedule_invalidation", TrustClass::Always, |_| async move { Ok(Value::Null) });

    dispatcher.add("lsp_restart_named", TrustClass::Trusted, |c| async move {
        let name: String = c.arg("name")?;
        crate::ops::lsp::lsp_restart_named(&c.host, &name).await?;
        Ok(Value::Null)
    });

    dispatcher.add("web_serves_page", TrustClass::Always, |c| async move {
        let url: String = c.arg("url")?;
        Ok(crate::ops::web::serves_page(&url).await)
    });

    dispatcher.add("workspace_discover_projects", TrustClass::Always, |c| async move {
        let request: RequestId = c.arg("request")?;
        let folders: Vec<PathBuf> = c.arg("folders")?;
        let cancel = c.host.begin_request(request);
        let result = c.host.blocking(move || ide_workspace::project_discovery::discover(folders, &cancel)).await;
        c.host.end_request(request);
        result
    });

    dispatcher.add("workspace_create", TrustClass::Trusted, |c| async move {
        let path: PathBuf = c.arg("path")?;
        let name: String = c.arg("name")?;
        let projects: Vec<PathBuf> = c.arg("projects")?;
        c.host
            .blocking(move || {
                ide_workspace::workspace::Workspace::save(&path, &name, projects, true)?;
                Ok(IpcPath::from(dunce::canonicalize(path)?))
            })
            .await
    });

    let s = shell.clone();
    dispatcher.add("workspace_update", TrustClass::Trusted, move |c| {
        let s = s.clone();
        async move {
            let name: String = c.arg("name")?;
            let projects: Vec<PathBuf> = c.arg("projects")?;
            let (host, window) = (c.host.clone(), c.window.clone());
            let info =
                c.host.blocking(move || crate::ops::project::save_workspace(&host, &window, &name, projects)).await?;
            if let Ok(project) = c.host.project(&c.window) {
                s.record_project(&project);
            }
            Ok(info)
        }
    });

    let s = shell.clone();
    dispatcher.add("workspace_attach", TrustClass::Trusted, move |c| {
        let s = s.clone();
        async move {
            let path: PathBuf = c.arg("path")?;
            let (host, window) = (c.host.clone(), c.window.clone());
            let root = c.host.blocking(move || crate::ops::project::attach_workspace(&host, &window, &path)).await?;
            if let Ok(project) = c.host.project(&c.window) {
                s.record_project(&project);
            }
            Ok(root)
        }
    });

    dispatcher.add("http_requests", TrustClass::Always, |c| async move {
        let text: String = c.arg("text")?;
        Ok(ide_http::parse::requests(&text))
    });

    dispatcher.add("http_from_curl", TrustClass::Always, |c| async move {
        let command: String = c.arg("command")?;
        Ok(ide_http::curl::from_curl(&command))
    });

    dispatcher.add("ssh_askpass_answer", TrustClass::Always, |_| async move { Ok(Value::Null) });
}
