use crate::state::AppState;
use ide_command::desktop_command;
use ide_core::{IdeEvent, IdeResult};
use tauri::State;

/// Settings › SSH Configurations: the configurations in effect.
pub(crate) fn apply_ssh_settings(state: &AppState) {
    state.ssh.set_configs(state.global_settings.effective().ssh.configs);
}

/// Answers an `IdeEvent::Askpass` prompt (`None`: cancelled); every window drops it.
#[desktop_command(trust = always)]
#[tauri::command]
#[specta::specta]
pub fn ssh_askpass_answer(state: State<'_, AppState>, id: u64, answer: Option<String>, remember: bool) {
    if let Some(server) = &state.askpass {
        server.answer(id, answer, remember);
    }
    state.sink.emit(IdeEvent::AskpassDone { id });
}

/// Settings › Git › Saved credentials: `scheme://host` of every saved entry.
#[desktop_command(trust = always)]
#[tauri::command]
#[specta::specta]
pub fn git_credentials(_state: State<'_, AppState>) -> Vec<String> {
    ide_ssh::git_creds::get().map(|s| s.list()).unwrap_or_default()
}

/// Forgets the credential of `key` (a `git_credentials` entry).
#[desktop_command(trust = always)]
#[tauri::command]
#[specta::specta]
pub fn git_credential_forget(_state: State<'_, AppState>, key: String) {
    if let Some(store) = ide_ssh::git_creds::get() {
        store.forget(&key);
    }
}

/// Tools › Start SSH Session: a shell on configuration `id` in a terminal tab, through the
/// built-in client with the configuration's saved credentials.
#[desktop_command(trust = always)]
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

ide_command::desktop_domain!(git_credential_forget, git_credentials, ssh_askpass_answer, ssh_open_terminal,);
