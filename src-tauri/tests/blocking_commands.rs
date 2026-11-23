//! Tauri runs a sync command on the main thread, so disk I/O or a large diff there freezes the
//! window (input, painting, every other IPC call).

use ide_host::catalogue::Mode;

/// Commands that read or write project files, Local History or `.env` files, diff two
/// arbitrary texts, scan the project index or tree, read agent registries and transcripts, or
/// call the OS keychain: they must do that work off the main thread. Commands that parse and
/// validate another project's settings recurse deeply enough to overflow the main thread's stack
/// in a debug build on Windows.
const OFF_MAIN_THREAD: &[&str] = &[
    "project_workspace_members",
    "project_workspace_member_set",
    "history_list",
    "history_content",
    "find_files",
    "find_dirs",
    "find_symbols",
    "vcs_diff_hunks",
    "vcs_shelves",
    "vcs_shelf_delete",
    "vcs_shelf_rename",
    "vcs_shelf_patch",
    "vcs_changelists_load",
    "run_save_configs",
    "run_templates",
    "run_save_templates",
    "run_import_sources",
    "run_import_configs",
    "run_env_files",
    "agent_entries",
    "agent_providers",
    "plugin_secrets",
    "plugin_set_secret",
    "spring_route_sources",
];

#[test]
fn disk_and_diff_commands_stay_off_the_main_thread() {
    let declarations = openidea_lib::declarations();
    let on_main: Vec<_> = OFF_MAIN_THREAD
        .iter()
        .filter(|name| {
            let declared = declarations.iter().find(|c| c.name == **name);
            declared.unwrap_or_else(|| panic!("no command {name}")).mode == Mode::Sync
        })
        .collect();
    assert!(on_main.is_empty(), "synchronous commands run on the main thread: {on_main:?}");
}
