use super::Emit;
use crate::Host;
use ide_core::{IdeResult, TerminalId};
use ide_terminal::{TerminalInfo, TerminalOptions};

pub fn spawn(host: &Host, window: &str, options: TerminalOptions, on_output: Emit<String>) -> IdeResult<TerminalInfo> {
    // Python › "Activate virtualenv": typed into the new shell, like PyCharm.
    let activation = host
        .project(window)
        .ok()
        .and_then(|p| ide_sdk::apply::terminal_activation(&p.root, &p.settings.effective(), options.shell.as_deref()));
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
