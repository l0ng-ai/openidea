//! IPC surface: the desktop commands, by domain, and the adapters derived for the project-host
//! commands `ide-host` declares; `builder()` registers them all.
//!
//! Conventions:
//! * every command returns `IdeResult<T>` (rejects with `IdeError` in JS);
//! * project-scoped commands resolve the project from the calling window;
//! * streaming results use a `Channel<T>` argument; cancellable requests take a
//!   UI-allocated `RequestId` and are cancelled via `cancel_request`.

pub mod agent;
pub mod android;
pub mod app;
pub mod caches;
pub mod clipboard;
pub mod db;
pub mod debug;
pub mod doc;
pub mod docker;
pub mod file_dialog;
pub mod fonts;
pub mod fs;
pub mod github;
pub mod hotkeys;
pub mod http;
pub mod lsp;
pub mod mcp;
pub mod nav;
pub mod notification;
pub mod perf;
pub mod plugin;
pub mod profiler;
pub mod ssh;
pub mod vcs;
pub mod web;
pub mod window;
pub mod window_drag;
pub mod window_group;
pub mod workspace;
pub mod wsl;

use crate::remote_dev;
use ide_host::catalogue::{Command, Placement, TrustClass};
use std::sync::LazyLock;

// Desktop bodies of project-host commands (`#[command(desktop_body = …)]`), which their derived
// adapters call.
use app::{
    close_project, open_project, project_current, project_trust_remove_location, project_trust_set, settings_get,
    settings_removed_theme, settings_set,
};
use doc::doc_edit;
use plugin::plugin_event_kinds;

/// A Tauri channel as the shared implementation's streaming argument.
pub(crate) fn sender<T: tauri::ipc::IpcResponse + Send + Sync + 'static>(
    channel: tauri::ipc::Channel<T>,
) -> ide_host::ops::Channel<T> {
    ide_host::ops::Channel::new(move |v| {
        let _ = channel.send(v);
    })
}

/// The Tauri adapter of one project-host command, from the signature its `#[command]` hands over:
/// it calls the `ide-host` implementation, or the desktop body of the same name in this module.
macro_rules! adapter {
    (@ty plain [$($p:tt)*] $m:ident $a:ident) => { $($p)*::$m::$a };
    (@ty channel [$($p:tt)*] $m:ident $a:ident) => { tauri::ipc::Channel<$($p)*::$m::$a> };
    (@ret [$($p:tt)*] $m:ident $rt:ident) => { $($p)*::$m::$rt };
    (@fn [$($p:tt)*] $name:ident) => { $($p)*::$name };
    (@val $w:ident (inj host)) => { &tauri::Manager::state::<$crate::state::AppState>(&$w).host };
    (@val $w:ident (inj window)) => { $w.label() };
    (@val $w:ident (inj plugins)) => { &tauri::Manager::state::<$crate::state::AppState>(&$w).plugins };
    (@val $w:ident (arg plain $x:ident)) => { $x };
    (@val $w:ident (arg channel $x:ident)) => { $crate::commands::sender($x) };
    (@command [$($p:tt)*] $name:ident $m:ident) => {
        #[doc(hidden)]
        pub mod $name {
            pub const COMMAND: ide_host::catalogue::Command = $($p)*::$m::COMMAND;
        }
    };
    ({ $pp:tt $dom:ident } { name: $name:ident, module: $m:ident, docs: [$(#[$doc:meta])*], run: async,
       result: $r:ident [$($rt:ident)?], body: derived, args: [$(($x:ident $k:ident $a:ident))*], call: [$($c:tt)*], }) => {
        $(#[$doc])*
        #[tauri::command]
        #[specta::specta]
        #[allow(clippy::too_many_arguments, unused_variables)] // `window`: a command may inject nothing
        pub async fn $name(
            window: tauri::Window,
            $($x: $crate::commands::adapter!(@ty $k $pp $m $a)),*
        ) $(-> $crate::commands::adapter!(@ret $pp $m $rt))? {
            $crate::commands::adapter!(@fn $pp $name)($($crate::commands::adapter!(@val window $c)),*).await
        }
        $crate::commands::adapter!(@command $pp $name $m);
    };
    ({ $pp:tt $dom:ident } { name: $name:ident, module: $m:ident, docs: [$(#[$doc:meta])*], run: sync,
       result: $r:ident [$($rt:ident)?], body: derived, args: [$(($x:ident $k:ident $a:ident))*], call: [$($c:tt)*], }) => {
        $(#[$doc])*
        #[tauri::command]
        #[specta::specta]
        #[allow(clippy::too_many_arguments, unused_variables)] // `window`: a command may inject nothing
        pub fn $name(
            window: tauri::Window,
            $($x: $crate::commands::adapter!(@ty $k $pp $m $a)),*
        ) $(-> $crate::commands::adapter!(@ret $pp $m $rt))? {
            $crate::commands::adapter!(@fn $pp $name)($($crate::commands::adapter!(@val window $c)),*)
        }
        $crate::commands::adapter!(@command $pp $name $m);
    };
    ({ $pp:tt $dom:ident } { name: $name:ident, module: $m:ident, docs: [$(#[$doc:meta])*], run: async,
       result: $r:ident [$($rt:ident)?], body: desktop, args: [$(($x:ident $k:ident $a:ident))*], call: $c:tt, }) => {
        $(#[$doc])*
        #[tauri::command]
        #[specta::specta]
        pub async fn $name(
            window: tauri::Window,
            $($x: $crate::commands::adapter!(@ty $k $pp $m $a)),*
        ) $(-> $crate::commands::adapter!(@ret $pp $m $rt))? {
            $crate::commands::$name(window, $($x),*).await
        }
        $crate::commands::adapter!(@command $pp $name $m);
    };
    ({ $pp:tt $dom:ident } { name: $name:ident, module: $m:ident, docs: [$(#[$doc:meta])*], run: sync,
       result: $r:ident [$($rt:ident)?], body: desktop, args: [$(($x:ident $k:ident $a:ident))*], call: $c:tt, }) => {
        $(#[$doc])*
        #[tauri::command]
        #[specta::specta]
        pub fn $name(
            window: tauri::Window,
            $($x: $crate::commands::adapter!(@ty $k $pp $m $a)),*
        ) $(-> $crate::commands::adapter!(@ret $pp $m $rt))? {
            $crate::commands::$name(window, $($x),*)
        }
        $crate::commands::adapter!(@command $pp $name $m);
    };
    ({ $pp:tt $dom:ident } { name: $name:ident, module: $m:ident, docs: [$(#[$doc:meta])*], run: spawn,
       result: $r:ident [$($rt:ident)?], body: desktop, args: [$(($x:ident $k:ident $a:ident))*], call: $c:tt, }) => {
        $(#[$doc])*
        #[tauri::command(async)]
        #[specta::specta]
        pub fn $name(
            window: tauri::Window,
            $($x: $crate::commands::adapter!(@ty $k $pp $m $a)),*
        ) $(-> $crate::commands::adapter!(@ret $pp $m $rt))? {
            $crate::commands::$name(window, $($x),*)
        }
        $crate::commands::adapter!(@command $pp $name $m);
    };
}
pub(crate) use adapter;

/// One module of adapters per `ide-host` domain, from the list `__domains!` hands over.
macro_rules! derive_domains {
    ({} [$(($dom:ident $list:ident { $($p:tt)* }))*]) => {
        $(
            pub mod $dom {
                ide_host::$list!(@each [$crate::commands::adapter] { [$($p)*] $dom });
            }
        )*
    };
}
pub(crate) use derive_domains;

/// The derived adapters of every project-host command.
pub mod derived {
    ide_host::__domains!(@names [crate::commands::derive_domains] {});
}

/// `command_paths!(@go [] desktop app; …; host; raw [fonts::user_font_data])`: every command's
/// path, gathered domain by domain (`host` is every `ide-host` domain), then `sorted_catalogue!`.
macro_rules! command_paths {
    (@go [$($done:tt)*] desktop $m:ident; $($rest:tt)*) => {
        $m::__desktop_domain!(@names [$crate::commands::command_paths] { @named [$($done)*] [$m] [$($rest)*] })
    };
    (@go [$($done:tt)*] host; $($rest:tt)*) => {
        ide_host::__domains!(@names [$crate::commands::command_paths] { @domains [$($done)*] [$($rest)*] })
    };
    (@go [$($done:tt)*] domain $list:ident $dom:ident; $($rest:tt)*) => {
        ide_host::$list!(@names [$crate::commands::command_paths] { @named [$($done)*] [derived::$dom] [$($rest)*] })
    };
    (@go [$([$($seg:ident)::+] $n:ident,)*] raw [$($raw:path),*]) => {
        ide_command::sorted_catalogue!(bindings: $($($seg)::+::$n),*; raw: $($raw),*)
    };
    ({ @named [$($done:tt)*] $m:tt [$($rest:tt)*] } [$($n:ident)*]) => {
        $crate::commands::command_paths!(@go [$($done)* $($m $n,)*] $($rest)*)
    };
    ({ @domains [$($done:tt)*] [$($rest:tt)*] } [$(($dom:ident $list:ident { $($p:tt)* }))*]) => {
        $crate::commands::command_paths!(@go [$($done)*] $(domain $list $dom;)* $($rest)*)
    };
}
pub(crate) use command_paths;

/// Every command, sorted by name: the commands in the bindings, and each command's declaration.
fn catalogue() -> (tauri_specta::Commands<tauri::Wry>, Vec<Command>) {
    let (commands, declarations) = command_paths!(@go []
        desktop agent;
        desktop android;
        desktop app;
        desktop caches;
        desktop clipboard;
        desktop db;
        desktop debug;
        desktop docker;
        desktop file_dialog;
        desktop fonts;
        desktop fs;
        desktop github;
        desktop hotkeys;
        desktop http;
        desktop lsp;
        desktop mcp;
        desktop nav;
        desktop notification;
        desktop perf;
        desktop plugin;
        desktop profiler;
        desktop remote_dev;
        desktop ssh;
        desktop vcs;
        desktop web;
        desktop window;
        desktop window_drag;
        desktop window_group;
        desktop workspace;
        desktop wsl;
        host;
        // Its raw response isn't a JSON type: `lib.rs` registers it outside the bindings.
        raw [fonts::user_font_data]
    );
    (commands, declarations.to_vec())
}

pub fn builder() -> tauri_specta::Builder<tauri::Wry> {
    tauri_specta::Builder::<tauri::Wry>::new().commands(catalogue().0)
}

/// Every command's declaration, sorted by name.
pub fn declarations() -> &'static [Command] {
    static DECLARATIONS: LazyLock<Vec<Command>> = LazyLock::new(|| catalogue().1);
    &DECLARATIONS
}

/// The trust class `command` declares; `None` for a name no command has.
pub fn trust_of(command: &str) -> Option<TrustClass> {
    let declarations = declarations();
    declarations.binary_search_by_key(&command, |c| c.name).ok().map(|i| declarations[i].trust)
}

/// The commands a remote window routes to its server: this build's project-host commands, fixed
/// here rather than taken from the server, so a server cannot move a command to this machine.
pub fn routed() -> Vec<&'static str> {
    declarations().iter().filter(|c| c.placement == Placement::ProjectHost).map(|c| c.name).collect()
}

#[cfg(test)]
mod tests {
    /// A domain missing from `catalogue()` would run on this machine in a remote window.
    #[test]
    fn routes_exactly_the_commands_a_server_of_this_build_declares() {
        let mut served = ide_host::rpc::Dispatcher::standard().commands();
        served.sort_unstable();
        assert_eq!(super::routed(), served);
    }
}
