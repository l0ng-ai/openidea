//! SSH configuration commands shared by the desktop shell's IPC commands and the remote
//! server ([`crate::rpc`]). A remote window connects from the server (deployment, database
//! tunnels, run targets, SSH sessions), so the host keys it trusts and the passwords it is
//! given belong to the server's [`ide_ssh::SshManager`], not the desktop's.
use crate::Host;
use crate::rpc::Dispatcher;
use ide_core::IdeResult;
use ide_core::remote_settings::SshConfiguration;

/// Test Connection: connects with `config` as edited (not necessarily saved).
pub async fn ssh_test(host: &Host, config: SshConfiguration, secret: Option<String>) -> IdeResult<String> {
    host.ssh.test(&config, secret).await
}

/// Remembers the password / passphrase of configuration `id` (`None` forgets it).
pub fn ssh_set_secret(host: &Host, id: String, secret: Option<String>, save: bool) {
    host.ssh.set_secret(&id, secret, save);
}

/// Whether a password is saved under `key` (an FTP deployment server's).
pub fn ssh_password_saved(host: &Host, key: String) -> bool {
    host.ssh.password_saved(&key)
}

/// Whether connecting with configuration `id` needs a password first.
pub fn ssh_needs_secret(host: &Host, id: String) -> IdeResult<bool> {
    Ok(host.ssh.needs_secret(&host.ssh.config(&id)?))
}

/// Trusts the host key that failed the last connection of configuration `id`.
pub async fn ssh_trust_host(host: &Host, id: String) -> IdeResult<()> {
    host.ssh.trust_host(&id).await
}

/// Ids of the configurations with an open connection.
pub fn ssh_connected(host: &Host) -> Vec<String> {
    host.ssh.connected()
}

pub fn ssh_disconnect(host: &Host, id: String) {
    host.ssh.disconnect(&id);
}

pub(crate) fn register(d: &mut Dispatcher) {
    d.add("ssh_test", |c| async move { ssh_test(&c.host, c.arg("config")?, c.arg("secret")?).await });
    d.add("ssh_set_secret", |c| async move {
        ssh_set_secret(&c.host, c.arg("id")?, c.arg("secret")?, c.arg("save")?);
        Ok(())
    });
    d.add("ssh_password_saved", |c| async move { Ok(ssh_password_saved(&c.host, c.arg("key")?)) });
    d.add("ssh_needs_secret", |c| async move { ssh_needs_secret(&c.host, c.arg("id")?) });
    d.add("ssh_trust_host", |c| async move { ssh_trust_host(&c.host, c.arg("id")?).await });
    d.add("ssh_connected", |c| async move { Ok(ssh_connected(&c.host)) });
    d.add("ssh_disconnect", |c| async move {
        ssh_disconnect(&c.host, c.arg("id")?);
        Ok(())
    });
}
