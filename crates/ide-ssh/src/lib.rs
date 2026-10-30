//! SSH for every remote feature: configurations and `~/.ssh/config` hosts,
//! host-key trust, authentication (password, key, agent), remote commands and
//! processes, SFTP, local port forwarding, and askpass for `ssh` / `git`.

pub mod askpass;
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

pub use manager::SshManager;
pub use russh::Sig;
pub use session::{ConnectError, ExecOutput, Output, RemoteProcess, Session, UnknownHostKey};
pub use sftp::{RemoteEntry, RemoteFs};
pub use target::{SshFiles, SshTarget, expand, openssh_args};
pub use tunnel::Tunnel;
