//! Starting child processes without a console window.
//!
//! Release builds of the IDE are GUI-subsystem executables, so they own no
//! console. Windows gives every console-subsystem child such a process spawns a
//! *new* console window, which shows up as a black box on top of the IDE — one
//! per language server, debug adapter, tool probe or VCS command. Those
//! children talk over pipes (JSON-RPC on stdio, captured output), so they need
//! no window at all: every spawn goes through [`hide_console_window`].

/// `CREATE_NO_WINDOW`: run a console-subsystem child without a console window.
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Suppresses the console window Windows would otherwise create for `cmd`'s
/// child (a no-op on macOS and Linux, so call sites stay portable).
#[cfg(windows)]
pub fn hide_console_window(cmd: &mut std::process::Command) {
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

/// Suppresses the console window Windows would otherwise create for `cmd`'s
/// child (a no-op on macOS and Linux, so call sites stay portable).
#[cfg(not(windows))]
pub fn hide_console_window(_cmd: &mut std::process::Command) {}
