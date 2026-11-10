//! The ide-host integration tests, compiled as one test binary so a change links it once
//! instead of once per file. `language_smoke` stays its own target (CI runs it by name).

mod close_project;
mod data_dirs;
mod distribution;
mod external_log;
mod language_service;
mod light_edit;
mod php_engine;
mod php_fixture;
mod plugins;
mod properties;
mod proxy;
mod remote_env;
mod remote_plugins;
mod rpc;
mod run_configs;
mod terminal_activation;
mod terminal_images;
mod trust;
mod trust_git_binary;
mod unity;
mod vcs_documents;
mod vcs_encoding;
mod vcs_flow;
mod vcs_roots;
mod vcs_shelf_roots;
mod vcs_worktrees;
mod workspace_edits;
mod workspaces;
