//! SSH configuration commands shared by the desktop shell's IPC commands and the remote
//! server ([`crate::rpc`]). A remote window connects from the server (deployment, database
//! tunnels, run targets, SSH sessions), so the host keys it trusts and the passwords it is
//! given belong to the server's [`ide_ssh::SshManager`], not the desktop's.
use crate::rpc::Dispatcher;
use ide_core::remote_settings::SshConfiguration;

pub(crate) fn register(d: &mut Dispatcher) {
    d.add("ssh_test", |c| async move {
        let (config, secret) = (c.arg::<SshConfiguration>("config")?, c.arg::<Option<String>>("secret")?);
        c.host.ssh.test(&config, secret).await
    });
    d.add("ssh_set_secret", |c| async move {
        let (id, secret, save) = (c.arg::<String>("id")?, c.arg::<Option<String>>("secret")?, c.arg::<bool>("save")?);
        c.host.ssh.set_secret(&id, secret, save);
        Ok(())
    });
    d.add("ssh_password_saved", |c| async move { Ok(c.host.ssh.password_saved(&c.arg::<String>("key")?)) });
    d.add("ssh_needs_secret", |c| async move {
        let ssh = &c.host.ssh;
        Ok(ssh.needs_secret(&ssh.config(&c.arg::<String>("id")?)?))
    });
    d.add("ssh_trust_host", |c| async move { c.host.ssh.trust_host(&c.arg::<String>("id")?).await });
    d.add("ssh_connected", |c| async move { Ok(c.host.ssh.connected()) });
    d.add("ssh_disconnect", |c| async move {
        c.host.ssh.disconnect(&c.arg::<String>("id")?);
        Ok(())
    });
}
