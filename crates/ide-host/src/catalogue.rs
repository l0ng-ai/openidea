//! What every command declares: its trust class, where it runs, and how Tauri runs it.
//! `#[ide_command::command]` and `#[ide_command::desktop_command]` give each command a
//! [`Command`].

/// Where a command may run, from the trust decision of the window's project.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum TrustClass {
    /// Everywhere, including Restricted Mode.
    Always,
    /// With no project open, or in a trusted project.
    OutsideRestricted,
    /// Only in a trusted project.
    Trusted,
}

/// Which backend runs a command for a remote window.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Placement {
    Desktop,
    ProjectHost,
}

/// How Tauri runs the command: on the invoking thread, as a future, or on its thread pool.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Mode {
    Sync,
    Async,
    Spawn,
}

/// One command's declaration.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Command {
    pub name: &'static str,
    pub trust: TrustClass,
    pub placement: Placement,
    /// In `bindings.ts`; a command registered outside tauri-specta isn't.
    pub bindings: bool,
    pub mode: Mode,
}
