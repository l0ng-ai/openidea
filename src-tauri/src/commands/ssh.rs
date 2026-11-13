use crate::state::AppState;
use ide_core::remote_settings::SshConfiguration;
use ide_core::{IdeEvent, IdeResult};
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

/// Tools › Start SSH Session: a shell on configuration `id` in a terminal tab, through the
/// built-in client with the configuration's saved credentials.
#[tauri::command]
#[specta::specta]
pub async fn ssh_open_terminal(
    window: tauri::Window,
    state: State<'_, AppState>,
    id: String,
    cols: u16,
    rows: u16,
    on_output: tauri::ipc::Channel<String>,
) -> IdeResult<ide_terminal::TerminalInfo> {
    let host = state.host.clone();
    ide_host::ops::term::spawn_ssh(
        &host,
        window.label(),
        &id,
        cols,
        rows,
        std::sync::Arc::new(move |chunk| {
            let _ = on_output.send(chunk);
        }),
    )
    .await
}
