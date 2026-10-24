//! Child-process helpers shared by every crate that spawns tools.

use std::process::Command;

/// Keeps a console child (java, node, curl, a language server, ...) from
/// opening its own console window on Windows. Release builds use the GUI
/// subsystem, so without this every spawn flashes a `cmd` window. A no-op
/// elsewhere. For a `tokio::process::Command`, pass `cmd.as_std_mut()`.
pub fn no_window(cmd: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}
