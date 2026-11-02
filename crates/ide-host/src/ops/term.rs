use super::Emit;
use crate::Host;
use ide_core::{IdeResult, TerminalId};
use ide_terminal::{TerminalInfo, TerminalOptions};

mod images;

const MAX_IMAGE_BYTES: usize = 20 * 1024 * 1024;

pub async fn store_image(host: &Host, id: TerminalId, data: Vec<u8>, mime: String) -> IdeResult<String> {
    if data.len() > MAX_IMAGE_BYTES {
        return Err(ide_core::IdeError::invalid("image is too large to paste (limit 20 MB)"));
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::HostConfig;
    use ide_core::{NullSink, error::ErrorKind};
    use std::sync::Arc;

    #[tokio::test]
    async fn image_size_limit_is_checked_before_storage() {
        let root = tempfile::tempdir().unwrap();
        let host = Host::new(HostConfig {
            config_dir: root.path().join("config"),
            data_dir: root.path().join("data"),
            local_data_dir: root.path().join("data"),
            languages: Arc::new(ide_language::LanguageRegistry::load(None).unwrap()),
            syntax: Arc::default(),
            sink_for: Box::new(|_| Arc::new(NullSink)),
            owner: |window| window,
            runtime: tokio::runtime::Handle::current(),
            project_environment: false,
        });
        let id = TerminalId::next();
        let error = store_image(&host, id, vec![0; MAX_IMAGE_BYTES + 1], "image/png".into()).await.unwrap_err();
        assert_eq!(error.kind, ErrorKind::InvalidInput);
        assert_eq!(error.message, "image is too large to paste (limit 20 MB)");
        let error = store_image(&host, id, vec![0; MAX_IMAGE_BYTES], "image/png".into()).await.unwrap_err();
        assert_eq!(error.message, "terminal session not found");
        assert!(!host.data_dir.join("terminal-images").exists());
    }
}
