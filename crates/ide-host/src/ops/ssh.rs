//! SSH configuration commands shared by the desktop shell's IPC commands and the remote
//! server ([`crate::rpc`]). A remote window connects from the server (deployment, database
//! tunnels, run targets, SSH sessions), so the host keys it trusts and the passwords it is
//! given belong to the server's [`ide_ssh::SshManager`], not the desktop's.
use crate::Host;
use ide_command::command;
use ide_core::event::NotifyLevel;
use ide_core::remote_settings::SshConfiguration;
use ide_core::{IdeError, IdeEvent, IdeResult};
use ide_ssh::secrets::LegacyPasswordAction;

/// Test Connection: connects with `config` as edited (not necessarily saved).
#[command(trust = always)]
pub async fn ssh_test(host: &Host, config: SshConfiguration, secret: Option<String>) -> IdeResult<String> {
    host.ssh.test(&config, secret).await
}

/// Remembers the password / passphrase of configuration `id` (`None` forgets it).
#[command(trust = always)]
pub fn ssh_set_secret(host: &Host, window: &str, id: String, secret: Option<String>, save: bool) {
    if let Err(e) = host.ssh.set_secret(&id, secret, save) {
        host.window_sink(window).emit(IdeEvent::Notify {
            level: NotifyLevel::Warning,
            title: "Could not save credential".into(),
            body: Some(e.message),
        });
    }
}

/// `Some` means legacy credentials remain in plaintext on this host.
#[command(trust = always)]
pub async fn ssh_legacy_passwords(host: &Host, action: LegacyPasswordAction) -> IdeResult<Option<String>> {
    let ssh = host.ssh.clone();
    tokio::task::spawn_blocking(move || ssh.resolve_legacy_passwords(action))
        .await
        .map_err(|e| IdeError::internal(e.to_string()))?
}

/// Whether a password is saved under `key` (an FTP deployment server's).
#[command(trust = always)]
pub fn ssh_password_saved(host: &Host, key: String) -> bool {
    host.ssh.password_saved(&key)
}

/// Whether connecting with configuration `id` needs a password first.
#[command(trust = always)]
pub fn ssh_needs_secret(host: &Host, id: String) -> IdeResult<bool> {
    Ok(host.ssh.needs_secret(&host.ssh.config(&id)?))
}

/// Trusts the host key that failed the last connection of configuration `id`.
#[command(trust = always)]
pub async fn ssh_trust_host(host: &Host, id: String) -> IdeResult<()> {
    host.ssh.trust_host(&id).await
}

/// Ids of the configurations with an open connection.
#[command(trust = always)]
pub fn ssh_connected(host: &Host) -> Vec<String> {
    host.ssh.connected()
}

#[command(trust = always)]
pub fn ssh_disconnect(host: &Host, id: String) {
    host.ssh.disconnect(&id);
}

ide_command::domain!(
    ssh:
    ssh_connected,
    ssh_disconnect,
    ssh_legacy_passwords,
    ssh_needs_secret,
    ssh_password_saved,
    ssh_set_secret,
    ssh_test,
    ssh_trust_host,
);
