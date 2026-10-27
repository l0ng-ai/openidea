//! An authenticated SSH connection (russh), optionally through `ProxyJump`
//! hosts, and what runs over it: commands, processes, SFTP and TCP channels.
//!
//! Host keys are checked against `known_hosts`; an unknown key fails the
//! connection with [`ConnectError::UnknownHostKey`] so the UI can ask the user,
//! and a changed key is always refused.

use crate::target::{Hop, SshFiles, SshTarget, expand, home, resolve_hops};
use ide_core::remote_settings::SshAuth;
use ide_core::{IdeError, IdeResult, error::ErrorKind};
use parking_lot::Mutex;
use russh::client::{self, Handle, Msg};
use russh::keys::{self, HashAlg, PrivateKeyWithHashAlg, PublicKey, PublicKeyOrCertificate, known_hosts};
use russh::{ChannelMsg, ChannelStream, ChannelWriteHalf, Sig};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::oneshot;

/// Generous: a relayed VPN path (e.g. Tailscale via DERP) can take ~1 s per round trip.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(45);
const DEFAULT_IDENTITIES: [&str; 3] = ["id_ed25519", "id_ecdsa", "id_rsa"];

/// A host key the user has not trusted yet.
#[derive(Debug, Clone)]
pub struct UnknownHostKey {
    pub host: String,
    pub port: u16,
    pub key: PublicKey,
}

impl UnknownHostKey {
    /// `ED25519 SHA256:…`, as OpenSSH prints it.
    pub fn fingerprint(&self) -> String {
        format!("{} {}", self.key.algorithm().as_str(), self.key.fingerprint(HashAlg::Sha256))
    }

    /// Records the key in `known_hosts` (blocking).
    pub fn trust(&self, known_hosts: &Path) -> IdeResult<()> {
        if let Some(dir) = known_hosts.parent() {
            std::fs::create_dir_all(dir)?;
        }
        known_hosts::learn_known_hosts_path(&self.host, self.port, &self.key, known_hosts)
            .map_err(|e| IdeError::new(ErrorKind::Io, format!("cannot update {}: {e}", known_hosts.display())))
    }

    /// The error shown for it; the UI recognises the `Unknown SSH host key` prefix.
    pub fn error(&self) -> IdeError {
        IdeError::new(
            ErrorKind::Protocol,
            format!("Unknown SSH host key for {}:{} ({})", self.host, self.port, self.fingerprint()),
        )
    }
}

#[derive(Debug)]
pub enum ConnectError {
    UnknownHostKey(Box<UnknownHostKey>),
    Other(IdeError),
}

impl From<IdeError> for ConnectError {
    fn from(e: IdeError) -> Self {
        ConnectError::Other(e)
    }
}

impl From<ConnectError> for IdeError {
    fn from(e: ConnectError) -> Self {
        match e {
            ConnectError::UnknownHostKey(k) => k.error(),
            ConnectError::Other(e) => e,
        }
    }
}

/// Output of a finished remote command.
#[derive(Debug, Clone, Default)]
pub struct ExecOutput {
    /// `None` when the server reported no status (killed by a signal).
    pub code: Option<u32>,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

impl ExecOutput {
    pub fn success(&self) -> bool {
        self.code == Some(0)
    }

    pub fn stdout_str(&self) -> String {
        String::from_utf8_lossy(&self.stdout).into_owned()
    }

    /// stdout on success, else an error with stderr.
    pub fn into_stdout(self, what: &str) -> IdeResult<String> {
        if self.success() {
            return Ok(self.stdout_str());
        }
        let err = String::from_utf8_lossy(&self.stderr).trim().to_owned();
        let code = self.code.map_or_else(|| "killed".to_owned(), |c| format!("exit code {c}"));
        Err(io(if err.is_empty() { format!("{what} failed ({code})") } else { format!("{what} failed: {err}") }))
    }
}

/// An open SSH connection; dropping it closes the sessions.
pub struct Session {
    handle: Handle<Client>,
    /// Sessions of the `ProxyJump` hosts, kept alive under `handle`.
    _jumps: Vec<Handle<Client>>,
    label: String,
}

impl Session {
    /// Connects and authenticates; `secret` is the password or key passphrase.
    pub async fn connect(target: &SshTarget, secret: Option<&str>, files: &SshFiles) -> Result<Session, ConnectError> {
        let host = format!("{}:{}", target.host, target.port.unwrap_or(22));
        match tokio::time::timeout(CONNECT_TIMEOUT, Self::connect_inner(target, secret, files)).await {
            Ok(r) => r,
            Err(_) => {
                Err(io(format!("timed out connecting to the SSH host {host} ({} s)", CONNECT_TIMEOUT.as_secs())).into())
            }
        }
    }

    async fn connect_inner(
        target: &SshTarget,
        secret: Option<&str>,
        files: &SshFiles,
    ) -> Result<Session, ConnectError> {
        let hops = resolve_hops(target, files.config.as_deref())?;
        let mut sessions: Vec<Handle<Client>> = Vec::new();
        for (i, hop) in hops.iter().enumerate() {
            let last = i == hops.len() - 1;
            let mut handle = match sessions.last() {
                None => connect::<tokio::net::TcpStream>(hop, &files.known_hosts, None).await?,
                Some(prev) => {
                    let channel = prev
                        .channel_open_direct_tcpip(hop.host.as_str(), u32::from(hop.port), "127.0.0.1", 0)
                        .await
                        .map_err(|e| io(format!("cannot reach {} through the jump host: {e}", hop.label())))?;
                    connect(hop, &files.known_hosts, Some(channel.into_stream())).await?
                }
            };
            // Jump hosts always use the agent / identity files; the secret belongs to the target.
            let mode = if last { target.auth } else { SshAuth::OpenSsh };
            authenticate(&mut handle, hop, mode, &target.key_file, secret).await?;
            sessions.push(handle);
        }
        let handle = sessions.pop().expect("at least one hop");
        let label = hops.last().expect("at least one hop").label();
        Ok(Session { handle, _jumps: sessions, label })
    }

    /// `user@host:port` of the target.
    pub fn label(&self) -> &str {
        &self.label
    }

    /// The connection ended (network loss, server restart).
    pub fn is_closed(&self) -> bool {
        self.handle.is_closed()
    }

    /// A TCP connection to `host:port` as seen from the SSH host.
    pub async fn direct_tcpip(&self, host: &str, port: u16) -> Result<ChannelStream<Msg>, russh::Error> {
        let channel = self.handle.channel_open_direct_tcpip(host, u32::from(port), "127.0.0.1", 0).await?;
        Ok(channel.into_stream())
    }

    /// Starts `command` and returns its stdin / stdout as one byte stream (stderr is dropped).
    pub async fn exec_stream(&self, command: &str) -> Result<ChannelStream<Msg>, russh::Error> {
        let channel = self.handle.channel_open_session().await?;
        channel.exec(true, command).await?;
        Ok(channel.into_stream())
    }

    /// Runs `command` through the remote shell and collects its output.
    pub async fn exec(&self, command: &str, stdin: Option<&[u8]>) -> IdeResult<ExecOutput> {
        let mut channel = self.handle.channel_open_session().await.map_err(|e| self.failed(e))?;
        channel.exec(true, command).await.map_err(|e| self.failed(e))?;
        if let Some(input) = stdin {
            channel.data(input).await.map_err(|e| self.failed(e))?;
        }
        channel.eof().await.map_err(|e| self.failed(e))?;
        let mut out = ExecOutput::default();
        while let Some(msg) = channel.wait().await {
            match msg {
                ChannelMsg::Data { data } => out.stdout.extend_from_slice(&data),
                ChannelMsg::ExtendedData { data, ext: 1 } => out.stderr.extend_from_slice(&data),
                ChannelMsg::ExitStatus { exit_status } => out.code = Some(exit_status),
                _ => {}
            }
        }
        Ok(out)
    }

    /// Starts `command` (through the remote shell), streaming its output.
    /// With `pty` (columns, rows) stdout and stderr arrive merged, as in a terminal.
    pub async fn spawn(
        &self,
        command: &str,
        pty: Option<(u16, u16)>,
        on_output: Box<dyn FnMut(Output<'_>) + Send>,
    ) -> IdeResult<RemoteProcess> {
        let channel = self.handle.channel_open_session().await.map_err(|e| self.failed(e))?;
        if let Some((cols, rows)) = pty {
            channel
                .request_pty(true, "xterm-256color", u32::from(cols), u32::from(rows), 0, 0, &[])
                .await
                .map_err(|e| self.failed(e))?;
        }
        if command.is_empty() {
            channel.request_shell(true).await.map_err(|e| self.failed(e))?;
        } else {
            channel.exec(true, command).await.map_err(|e| self.failed(e))?;
        }
        let (mut read, write) = channel.split();
        let (tx, rx) = oneshot::channel();
        let mut on_output = on_output;
        tokio::spawn(async move {
            let mut code = None;
            while let Some(msg) = read.wait().await {
                match msg {
                    ChannelMsg::Data { data } => on_output(Output::Stdout(&data)),
                    ChannelMsg::ExtendedData { data, ext: 1 } => on_output(Output::Stderr(&data)),
                    ChannelMsg::ExitStatus { exit_status } => code = Some(exit_status),
                    _ => {}
                }
            }
            let _ = tx.send(code);
        });
        Ok(RemoteProcess { write: Arc::new(write), exit: Mutex::new(Some(rx)) })
    }

    /// Writes `data` to `remote` (absolute; its folder is created) through an
    /// exec channel, gzip-compressed. Much faster than SFTP for one big file:
    /// SFTP writes wait for each packet's reply, the channel only for its window.
    pub async fn put(&self, remote: &str, data: &[u8]) -> IdeResult<()> {
        self.put_with_progress(remote, data, &|_| {}).await
    }

    /// [`Self::put`], reporting the fraction sent (0..1) as it goes.
    pub async fn put_with_progress(
        &self,
        remote: &str,
        data: &[u8],
        progress: &(dyn Fn(f64) + Send + Sync),
    ) -> IdeResult<()> {
        use std::io::Write as _;
        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        gz.write_all(data)?;
        let packed = gz.finish()?;
        let q = crate::shell::quote;
        let dir = crate::sftp::parent(remote).unwrap_or("/");
        let command = format!("mkdir -p {} && gzip -dc > {}", q(dir), q(remote));
        let stderr = Arc::new(Mutex::new(Vec::new()));
        let sink = stderr.clone();
        let process = self
            .spawn(
                &command,
                None,
                Box::new(move |out| {
                    if let Output::Stderr(b) = out {
                        sink.lock().extend_from_slice(b);
                    }
                }),
            )
            .await?;
        let mut sent = 0;
        for chunk in packed.chunks(256 * 1024) {
            process.write(chunk).await?;
            sent += chunk.len();
            progress(sent as f64 / packed.len().max(1) as f64);
        }
        process.eof().await?;
        match process.wait().await {
            Some(0) => Ok(()),
            code => {
                let err = String::from_utf8_lossy(&stderr.lock()).trim().to_owned();
                Err(io(format!("cannot write {remote} on {} ({code:?}): {err}", self.label)))
            }
        }
    }

    /// An SFTP session on its own channel.
    pub async fn sftp(&self) -> IdeResult<russh_sftp::client::SftpSession> {
        let channel = self.handle.channel_open_session().await.map_err(|e| self.failed(e))?;
        channel.request_subsystem(true, "sftp").await.map_err(|e| self.failed(e))?;
        russh_sftp::client::SftpSession::new(channel.into_stream())
            .await
            .map_err(|e| io(format!("SFTP is not available on {}: {e}", self.label)))
    }

    fn failed(&self, e: russh::Error) -> IdeError {
        io(format!("SSH {}: {e}", self.label))
    }
}

/// A chunk of a remote process's output.
pub enum Output<'a> {
    Stdout(&'a [u8]),
    Stderr(&'a [u8]),
}

/// A running remote command.
pub struct RemoteProcess {
    write: Arc<ChannelWriteHalf<Msg>>,
    exit: Mutex<Option<oneshot::Receiver<Option<u32>>>>,
}

impl RemoteProcess {
    pub async fn write(&self, data: &[u8]) -> IdeResult<()> {
        self.write.data(data).await.map_err(|e| io(e.to_string()))
    }

    /// Closes stdin.
    pub async fn eof(&self) -> IdeResult<()> {
        self.write.eof().await.map_err(|e| io(e.to_string()))
    }

    pub async fn resize(&self, cols: u16, rows: u16) -> IdeResult<()> {
        self.write.window_change(u32::from(cols), u32::from(rows), 0, 0).await.map_err(|e| io(e.to_string()))
    }

    /// Sends `INT` / `TERM` / `KILL`; servers that ignore signals get the channel closed.
    pub async fn signal(&self, signal: Sig) -> IdeResult<()> {
        let kill = matches!(signal, Sig::KILL);
        let r = self.write.signal(signal).await;
        if kill || r.is_err() {
            let _ = self.write.close().await;
        }
        Ok(())
    }

    /// Waits for the exit status (`None`: killed, or no status reported). Once.
    pub async fn wait(&self) -> Option<u32> {
        let rx = self.exit.lock().take()?;
        rx.await.ok().flatten()
    }
}

fn io(message: impl Into<String>) -> IdeError {
    IdeError::new(ErrorKind::Io, message)
}

// --- connection ----------------------------------------------------------------

#[derive(Debug)]
enum HostKeyIssue {
    Unknown(PublicKey),
    Changed(usize),
}

pub struct Client {
    host: String,
    port: u16,
    known_hosts: PathBuf,
    issue: Arc<Mutex<Option<HostKeyIssue>>>,
}

impl client::Handler for Client {
    type Error = russh::Error;

    async fn check_server_key(&mut self, key: &PublicKeyOrCertificate) -> Result<bool, Self::Error> {
        let key = match key {
            PublicKeyOrCertificate::PublicKey { key, .. } => key.clone(),
            PublicKeyOrCertificate::Certificate(cert) => PublicKey::from(cert.public_key().clone()),
        };
        let issue = match known_hosts::check_known_hosts_path(&self.host, self.port, &key, &self.known_hosts) {
            Ok(true) => return Ok(true),
            Err(keys::Error::KeyChanged { line }) => HostKeyIssue::Changed(line),
            Ok(false) | Err(_) => HostKeyIssue::Unknown(key),
        };
        *self.issue.lock() = Some(issue);
        Ok(false)
    }
}

async fn connect<S>(hop: &Hop, known_hosts: &Path, stream: Option<S>) -> Result<Handle<Client>, ConnectError>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let config = Arc::new(client::Config {
        inactivity_timeout: None,
        keepalive_interval: Some(Duration::from_secs(30)),
        keepalive_max: 3,
        nodelay: true,
        ..Default::default()
    });
    let issue = Arc::new(Mutex::new(None));
    let handler =
        Client { host: hop.host.clone(), port: hop.port, known_hosts: known_hosts.to_owned(), issue: issue.clone() };
    let result = match stream {
        None => client::connect(config, (hop.host.as_str(), hop.port), handler).await,
        Some(s) => client::connect_stream(config, s, handler).await,
    };
    result.map_err(|e| match issue.lock().take() {
        Some(HostKeyIssue::Unknown(key)) => {
            ConnectError::UnknownHostKey(Box::new(UnknownHostKey { host: hop.host.clone(), port: hop.port, key }))
        }
        Some(HostKeyIssue::Changed(line)) => ConnectError::Other(IdeError::new(
            ErrorKind::PermissionDenied,
            format!(
                "SSH host key of {}:{} has changed (known_hosts line {line}); possible man-in-the-middle attack",
                hop.host, hop.port
            ),
        )),
        None => ConnectError::Other(io(format!("cannot connect to SSH host {}:{}: {e}", hop.host, hop.port))),
    })
}

// --- authentication ------------------------------------------------------------

fn denied(message: String) -> IdeError {
    IdeError::new(ErrorKind::PermissionDenied, message)
}

async fn rsa_hash(handle: &Handle<Client>) -> Option<HashAlg> {
    handle.best_supported_rsa_hash().await.ok().flatten().flatten()
}

async fn with_key(handle: &mut Handle<Client>, user: &str, key: keys::PrivateKey) -> IdeResult<bool> {
    let key = PrivateKeyWithHashAlg::new(Arc::new(key), rsa_hash(handle).await);
    let r = handle.authenticate_publickey(user, key).await.map_err(|e| io(e.to_string()))?;
    Ok(r.success())
}

/// Every identity of the running SSH agent, until one is accepted.
async fn with_agent(handle: &mut Handle<Client>, user: &str) -> bool {
    #[cfg(unix)]
    let agent = keys::agent::client::AgentClient::connect_env().await;
    #[cfg(windows)]
    let agent = keys::agent::client::AgentClient::connect_named_pipe(r"\\.\pipe\openssh-ssh-agent").await;
    let Ok(mut agent) = agent else { return false };
    let Ok(identities) = agent.request_identities().await else { return false };
    let hash = rsa_hash(handle).await;
    for id in identities {
        let ok = match id {
            keys::agent::AgentIdentity::PublicKey { key, .. } => {
                handle.authenticate_publickey_with(user, key, hash, &mut agent).await.map(|r| r.success())
            }
            keys::agent::AgentIdentity::Certificate { certificate, .. } => {
                handle.authenticate_certificate_with(user, certificate, hash, &mut agent).await.map(|r| r.success())
            }
        };
        if ok.unwrap_or(false) {
            return true;
        }
    }
    false
}

async fn authenticate(
    handle: &mut Handle<Client>,
    hop: &Hop,
    mode: SshAuth,
    key_file: &str,
    secret: Option<&str>,
) -> IdeResult<()> {
    let user = hop.user.as_str();
    let failed = || denied(format!("SSH authentication failed for {}", hop.label()));
    match mode {
        SshAuth::Password => {
            let Some(password) = secret else {
                return Err(denied(format!("SSH password required for {}", hop.label())));
            };
            let r = handle.authenticate_password(user, password).await.map_err(|e| io(e.to_string()))?;
            if r.success() { Ok(()) } else { Err(failed()) }
        }
        SshAuth::KeyPair => {
            if key_file.trim().is_empty() {
                return Err(IdeError::invalid("SSH private key file is not set"));
            }
            let path = expand(key_file.trim());
            let key = load_key(&path, secret)?;
            if with_key(handle, user, key).await? { Ok(()) } else { Err(failed()) }
        }
        SshAuth::OpenSsh => {
            if with_agent(handle, user).await {
                return Ok(());
            }
            let files: Vec<PathBuf> = if hop.identity_files.is_empty() {
                home().map(|h| DEFAULT_IDENTITIES.iter().map(|n| h.join(".ssh").join(n)).collect()).unwrap_or_default()
            } else {
                hop.identity_files.iter().map(|p| expand(&p.to_string_lossy())).collect()
            };
            let mut locked: Option<PathBuf> = None;
            for path in files.iter().filter(|p| p.is_file()) {
                match load_key(path, secret) {
                    Ok(key) => {
                        if with_key(handle, user, key).await? {
                            return Ok(());
                        }
                    }
                    Err(e) if e.kind == ErrorKind::PermissionDenied => locked = locked.or(Some(path.clone())),
                    Err(e) => tracing::warn!("SSH key {}: {}", path.display(), e.message),
                }
            }
            match locked {
                // An encrypted key could not be tried: ask for its passphrase.
                Some(path) if secret.is_none() => {
                    Err(denied(format!("SSH key passphrase required for {}", path.display())))
                }
                _ => Err(failed()),
            }
        }
    }
}

/// Loads a private key; an encrypted key without (or with a wrong) passphrase is `PermissionDenied`.
fn load_key(path: &Path, passphrase: Option<&str>) -> IdeResult<keys::PrivateKey> {
    match keys::load_secret_key(path, passphrase) {
        Ok(k) => Ok(k),
        Err(keys::Error::KeyIsEncrypted) => Err(denied(format!("SSH key passphrase required for {}", path.display()))),
        Err(e) if passphrase.is_some() => {
            Err(denied(format!("cannot decrypt SSH key {} (wrong passphrase?): {e}", path.display())))
        }
        Err(e) => Err(IdeError::invalid(format!("cannot read SSH key {}: {e}", path.display()))),
    }
}
