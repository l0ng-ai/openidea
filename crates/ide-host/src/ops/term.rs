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
    let key = host.owner_window(window).to_owned();
    let info = host.terminals.spawn(options, key, host.window_sink(window), Box::new(move |chunk| on_output(chunk)))?;
    if let Some(line) = activation {
        let _ = host.terminals.write(info.id, &format!(" {line}\r"));
    }
    Ok(info)
}

/// Tools › Start SSH Session: a login shell on SSH configuration `id`, opened by the
/// built-in client with the configuration's saved password, key or agent.
pub async fn spawn_ssh(
    host: &Host,
    window: &str,
    id: &str,
    cols: u16,
    rows: u16,
    on_output: Emit<String>,
) -> IdeResult<TerminalInfo> {
    let config = host.ssh.config(id)?;
    if config.host.trim().is_empty() {
        return Err(ide_core::IdeError::invalid(format!("SSH configuration {} has no host", config.name)));
    }
    let size = (if cols == 0 { 80 } else { cols }, if rows == 0 { 24 } else { rows });
    let session = host.ssh.session(id).await?;
    let (feed, output) = ide_terminal::feed();
    let out = feed.clone();
    let process = session
        .spawn(
            "",
            Some(size),
            Box::new(move |chunk| match chunk {
                ide_ssh::Output::Stdout(data) | ide_ssh::Output::Stderr(data) => out.output(data),
            }),
        )
        .await?;
    let exit = process.exit_status();
    let (input, mut inputs) = tokio::sync::mpsc::unbounded_channel();
    host.runtime.spawn(async move {
        let p = process;
        while let Some(op) = inputs.recv().await {
            let result = match op {
                SshInput::Data(data) => p.write(&data).await,
                SshInput::Resize(cols, rows) => p.resize(cols, rows).await,
                SshInput::Close => {
                    p.close().await;
                    break;
                }
            };
            if let Err(e) = result {
                tracing::debug!("ssh terminal: {e}");
            }
        }
    });
    host.runtime.spawn(async move {
        let code = exit.await;
        feed.exited(code.and_then(|c| i32::try_from(c).ok()));
    });
    let title = if config.name.trim().is_empty() { config.label() } else { config.name.clone() };
    host.terminals.attach(
        title,
        size,
        Box::new(SshTerminal(input)),
        output,
        host.owner_window(window).to_owned(),
        host.window_sink(window),
        Box::new(move |chunk| on_output(chunk)),
    )
}

enum SshInput {
    Data(Vec<u8>),
    Resize(u16, u16),
    Close,
}

/// Input of an SSH shell, sent in order by one task.
struct SshTerminal(tokio::sync::mpsc::UnboundedSender<SshInput>);

impl ide_terminal::TerminalChannel for SshTerminal {
    fn write(&self, data: &[u8]) -> IdeResult<()> {
        self.0.send(SshInput::Data(data.to_vec())).map_err(|_| ide_core::IdeError::invalid("the SSH session has ended"))
    }

    fn resize(&self, cols: u16, rows: u16) -> IdeResult<()> {
        let _ = self.0.send(SshInput::Resize(cols, rows));
        Ok(())
    }

    fn close(&self) {
        let _ = self.0.send(SshInput::Close);
    }
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
