use super::Emit;
use crate::Host;
use ide_core::{IdeResult, TerminalId};
use ide_terminal::{TerminalInfo, TerminalOptions};

mod images;

pub async fn store_image(host: &Host, id: TerminalId, data: Vec<u8>, mime: String) -> IdeResult<String> {
    if !host.terminals.contains(id) {
        return Err(ide_core::IdeError::invalid("terminal session not found"));
    }
    let data_dir = host.data_dir.clone();
    host.blocking(move || images::store(&data_dir, &data, &mime)).await
}

pub fn spawn(
    host: &Host,
    window: &str,
    mut options: TerminalOptions,
    on_output: Emit<String>,
) -> IdeResult<TerminalInfo> {
    if !host.project(window).is_ok_and(|p| p.is_trusted()) {
        // Project terminal settings can otherwise start a command as soon as a tab restores.
        let global = host.global_settings.effective().terminal;
        options.shell = None;
        options.args.clear();
        options.env = global.env;
    }
    let (shell, args) = ide_terminal::resolve_shell(options.shell.as_deref(), &options.args);
    options.shell = Some(shell.clone());
    options.args = args;
    // Python › "Activate virtualenv": typed into the same shell the PTY starts.
    let activation = host
        .project(window)
        .ok()
        .filter(|p| p.is_trusted())
        .and_then(|p| ide_sdk::apply::terminal_activation(&p.root, &p.settings.effective(), &shell));
    let info = host.terminals.spawn(options, host.window_sink(window), Box::new(move |chunk| on_output(chunk)))?;
    if let Some(line) = activation {
        let _ = host.terminals.write(info.id, &format!(" {line}\r"));
    }
    Ok(info)
}

pub fn write(host: &Host, id: TerminalId, data: &str) -> IdeResult<()> {
    host.terminals.write(id, data)
}

pub fn resize(host: &Host, id: TerminalId, cols: u16, rows: u16) -> IdeResult<()> {
    host.terminals.resize(id, cols, rows)
}

pub fn kill(host: &Host, id: TerminalId) -> IdeResult<()> {
    host.terminals.kill(id)
}

pub fn is_busy(host: &Host, id: TerminalId) -> IdeResult<bool> {
    host.terminals.is_busy(id)
}
