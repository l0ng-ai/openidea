//! Tauri runs a command declared without `async` on the main thread, so disk I/O or a
//! large diff there freezes the window (input, painting, every other IPC call).

/// Commands that read or write project files, Local History or `.env` files, or diff two
/// arbitrary texts: they must be `async` and do that work on the blocking pool.
const OFF_MAIN_THREAD: &[(&str, &[&str])] = &[
    ("doc.rs", &["history_list", "history_content"]),
    (
        "vcs.rs",
        &[
            "vcs_diff_hunks",
            "vcs_shelves",
            "vcs_shelf_delete",
            "vcs_shelf_rename",
            "vcs_shelf_patch",
            "vcs_changelists_load",
        ],
    ),
    (
        "run.rs",
        &[
            "run_save_configs",
            "run_templates",
            "run_save_templates",
            "run_import_sources",
            "run_import_configs",
            "run_env_files",
        ],
    ),
];

#[test]
fn disk_and_diff_commands_stay_off_the_main_thread() {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/commands");
    let mut on_main = Vec::new();
    for (file, commands) in OFF_MAIN_THREAD {
        let source = std::fs::read_to_string(dir.join(file)).unwrap();
        for command in *commands {
            assert!(source.contains(&format!("fn {command}(")), "{file} has no command {command}");
            if !source.contains(&format!("pub async fn {command}(")) {
                on_main.push(*command);
            }
        }
    }
    assert!(on_main.is_empty(), "synchronous commands run on the main thread: {on_main:?}");
}
