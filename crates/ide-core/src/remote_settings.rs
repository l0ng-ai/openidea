//! Settings of remote work: SSH configurations, SFTP deployment and SSH run
//! targets. The fields hang off `Settings` in `settings.rs`.

use serde::{Deserialize, Serialize};
use specta::Type;

/// How an SSH connection authenticates.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum SshAuth {
    Password,
    /// A private key file, optionally protected by a passphrase.
    KeyPair,
    /// `~/.ssh/config` (HostName, User, Port, IdentityFile, ProxyJump) and the SSH agent.
    #[default]
    OpenSsh,
}

/// Tools › SSH Configurations.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct SshSettings {
    pub configs: Vec<SshConfiguration>,
}

/// A named SSH host, shared by terminals, deployment, run targets and data sources.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct SshConfiguration {
    pub id: String,
    pub name: String,
    /// Host name, or a `Host` alias of `~/.ssh/config` with [`SshAuth::OpenSsh`].
    pub host: String,
    pub port: Option<u16>,
    pub user: String,
    pub auth: SshAuth,
    /// Private key for [`SshAuth::KeyPair`]; `~/` is the home directory.
    pub key_file: String,
    /// Keep the password / key passphrase in the saved passwords.
    pub save_secret: bool,
}

impl SshConfiguration {
    /// `user@host:port` with what is known (the name when the host is empty).
    pub fn label(&self) -> String {
        let host = self.host.trim();
        if host.is_empty() {
            return self.name.clone();
        }
        let mut s = String::new();
        if !self.user.trim().is_empty() {
            s.push_str(self.user.trim());
            s.push('@');
        }
        s.push_str(host);
        if let Some(p) = self.port {
            s.push_str(&format!(":{p}"));
        }
        s
    }
}

/// When local changes are uploaded to the default deployment server.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum AutoUpload {
    #[default]
    Never,
    /// Files saved with Save / Save All (⌘S).
    OnExplicitSave,
    /// Every save, including autosave and external changes.
    Always,
}

/// Build, Execution, Deployment › Deployment (and its Options page).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct DeploymentSettings {
    pub servers: Vec<DeploymentServer>,
    /// Server used by Upload / Download / Sync and automatic upload; empty = none.
    pub default_server: String,
    pub auto_upload: AutoUpload,
    /// Delete remote files when their local file is deleted (automatic upload).
    pub delete_remote: bool,
    /// Keep local modification times on uploaded files.
    pub preserve_timestamps: bool,
    /// File names never uploaded or downloaded (`*` and `?` wildcards; `;`-separated in the UI).
    pub exclude: Vec<String>,
}

impl Default for DeploymentSettings {
    fn default() -> Self {
        Self {
            servers: Vec::new(),
            default_server: String::new(),
            auto_upload: AutoUpload::Never,
            delete_remote: false,
            preserve_timestamps: true,
            exclude: [".git", ".svn", ".hg", ".idea", ".openidea", ".DS_Store", "*.pyc", "__pycache__"]
                .map(String::from)
                .to_vec(),
        }
    }
}

/// An SFTP server and how project folders map onto it.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct DeploymentServer {
    pub id: String,
    pub name: String,
    /// [`SshConfiguration::id`].
    pub ssh_config: String,
    /// Absolute remote folder the mappings are relative to; empty = the login directory.
    pub root_path: String,
    /// Web server URL of the root (Open in Browser on the deployed file).
    pub web_url: String,
    pub mappings: Vec<DeploymentMapping>,
    /// Remote paths (relative to the root) never touched.
    pub excluded_paths: Vec<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct DeploymentMapping {
    /// Project-relative folder; empty = the project root.
    pub local: String,
    /// Remote folder, relative to the server root (a leading `/` is the root too).
    pub deployment: String,
    /// Web path, relative to the server's URL.
    pub web: String,
}

/// Build, Execution, Deployment › Run Targets: run configurations on another machine.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct RunTarget {
    pub id: String,
    pub name: String,
    /// [`SshConfiguration::id`].
    pub ssh_config: String,
    /// Remote folder the project is synchronised to and run from.
    pub project_root: String,
    /// Upload changed project files before each run.
    pub sync_before_run: bool,
    /// Interpreters on the target; empty = the one on the remote `PATH`.
    pub python: String,
    pub node: String,
    pub java: String,
}
