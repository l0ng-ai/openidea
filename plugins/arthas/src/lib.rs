//! OpenIDEA plugin: IntelliJ-style "Arthas Command" submenu on the Java editor.
//! Select Watch / Trace / Monitor / Stack to copy the command for the class and
//! method under the caret, ready to paste into an attached Arthas console.
//!
//! Build with `plugins/build.sh arthas` (see plugins/README.md).

mod commands;

#[cfg(target_arch = "wasm32")]
wit_bindgen::generate!({
    world: "plugin",
    path: "../../wit",
});

#[cfg(target_arch = "wasm32")]
use openidea::plugin::host::{self, LogLevel};

/// Static contributions (`contributes.commands` / `contributes.menu-items`) do
/// the menu work; the plugin only needs to answer when an item is selected.
#[cfg(target_arch = "wasm32")]
struct Arthas;

#[cfg(target_arch = "wasm32")]
impl Guest for Arthas {
    fn activate(_ctx: Context) -> Result<(), String> {
        host::log(LogLevel::Info, "arthas commands ready");
        Ok(())
    }

    fn deactivate() {}

    fn run_command(id: String, _arg: Option<String>) -> Result<Option<String>, String> {
        let kind = match id.as_str() {
            "watch" => commands::Kind::Watch,
            "trace" => commands::Kind::Trace,
            "monitor" => commands::Kind::Monitor,
            "stack" => commands::Kind::Stack,
            other => return Err(format!("unknown command: {other}")),
        };
        let path = host::active_file().ok_or("place the caret in a Java file first")?;
        let line = host::caret_line().ok_or("place the caret in a Java file first")? as usize;
        let text = host::read_file(&path)?;
        let target = commands::target(&text, line).ok_or("the caret is not inside a Java method")?;
        let command = commands::command(kind, &target);
        host::write_clipboard(&command);
        Ok(Some(command))
    }
}

#[cfg(target_arch = "wasm32")]
export!(Arthas);
