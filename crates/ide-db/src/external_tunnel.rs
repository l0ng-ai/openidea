//! An approved foreground helper behind a loopback relay owned by the IDE.

use crate::DbExternalTunnel;
use ide_core::{IdeError, IdeResult, error::ErrorKind, process};
use parking_lot::Mutex;
use std::io;
use std::net::{IpAddr, Ipv4Addr, SocketAddr, SocketAddrV4};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Weak};
use std::time::Duration;
use tokio::net::{TcpListener, TcpSocket, TcpStream};
use tokio::sync::Semaphore;
use tokio::task::{JoinHandle, JoinSet};

#[cfg(target_os = "linux")]
#[path = "external_tunnel/linux.rs"]
mod platform;
#[cfg(target_os = "macos")]
#[path = "external_tunnel/macos.rs"]
mod platform;
#[cfg(windows)]
#[path = "external_tunnel/windows.rs"]
mod platform;

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
mod platform {
    use super::*;

    pub(super) async fn owns_socket(_: &Arc<Helper>, _: SocketAddr, _: Option<SocketAddr>) -> io::Result<bool> {
        Err(io::Error::new(io::ErrorKind::Unsupported, "socket ownership cannot be verified on this OS"))
    }
}

const STARTUP_TIMEOUT: Duration = Duration::from_secs(30);
const CONNECTION_TIMEOUT: Duration = Duration::from_secs(3);
const POLL_INTERVAL: Duration = Duration::from_millis(100);
const MAX_CONNECTIONS: usize = 128;
static VERIFICATION_SLOTS: Semaphore = Semaphore::const_new(8);
static HELPERS: Mutex<ActiveHelpers> = Mutex::new(ActiveHelpers { stopping: false, children: Vec::new() });

struct ActiveHelpers {
    stopping: bool,
    children: Vec<Weak<Helper>>,
}

/// Stop the IDE's external TCP tunnel processes before desktop exit or restart.
pub fn stop_external_tunnels_on_exit() {
    let children = {
        let mut active = HELPERS.lock();
        active.stopping = true;
        std::mem::take(&mut active.children)
    };
    for helper in children.into_iter().filter_map(|child| child.upgrade()) {
        helper.stop();
    }
}

pub(super) struct ExternalTunnel {
    port: u16,
    // Keep the address reserved even after the helper exits, until the last route reference drops.
    _listener: Arc<TcpListener>,
    helper: Weak<Helper>,
    task: JoinHandle<()>,
}

impl ExternalTunnel {
    pub(super) fn validate(config: &DbExternalTunnel, target: (&str, u16)) -> IdeResult<()> {
        helper_target(config, target).map(|_| ())
    }

    pub(super) async fn open(config: &DbExternalTunnel, target: (&str, u16)) -> IdeResult<Self> {
        if !cfg!(any(target_os = "linux", target_os = "macos", windows)) {
            return Err(IdeError::unavailable("External TCP tunnel socket ownership cannot be verified on this OS"));
        }
        let listener = Arc::new(loopback_socket()?.listen(128)?);
        let port = listener.local_addr()?.port();
        let reservation = loopback_socket()?;
        let endpoint = reservation.local_addr()?;
        let arguments = helper_arguments(config, target, endpoint.port())?;
        drop(reservation);
        let helper = launch_helper(Path::new(&config.executable), &arguments)?;

        let ready = tokio::time::timeout(STARTUP_TIMEOUT, async {
            loop {
                if !helper.is_alive() {
                    return Err(IdeError::new(
                        ErrorKind::Io,
                        "The external TCP tunnel helper exited before opening its loopback listener. \
                         Check the helper command in a terminal.",
                    ));
                }
                if verify_socket(&helper, endpoint, None).await.map_err(|error| {
                    IdeError::new(ErrorKind::Io, format!("Could not verify the external TCP tunnel listener: {error}"))
                })? {
                    return Ok(());
                }
                tokio::time::sleep(POLL_INTERVAL).await;
            }
        })
        .await;
        ready.map_err(|_| {
            IdeError::new(
                ErrorKind::Io,
                format!(
                    "The external TCP tunnel helper did not open an owned listener at {endpoint} before the startup timeout. \
                     Check that the command binds to 127.0.0.1 and uses {{localPort}}."
                ),
            )
        })??;

        let watched_helper = Arc::downgrade(&helper);
        let task = tokio::spawn(relay(Arc::clone(&listener), endpoint, helper));
        Ok(Self { port, _listener: listener, helper: watched_helper, task })
    }

    pub(super) fn port(&self) -> u16 {
        self.port
    }

    pub(super) fn is_closed(&self) -> bool {
        self.task.is_finished() || self.helper.upgrade().is_none_or(|helper| !helper.is_alive())
    }
}

impl Drop for ExternalTunnel {
    fn drop(&mut self) {
        self.task.abort();
    }
}

fn loopback_socket() -> io::Result<TcpSocket> {
    let socket = TcpSocket::new_v4()?;
    #[cfg(windows)]
    platform::make_exclusive(&socket)?;
    socket.bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0).into())?;
    Ok(socket)
}

fn helper_target<'a>(config: &DbExternalTunnel, (host, port): (&'a str, u16)) -> IdeResult<(&'a str, u16)> {
    let executable = Path::new(&config.executable);
    if !executable.is_absolute() || executable.file_name().is_none() || config.executable.contains('\0') {
        return Err(IdeError::invalid("Choose an absolute path to the external TCP tunnel executable"));
    }
    #[cfg(windows)]
    if !executable.extension().is_some_and(|extension| extension.eq_ignore_ascii_case("exe")) {
        return Err(IdeError::invalid("Choose an .exe file for the external TCP tunnel"));
    }
    let host = host.trim();
    let host = host
        .strip_prefix('[')
        .and_then(|host| host.strip_suffix(']'))
        .filter(|host| host.parse::<std::net::Ipv6Addr>().is_ok())
        .unwrap_or(host);
    let dns = host.strip_suffix('.').unwrap_or(host);
    if host.parse::<IpAddr>().is_err()
        && (dns.len() > 253
            || !dns.split('.').all(|label| {
                let bytes = label.as_bytes();
                bytes.len() <= 63
                    && bytes.first().is_some_and(u8::is_ascii_alphanumeric)
                    && bytes.last().is_some_and(u8::is_ascii_alphanumeric)
                    && bytes.iter().all(|byte| byte.is_ascii_alphanumeric() || *byte == b'-')
            }))
    {
        return Err(IdeError::invalid("Enter a DNS name or IP address for the external TCP tunnel"));
    }
    if port == 0 {
        return Err(IdeError::invalid("Enter a valid destination port for the external TCP tunnel"));
    }
    if !config.arguments.iter().any(|arg| arg.contains("{localPort}")) {
        return Err(IdeError::invalid("Include {localPort} in the external TCP tunnel arguments"));
    }
    if config.arguments.iter().any(|arg| arg.contains('\0')) {
        return Err(IdeError::invalid("External TCP tunnel arguments cannot contain NUL characters"));
    }
    Ok((host, port))
}

fn helper_arguments(config: &DbExternalTunnel, target: (&str, u16), local_port: u16) -> IdeResult<Vec<String>> {
    let (host, port) = helper_target(config, target)?;
    let target = if host.contains(':') { format!("[{host}]:{port}") } else { format!("{host}:{port}") };
    let (local_port, port) = (local_port.to_string(), port.to_string());
    let placeholders =
        [("{host}:{port}", target.as_str()), ("{localPort}", &local_port), ("{host}", host), ("{port}", &port)];
    Ok(config
        .arguments
        .iter()
        .map(|arg| {
            let mut remaining = arg.as_str();
            let mut expanded = String::with_capacity(arg.len());
            while let Some(start) = remaining.find('{') {
                expanded.push_str(&remaining[..start]);
                remaining = &remaining[start..];
                if let Some((value, tail)) = placeholders
                    .into_iter()
                    .find_map(|(key, value)| remaining.strip_prefix(key).map(|tail| (value, tail)))
                {
                    expanded.push_str(value);
                    remaining = tail;
                } else {
                    expanded.push('{');
                    remaining = &remaining[1..];
                }
            }
            expanded.push_str(remaining);
            expanded
        })
        .collect())
}

fn launch_helper(executable: &Path, arguments: &[String]) -> IdeResult<Arc<Helper>> {
    let mut active = HELPERS.lock();
    if active.stopping {
        return Err(IdeError::cancelled());
    }
    let helper = Arc::new(Helper::spawn(executable, arguments).map_err(|error| {
        IdeError::new(ErrorKind::Io, format!("Could not start the external TCP tunnel helper: {error}"))
    })?);
    active.children.retain(|child| child.strong_count() > 0);
    active.children.push(Arc::downgrade(&helper));
    Ok(helper)
}

struct Helper {
    child: Option<Child>,
    #[cfg(windows)]
    job: process::Job,
}

impl Helper {
    fn spawn(executable: &Path, arguments: &[String]) -> io::Result<Self> {
        let mut command = Command::new(executable);
        command
            .args(arguments)
            .current_dir(executable.parent().expect("validated absolute executable path"))
            .env_clear()
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        // Keep user config discovery available without inheriting database or project variables.
        for key in [
            "PATH",
            "HOME",
            "XDG_CONFIG_HOME",
            "XDG_CACHE_HOME",
            "XDG_DATA_HOME",
            "XDG_RUNTIME_DIR",
            "USERPROFILE",
            "APPDATA",
            "LOCALAPPDATA",
            "SYSTEMROOT",
            "WINDIR",
            "TMPDIR",
            "TEMP",
            "TMP",
            "SSH_AUTH_SOCK",
            "NO_PROXY",
            "no_proxy",
        ] {
            if let Some(value) = process::host_var_os(key) {
                command.env(key, value);
            }
        }
        for key in ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"] {
            if let Some(value) = process::host_var_os(key)
                && value.to_str().is_some_and(credential_free_proxy)
            {
                command.env(key, value);
            }
        }
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            // Membership of this group is an authorization check. A separate session limits
            // membership to this child and its descendants; the leader also owns the group.
            // SAFETY: setsid is async-signal-safe and does not access Rust state after fork.
            unsafe {
                command.pre_exec(|| if libc::setsid() == -1 { Err(io::Error::last_os_error()) } else { Ok(()) });
            }
        }
        #[cfg(windows)]
        {
            platform::spawn_suspended(command)
        }
        #[cfg(not(windows))]
        {
            Ok(Self { child: Some(command.spawn()?) })
        }
    }

    fn child(&self) -> &Child {
        self.child.as_ref().expect("the live helper owns its child handle")
    }

    #[cfg(unix)]
    fn pid(&self) -> u32 {
        self.child().id()
    }

    fn is_alive(&self) -> bool {
        #[cfg(unix)]
        {
            loop {
                let mut info = std::mem::MaybeUninit::<libc::siginfo_t>::zeroed();
                // Keep the group leader unreaped so its id cannot be reused before group cleanup.
                // SAFETY: valid output buffer and the id of the child owned by `self`.
                let result = unsafe {
                    libc::waitid(
                        libc::P_PID,
                        self.pid(),
                        info.as_mut_ptr(),
                        libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
                    )
                };
                if result == 0 {
                    // SAFETY: the buffer was zeroed and waitid returned successfully.
                    return unsafe { info.assume_init().si_pid() == 0 };
                }
                if io::Error::last_os_error().kind() != io::ErrorKind::Interrupted {
                    return false;
                }
            }
        }
        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawHandle;
            use windows_sys::Win32::Foundation::WAIT_TIMEOUT;
            use windows_sys::Win32::System::Threading::WaitForSingleObject;
            // SAFETY: the owned child handle stays open through this non-blocking check.
            unsafe { WaitForSingleObject(self.child().as_raw_handle(), 0) == WAIT_TIMEOUT }
        }
        #[cfg(not(any(unix, windows)))]
        {
            false
        }
    }

    fn stop(&self) {
        #[cfg(windows)]
        let _ = self.job.terminate();
        #[cfg(unix)]
        process::kill_tree_of(self.pid());
    }
}

fn credential_free_proxy(value: &str) -> bool {
    let url = if value.contains("://") {
        reqwest::Url::parse(value)
    } else {
        reqwest::Url::parse(&format!("http://{value}"))
    };
    url.is_ok_and(|url| {
        matches!(url.scheme(), "http" | "https" | "socks4" | "socks4a" | "socks5" | "socks5h")
            && url.host().is_some()
            && url.username().is_empty()
            && url.password().is_none()
            && matches!(url.path(), "" | "/")
            && url.query().is_none()
            && url.fragment().is_none()
    })
}

impl Drop for Helper {
    fn drop(&mut self) {
        self.stop();
        #[cfg(unix)]
        if let Some(mut child) = self.child.take() {
            // A helper blocked in the kernel must not hold up the async caller during cleanup.
            if !matches!(child.try_wait(), Ok(Some(_))) {
                let _ = std::thread::Builder::new().spawn(move || child.wait());
            }
        }
    }
}

async fn relay(listener: Arc<TcpListener>, endpoint: SocketAddr, helper: Arc<Helper>) {
    let mut connections = JoinSet::new();
    let mut liveness = tokio::time::interval(Duration::from_secs(1));
    liveness.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            _ = liveness.tick() => {
                if !helper.is_alive() { break; }
            }
            accepted = listener.accept(), if connections.len() < MAX_CONNECTIONS => {
                let Ok((mut client, _)) = accepted else {
                    // Transient errors such as descriptor exhaustion affect new sockets only.
                    tokio::time::sleep(POLL_INTERVAL).await;
                    continue;
                };
                let helper = Arc::clone(&helper);
                connections.spawn(async move {
                    if let Ok(Ok(mut upstream)) = tokio::time::timeout(CONNECTION_TIMEOUT, connect_verified(&helper, endpoint)).await {
                        let _ = tokio::io::copy_bidirectional(&mut client, &mut upstream).await;
                        true
                    } else {
                        false
                    }
                });
            }
            finished = connections.join_next(), if !connections.is_empty() => {
                if matches!(finished, Some(Ok(false)))
                    // A slow ownership probe must not interrupt already verified connections.
                    && matches!(tokio::time::timeout(CONNECTION_TIMEOUT, verify_socket(&helper, endpoint, None)).await, Ok(Ok(false)))
                {
                    break;
                }
            }
        }
    }
}

async fn connect_verified(helper: &Arc<Helper>, endpoint: SocketAddr) -> io::Result<TcpStream> {
    let upstream = TcpStream::connect(endpoint).await?;
    let peer = upstream.local_addr()?;
    // TCP connect can complete before the helper accepts. Check the server's half of this
    // exact connection, keeping all client bytes in the IDE until that socket has an owner.
    loop {
        if !helper.is_alive() {
            return Err(io::Error::new(io::ErrorKind::BrokenPipe, "external TCP tunnel helper exited"));
        }
        if verify_socket(helper, endpoint, Some(peer)).await? && helper.is_alive() {
            return Ok(upstream);
        }
        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

async fn verify_socket(helper: &Arc<Helper>, local: SocketAddr, peer: Option<SocketAddr>) -> io::Result<bool> {
    let _slot = VERIFICATION_SLOTS.acquire().await.map_err(io::Error::other)?;
    platform::owns_socket(helper, local, peer).await
}

#[cfg(all(test, any(target_os = "linux", target_os = "macos", windows)))]
mod tests;
