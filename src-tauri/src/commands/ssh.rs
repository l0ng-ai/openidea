use crate::state::AppState;
use ide_core::remote_settings::SshConfiguration;
use ide_core::{IdeError, IdeEvent, IdeResult};
use ide_ssh::SshTarget;
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::State;

/// Settings › SSH Configurations: the configurations in effect.
pub(crate) fn apply_ssh_settings(state: &AppState) {
    state.ssh.set_configs(state.global_settings.effective().ssh.configs);
}

/// Test Connection: connects with `config` as edited (not necessarily saved).
#[tauri::command]
#[specta::specta]
pub async fn ssh_test(
    state: State<'_, AppState>,
    config: SshConfiguration,
    secret: Option<String>,
) -> IdeResult<String> {
    let ssh = state.ssh.clone();
    ssh.test(&config, secret).await
}

/// Remembers the password / passphrase of configuration `id` (`None` forgets it).
#[tauri::command]
#[specta::specta]
pub fn ssh_set_secret(state: State<'_, AppState>, id: String, secret: Option<String>, save: bool) {
    state.ssh.set_secret(&id, secret, save);
}

/// Whether connecting with configuration `id` needs a password first.
#[tauri::command]
#[specta::specta]
pub fn ssh_needs_secret(state: State<'_, AppState>, id: String) -> IdeResult<bool> {
    Ok(state.ssh.needs_secret(&state.ssh.config(&id)?))
}

/// Trusts the host key that failed the last connection of configuration `id`.
#[tauri::command]
#[specta::specta]
pub async fn ssh_trust_host(state: State<'_, AppState>, id: String) -> IdeResult<()> {
    let ssh = state.ssh.clone();
    ssh.trust_host(&id).await
}

/// Ids of the configurations with an open connection.
#[tauri::command]
#[specta::specta]
pub fn ssh_connected(state: State<'_, AppState>) -> Vec<String> {
    state.ssh.connected()
}

#[tauri::command]
#[specta::specta]
pub fn ssh_disconnect(state: State<'_, AppState>, id: String) {
    state.ssh.disconnect(&id);
}

/// Answers an `IdeEvent::Askpass` prompt (`None`: cancelled); every window drops it.
#[tauri::command]
#[specta::specta]
pub fn ssh_askpass_answer(state: State<'_, AppState>, id: u64, answer: Option<String>, remember: bool) {
    if let Some(server) = &state.askpass {
        server.answer(id, answer, remember);
    }
    state.sink.emit(IdeEvent::AskpassDone { id });
}

/// Settings › Git › Saved credentials: `scheme://host` of every saved entry.
#[tauri::command]
#[specta::specta]
pub fn git_credentials(_state: State<'_, AppState>) -> Vec<String> {
    ide_ssh::git_creds::get().map(|s| s.list()).unwrap_or_default()
}

/// Forgets the credential of `key` (a `git_credentials` entry).
#[tauri::command]
#[specta::specta]
pub fn git_credential_forget(_state: State<'_, AppState>, key: String) {
    if let Some(store) = ide_ssh::git_creds::get() {
        store.forget(&key);
    }
}

#[derive(Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SshTerminalCommand {
    pub shell: String,
    pub args: Vec<String>,
    pub title: String,
}

/// Tools › Start SSH Session: the system `ssh` command line for configuration `id`
/// (run in a terminal tab, so prompts and host-key questions are answered there).
#[tauri::command]
#[specta::specta]
pub fn ssh_terminal_command(state: State<'_, AppState>, id: String) -> IdeResult<SshTerminalCommand> {
    let config = state.ssh.config(&id)?;
    if config.host.trim().is_empty() {
        return Err(IdeError::invalid(format!("SSH configuration {} has no host", config.name)));
    }
    let path = std::env::var_os("PATH").unwrap_or_default();
    let shell = ide_run::which::find_executable("ssh", &path)
        .map(|p| p.to_string_lossy().into_owned())
        .ok_or_else(|| IdeError::unavailable("ssh is not installed (OpenSSH client not found on PATH)"))?;
    let mut args = vec!["-t".to_owned()];
    args.extend(ide_ssh::openssh_args(&SshTarget::from(&config)));
    let title = if config.name.trim().is_empty() { config.label() } else { config.name.clone() };
    Ok(SshTerminalCommand { shell, args, title })
}
