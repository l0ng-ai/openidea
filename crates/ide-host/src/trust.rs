//! User-owned project execution decisions. Project settings never grant trust.
use ide_core::{IdeError, IdeResult};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::{Path, PathBuf};

#[derive(Clone, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TrustDecisions {
    pub projects: Vec<PathBuf>,
    pub locations: Vec<PathBuf>,
    pub restricted: Vec<PathBuf>,
}

pub struct TrustStore {
    file: PathBuf,
    state: Mutex<IdeResult<TrustDecisions>>,
    /// Folders trusted for this process only, by the client that started it ([`TRUSTED_ROOT_ENV`]).
    inherited: Mutex<Vec<PathBuf>>,
    remote_file: PathBuf,
    remote: Mutex<IdeResult<RemoteDecisions>>,
}

/// This machine's decisions about remote projects, by location (see [`TrustStore::remote_decision`]).
#[derive(Clone, Default, Serialize, Deserialize)]
struct RemoteDecisions {
    trusted: Vec<String>,
    restricted: Vec<String>,
}

/// Set by the desktop when it starts the server in a dev container of a folder the user trusts
/// there: the project folder in the container, trusted without asking again. Never persisted.
pub const TRUSTED_ROOT_ENV: &str = "OPENIDEA_TRUSTED_ROOT";

impl TrustStore {
    pub fn load(config: &Path, data: &Path) -> Self {
        let file = data.join("project-trust.json");
        let state = match std::fs::read(&file) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| IdeError::invalid(e.to_string())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                let projects = ide_workspace::RecentProjects::load(config)
                    .paths()
                    .into_iter()
                    .filter_map(|p| dunce::canonicalize(p).ok())
                    .collect();
                let migrated = TrustDecisions { projects, ..Default::default() };
                persist(&file, &migrated).map(|()| migrated)
            }
            Err(e) => Err(e.into()),
        };
        let remote_file = data.join("remote-project-trust.json");
        let remote = match std::fs::read(&remote_file) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| IdeError::invalid(e.to_string())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(RemoteDecisions::default()),
            Err(e) => Err(e.into()),
        };
        Self { file, state: Mutex::new(state), inherited: Mutex::default(), remote_file, remote: Mutex::new(remote) }
    }

    /// The decision made on this machine for the remote project at `location` (`None`: none yet).
    /// Commands a remote window runs here follow it, not the server's own trust.
    pub fn remote_decision(&self, location: &str) -> IdeResult<Option<bool>> {
        let remote = self.remote.lock().clone()?;
        Ok(if remote.restricted.iter().any(|l| l == location) {
            Some(false)
        } else if remote.trusted.iter().any(|l| l == location) {
            Some(true)
        } else {
            None
        })
    }

    pub fn decide_remote(&self, location: &str, trusted: bool) -> IdeResult<()> {
        let mut state = self.remote.lock();
        let mut next = state.clone()?;
        next.trusted.retain(|l| l != location);
        next.restricted.retain(|l| l != location);
        if trusted { &mut next.trusted } else { &mut next.restricted }.push(location.to_owned());
        persist(&self.remote_file, &next)?;
        *state = Ok(next);
        Ok(())
    }

    pub fn decisions(&self) -> IdeResult<TrustDecisions> {
        self.state.lock().clone()
    }

    pub fn trusted(&self, path: &Path) -> IdeResult<bool> {
        let root = dunce::canonicalize(path)?;
        let decisions = self.decisions()?;
        Ok(!decisions.restricted.contains(&root)
            && (decisions.projects.contains(&root)
                || decisions.locations.iter().any(|p| root.starts_with(p))
                || self.inherited.lock().contains(&root)))
    }

    pub fn window_trusted(&self, root: &Path) -> IdeResult<bool> {
        if !self.trusted(root)? {
            return Ok(false);
        }
        if let Some(workspace) = ide_workspace::workspace::Workspace::load(root)?
            && !workspace.is_container(root)
        {
            for member in workspace.projects.iter().filter(|p| *p != root && p.exists()) {
                if !self.trusted(member)? {
                    return Ok(false);
                }
            }
        }
        Ok(true)
    }

    /// Trusts `path` for this process without recording a decision (see [`TRUSTED_ROOT_ENV`]).
    pub fn inherit(&self, path: &Path) -> IdeResult<()> {
        let root = dunce::canonicalize(path)?;
        let mut inherited = self.inherited.lock();
        if !inherited.contains(&root) {
            inherited.push(root);
        }
        Ok(())
    }

    pub fn decide(&self, path: &Path, trusted: bool, folder: bool) -> IdeResult<()> {
        let root = match dunce::canonicalize(path) {
            Ok(root) => root,
            Err(_) if !trusted && path.is_absolute() => path.to_path_buf(),
            Err(error) => return Err(error.into()),
        };
        let mut state = self.state.lock();
        let mut next = state.clone()?;
        next.projects.retain(|p| p != &root);
        next.restricted.retain(|p| p != &root);
        if trusted {
            next.projects.push(root.clone());
            if folder && let Some(parent) = root.parent() {
                let parent = parent.to_path_buf();
                if !next.locations.contains(&parent) {
                    next.locations.push(parent);
                }
            }
        } else {
            next.restricted.push(root);
        }
        persist(&self.file, &next)?;
        *state = Ok(next);
        Ok(())
    }

    pub fn add_location(&self, path: &Path) -> IdeResult<()> {
        let root = dunce::canonicalize(path)?;
        if !root.is_dir() {
            return Err(IdeError::invalid("trusted location must be an existing directory"));
        }
        let mut state = self.state.lock();
        let mut next = state.clone()?;
        if !next.locations.contains(&root) {
            next.locations.push(root);
            persist(&self.file, &next)?;
            *state = Ok(next);
        }
        Ok(())
    }

    pub fn remove_location(&self, path: &Path) -> IdeResult<()> {
        let mut state = self.state.lock();
        let mut next = state.clone()?;
        next.locations.retain(|p| p != path);
        persist(&self.file, &next)?;
        *state = Ok(next);
        Ok(())
    }
}

fn persist<T: Serialize>(file: &Path, state: &T) -> IdeResult<()> {
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let bytes = serde_json::to_vec_pretty(state).map_err(|e| IdeError::internal(e.to_string()))?;
    ide_vfs::write_atomic(file, &bytes)?;
    Ok(())
}

type McpServers = std::collections::BTreeMap<String, ide_core::settings::AgentMcpServer>;

/// Workspace MCP servers (a project's `agents.mcpServers`) the user turned on in Settings, by a
/// fingerprint of the project and the server's definition. Agents start a workspace server only
/// while its definition is one the user turned on, so a server added or changed in the project's
/// file stays off until then.
pub struct McpServerApprovals {
    file: PathBuf,
    approved: Mutex<std::collections::BTreeSet<String>>,
}

impl McpServerApprovals {
    pub fn load(data: &Path) -> Self {
        let file = data.join("mcp-server-approvals.json");
        let approved = std::fs::read(&file).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        Self { file, approved: Mutex::new(approved) }
    }

    fn fingerprint(root: &Path, name: &str, server: &ide_core::settings::AgentMcpServer) -> String {
        // Turning a server off and on again doesn't change what it runs.
        let server = ide_core::settings::AgentMcpServer { enabled: true, ..server.clone() };
        let bytes = serde_json::to_vec(&(root, name, server)).expect("MCP server serializes");
        blake3::hash(&bytes).to_hex().to_string()
    }

    pub fn approved(&self, root: &Path, name: &str, server: &ide_core::settings::AgentMcpServer) -> bool {
        self.approved.lock().contains(&Self::fingerprint(root, name, server))
    }

    pub fn approve(&self, root: &Path, name: &str, server: &ide_core::settings::AgentMcpServer) -> IdeResult<()> {
        let fingerprint = Self::fingerprint(root, name, server);
        let mut approved = self.approved.lock();
        if approved.contains(&fingerprint) {
            return Ok(());
        }
        let mut next = approved.clone();
        next.insert(fingerprint);
        if let Some(parent) = self.file.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let bytes = serde_json::to_vec_pretty(&next).map_err(|e| IdeError::internal(e.to_string()))?;
        ide_vfs::write_atomic(&self.file, &bytes)?;
        *approved = next;
        Ok(())
    }

    /// `workspace` with the servers the user hasn't turned on switched off.
    pub fn apply(&self, root: &Path, mut workspace: McpServers) -> McpServers {
        for (name, server) in &mut workspace {
            server.enabled &= self.approved(root, name, server);
        }
        workspace
    }
}

impl crate::Host {
    pub async fn set_project_trust(&self, path: &Path, trusted: bool, folder: bool) -> IdeResult<()> {
        self.trust.decide(path, trusted, folder)?;
        self.refresh_project_trust().await
    }

    pub async fn refresh_project_trust(&self) -> IdeResult<()> {
        for project in self.projects().into_iter().filter(|p| !p.light) {
            let trusted = self.trust.window_trusted(&project.root).unwrap_or(false);
            let previous = project.trusted.swap(trusted, std::sync::atomic::Ordering::AcqRel);
            if previous == trusted {
                continue;
            }
            if let Some(bridge) = &project.kotlin_bridge {
                bridge.schedule();
            }
            if let Some(phpstan) = &project.phpstan {
                phpstan.interrupt();
            }
            if !trusted {
                if let Some(plugins) = self.plugin_host() {
                    plugins.withdraw_project_run_targets(&project.root);
                }
                project.lsp.set_execution_allowed(false);
            }
            project.repos();
            if trusted {
                if let Some(cmd) = self.environment.project_opened(&project.root, &project.sink) {
                    self.environment.spawn_post_start(cmd, project.root.clone(), project.sink.clone());
                }
                project.lsp.set_execution_allowed(true);
                project.lsp.prewarm_java_configuration();
            } else {
                self.environment.project_closed();
                project.agents.shutdown();
                self.processes.kill_project(&project.root);
                project.notebooks.restrict().await;
                let windows: Vec<_> = self
                    .projects
                    .read()
                    .iter()
                    .filter(|(_, current)| std::sync::Arc::ptr_eq(current, &project))
                    .map(|(window, _)| window.clone())
                    .collect();
                for window in windows {
                    let requests = self.project_requests.write().remove(&window).unwrap_or_default();
                    for request in requests {
                        self.cancel_request(request);
                    }
                    self.debugger.stop_key(&window).await;
                }
            }
            project.lsp.reconfigure().await;
            project.sink.emit(ide_core::IdeEvent::ProjectTrustChanged { root: project.root.clone().into(), trusted });
        }
        Ok(())
    }
}

/// Commands allowed in Restricted Mode, by exact name: those which only inspect/edit source or
/// operate user-owned application state. A new command is denied until deliberately listed here.
pub fn restricted_command_allowed(cmd: &str) -> bool {
    matches!(
        cmd,
        "fs_compare_directories"
            | "fs_copy"
            | "fs_copy_merge"
            | "fs_create_dir"
            | "fs_create_file"
            | "fs_create_file_bytes"
            | "fs_delete"
            | "fs_entry_kind"
            | "fs_open_with_system"
            | "fs_probe"
            | "fs_read_dir"
            | "fs_read_image"
            | "fs_read_range"
            | "fs_read_text"
            | "fs_rename"
            | "fs_resolve_reference"
            | "fs_set_writable"
            | "doc_close"
            | "doc_edit"
            | "doc_folding"
            | "doc_highlights"
            | "doc_open"
            | "doc_open_virtual"
            | "doc_outline"
            | "doc_save"
            | "doc_save_all"
            | "doc_selection_ranges"
            | "doc_set_bom"
            | "doc_set_encoding"
            | "doc_set_line_ending"
            | "doc_snapshot"
            | "doc_sync_from_disk"
            | "doc_ui_mode"
            | "syntax_errors"
            | "syntax_expression_at"
            | "syntax_identifiers"
            | "syntax_identifiers_in_files"
            | "syntax_locals"
            | "syntax_node_at"
            | "syntax_structural_ranges"
            | "syntax_support"
            | "search_start"
            | "search_validate"
            | "nav_index_definitions"
            | "nav_inheritance"
            | "nav_resolve_module"
            | "history_content"
            | "history_list"
            | "history_list_dir"
            | "history_put_label"
            | "history_restore"
            | "spell_check"
            | "spell_suggest"
            | "analysis_locate_duplicates"
            | "structural_languages"
            | "structural_search"
            | "structural_validate"
            | "refactor_can_undo_file_move"
            | "refactor_file_move_edits"
            | "refactor_file_move_text_edits"
            | "refactor_move_files"
            | "refactor_undo_file_move"
            | "window_close_context"
            | "window_complete_launch"
            | "window_cycle"
            | "window_flash_taskbar"
            | "window_group_cancel_close"
            | "window_group_close"
            | "window_group_close_tabs"
            | "window_group_current"
            | "window_group_detach"
            | "window_group_merge"
            | "window_group_reorder"
            | "window_group_restore"
            | "window_group_select"
            | "window_is_fullscreen"
            | "window_new"
            | "window_open_comparison"
            | "window_open_deployment"
            | "window_open_diff"
            | "window_open_file_in_new_window"
            | "window_open_files"
            | "window_open_project"
            | "window_open_projects"
            | "window_open_remote"
            | "window_open_settings"
            | "window_set_titlebar_height"
            | "window_start_drag"
            | "window_take_launch"
            | "window_toggle_fullscreen"
            | "window_toggle_zoom"
            | "term_available_shells"
            | "term_default_shell"
            | "term_is_busy"
            | "term_kill"
            | "term_resize"
            | "term_spawn"
            | "term_store_image"
            | "term_write"
            | "settings_export"
            | "settings_get"
            | "settings_get_global"
            | "settings_import"
            | "settings_list_jetbrains_ides"
            | "settings_read_jetbrains"
            | "settings_set"
            | "project_trust_add_location"
            | "project_trust_list"
            | "project_trust_remove_location"
            | "project_trust_set"
            | "project_trust_status"
            // New Project writes only where the user chose and runs no code of an open project.
            | "scaffold_catalog"
            | "scaffold_create"
            | "scaffold_options"
            | "scaffold_requirements"
            | "ssh_askpass_answer"
            | "ssh_connected"
            | "ssh_disconnect"
            | "ssh_needs_secret"
            | "ssh_open_terminal"
            | "ssh_password_saved"
            | "ssh_set_secret"
            | "ssh_test"
            | "ssh_trust_host"
            | "git_credential_forget"
            | "git_credentials"
            | "app_info"
            | "app_build_info"
            | "app_cli_install"
            | "app_cli_uninstall"
            | "app_log_location"
            | "app_check_update"
            | "app_update_window_ready"
            | "app_update_status"
            | "app_update_announcement"
            | "app_install_update"
            | "caches_schedule_invalidation"
            | "clear_caches"
            | "clipboard_file_list"
            | "clipboard_has_files"
            | "clipboard_image"
            | "clipboard_set_file_list"
            | "clipboard_write_text"
            | "jdk_download_vendors"
            | "jdk_download_releases"
            | "jdk_download_location"
            | "jdk_download"
            | "jdtls_required_java"
            | "run_system_env"
            | "run_gradle_jvm_args_script"
            | "proxy_check_connection"
            | "docker_settings"
            | "docker_save_settings"
            | "docker_set_registry_password"
            | "docker_run_env"
            | "db_console_path"
            | "db_consoles"
            | "db_export_file"
            | "vcs_write_patch"
            | "app_metrics"
            | "app_quit"
            | "app_cancel_quit"
            | "app_restart"
            | "languages"
            | "menu_refresh"
            | "menu_model"
            | "menu_configure"
            | "menu_set_disabled"
            | "prepare_workspace_edit"
            | "apply_workspace_edit"
            | "undo_workspace_edit"
            | "redo_workspace_edit"
            | "lsp_servers"
            | "lsp_resend_diagnostics"
            | "recent_projects"
            | "remove_recent_project"
            | "recent_project_groups"
            | "set_recent_project_groups"
            | "open_project"
            | "close_project"
            | "project_current"
            | "project_roots"
            | "index_status"
            | "index_file_extensions"
            | "jvm_file_presentations"
            | "deploy_coverage"
            | "deploy_test_connection"
            | "find_files"
            | "find_files_named"
            | "find_dirs"
            | "find_symbols"
            | "mark_recent"
            | "remove_recent"
            | "recent_files"
            | "web_goto"
            | "path_completions"
            | "web_unresolved_references"
            | "project_rename"
            | "light_edit_open"
            | "workspace_create"
            | "workspace_discover_projects"
            | "workspace_update"
            | "workspace_attach"
            | "cancel_request"
            | "cancel_task"
            | "log_frontend"
            | "env_reload"
            | "remote_invoke"
            | "remote_current"
            | "remote_disconnect"
            | "remote_connect"
            | "remote_trust_status"
            | "remote_trust_set"
            | "remote_bootstrap_list"
            | "wsl_distros"
            | "wsl_resolve"
            | "remote_list"
            | "remote_open"
            | "remote_of"
            | "web_browsers"
            | "web_url"
            | "web_open"
            | "debug_attachable_processes"
            | "agent_subscribe"
            | "agent_entries"
            | "agent_commands"
            | "agent_unqueue"
            | "agent_cancel"
            | "agent_stop_background"
            | "agent_archive"
            | "agent_unarchive"
            | "agent_registry_list"
            | "agent_registry_install"
            | "agent_registry_remove"
            | "agent_mcp_list"
            | "agent_mcp_save"
            | "agent_mcp_set_enabled"
            | "agent_mcp_remove"
            | "agent_mcp_import"
            | "coverage_import"
            | "system_font_families"
            | "user_font_data"
            | "plugin_subscribe"
            | "plugin_list"
            | "plugin_set_active_file"
            | "plugin_set_theme"
            | "plugin_set_theme_frame"
            | "plugin_catalog"
            | "plugin_assets"
            | "plugin_set_ui_locale"
            | "plugin_market"
            | "plugin_market_url"
            | "plugin_set_market_url"
            | "plugin_market_download"
            | "plugin_unpack_package"
            | "plugin_stage_package"
            | "plugin_preview_install"
            | "plugin_read_intellij_theme"
            | "plugin_installed_intellij_themes"
            | "notebook_open"
            | "notebook_get"
            | "notebook_edit"
            | "notebook_save"
            | "notebook_undo"
            | "notebook_redo"
            | "notebook_reload"
            | "notebook_close"
            | "notebook_interrupt"
            | "run_stop"
            | "run_list"
            | "debug_stop"
            | "debug_sessions"
            | "vcs_clone"
            | "vcs_init"
            | "vcs_status"
            | "vcs_status_paths"
            | "vcs_roots"
            | "vcs_branch_info"
            | "vcs_line_hunks"
            | "vcs_file_at"
            | "vcs_blame"
            | "vcs_block_history"
            | "vcs_log"
            | "vcs_log_refs"
            | "vcs_log_users"
            | "vcs_log_details"
            | "vcs_log_details_batch"
            | "vcs_revision_children"
            | "vcs_revision_files"
            | "vcs_open_external_log"
            | "vcs_commit_files"
            | "vcs_commits_changes"
            | "vcs_branches"
            | "vcs_stashes"
            | "vcs_conflict_versions"
            | "vcs_diff_text"
            | "vcs_diff_hunks"
            | "vcs_detected_git"
            | "vcs_config_get"
            | "vcs_tags"
            | "vcs_remotes"
            | "vcs_worktrees"
            | "vcs_diff_with_worktree"
            | "vcs_compare_scope"
            | "vcs_compare_paths"
            | "vcs_diff_revisions"
            | "vcs_diff_numstat"
            | "vcs_merge_base"
            | "vcs_has_hook"
            | "vcs_shelves"
            | "vcs_shelf_patch"
            | "vcs_changelists_load"
    ) || cmd.starts_with("plugin:")
}

/// Commands that change which plugin code runs: allowed where no project is open (the
/// welcome screen), otherwise only in a trusted project.
pub fn projectless_command_allowed(cmd: &str) -> bool {
    matches!(
        cmd,
        "plugin_install_dir"
            | "plugin_uninstall"
            | "plugin_set_enabled"
            | "plugin_grant"
            | "plugin_set_capability"
            | "plugin_revoke_net_host"
            | "plugin_choose_program"
            | "plugin_program"
            | "plugin_roll_back"
            | "plugin_reload"
    )
}

impl crate::Host {
    pub fn authorize_command(&self, window: &str, command: &str) -> IdeResult<()> {
        if restricted_command_allowed(command) {
            return Ok(());
        }
        match self.project(window) {
            Ok(project) => project.require_trust(),
            Err(_) if projectless_command_allowed(command) => Ok(()),
            Err(error) => Err(error),
        }
    }
}

#[derive(Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TrustStatus {
    pub root: ide_core::IpcPath,
    pub trusted: bool,
    pub decided: bool,
}
impl TrustStore {
    pub fn status(&self, path: &Path) -> IdeResult<TrustStatus> {
        let root = dunce::canonicalize(path)?;
        let trusted = self.trusted(&root)?;
        let state = self.decisions()?;
        Ok(TrustStatus { decided: trusted || state.restricted.contains(&root), root: root.into(), trusted })
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn restricted_mode_allows_clipboard_write_text() {
        assert!(super::restricted_command_allowed("clipboard_write_text"));
    }

    #[test]
    fn restricted_mode_denies_new_commands_whatever_their_name() {
        for cmd in ["fs_new_command", "term_new_command", "ssh_new_command", "settings_new_command", "git_credential_x"]
        {
            assert!(!super::restricted_command_allowed(cmd), "{cmd} is allowed without being listed");
        }
    }

    #[test]
    fn remote_project_decisions_are_kept_on_this_machine() {
        let tmp = tempfile::tempdir().unwrap();
        let load = || super::TrustStore::load(&tmp.path().join("config"), &tmp.path().join("data"));
        let store = load();
        let here = r#"[{"kind":"ssh","config":"box"},"/srv/app"]"#;
        assert_eq!(store.remote_decision(here).unwrap(), None);
        store.decide_remote(here, true).unwrap();
        assert_eq!(store.remote_decision(here).unwrap(), Some(true));
        assert_eq!(store.remote_decision(r#"[{"kind":"ssh","config":"box"},"/srv/other"]"#).unwrap(), None);
        store.decide_remote(here, false).unwrap();
        assert_eq!(load().remote_decision(here).unwrap(), Some(false));
    }
}
