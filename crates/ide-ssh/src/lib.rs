//! SSH for every remote feature: configurations and `~/.ssh/config` hosts,
//! host-key trust, authentication (password, key, agent), remote commands and
//! processes, SFTP (and FTP for deployment), local port forwarding, and askpass for `ssh` / `git`.

pub mod askpass;
pub mod filesystem;
pub mod ftp;
pub mod git_creds;
pub mod manager;
pub mod secrets;
pub mod session;
pub mod sftp;
pub mod shell;
pub mod target;
#[cfg(feature = "testing")]
pub mod testing;
pub mod tunnel;

pub use filesystem::{FsConnection, RemoteFs};
pub use manager::SshManager;
pub use russh::Sig;
pub use session::{ConnectError, ExecOutput, Output, RemoteProcess, Session, UnknownHostKey};
pub use sftp::RemoteEntry;
pub use target::{SshFiles, SshTarget, expand, openssh_args, resolve_ssh_remote_url, resolve_ssh_remote_url_with};
pub use tunnel::Tunnel;
