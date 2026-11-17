//! Docker connections (which daemon the CLI talks to) and registries, as the
//! Services tool window's "Add Service" menu creates them. Both are app-wide
//! like in IDEA: `docker.json` in the app data directory; registry passwords
//! live beside it in an owner-only `docker-passwords.json`.

use ide_core::{IdeError, IdeResult};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;

/// Which daemon a docker command talks to.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum DockerEndpoint {
    /// Whatever the CLI is configured for (`DOCKER_HOST`, the current context).
    #[default]
    Default,
    /// A local daemon socket, e.g. `/var/run/docker.sock` (or a `npipe://` URL on Windows).
    Socket { path: String },
    /// A remote daemon, e.g. `tcp://build:2376` or `ssh://me@build`; with TLS when
    /// `tls_cert_dir` holds `ca.pem`, `cert.pem` and `key.pem`.
    Tcp { host: String, tls_cert_dir: Option<String> },
    /// A named `docker context`.
    Context { name: String },
}

impl DockerEndpoint {
    /// Global CLI options selecting this endpoint (before the subcommand).
    pub fn global_args(&self) -> Vec<String> {
        match self {
            Self::Default => Vec::new(),
            Self::Socket { path } => {
                let path = path.trim();
                let url = if path.contains("://") { path.to_owned() } else { format!("unix://{path}") };
                vec!["--host".into(), url]
            }
            Self::Tcp { host, tls_cert_dir } => {
                let host = host.trim();
                let url = if host.contains("://") { host.to_owned() } else { format!("tcp://{host}") };
                let mut args = vec!["--host".into(), url];
                if let Some(dir) = tls_cert_dir.as_deref().map(str::trim).filter(|d| !d.is_empty()) {
                    let file = |name: &str| Path::new(dir).join(name).to_string_lossy().into_owned();
                    args.extend([
                        "--tlsverify".into(),
                        "--tlscacert".into(),
                        file("ca.pem"),
                        "--tlscert".into(),
                        file("cert.pem"),
                        "--tlskey".into(),
                        file("key.pem"),
                    ]);
                }
                args
            }
            Self::Context { name } => vec!["--context".into(), name.trim().to_owned()],
        }
    }

    /// Adds the global options to `cmd`; an explicit endpoint also drops the
    /// inherited `DOCKER_HOST` / `DOCKER_CONTEXT`, which would conflict.
    pub(crate) fn apply(&self, cmd: &mut Command) {
        if *self != Self::Default {
            cmd.env_remove("DOCKER_HOST").env_remove("DOCKER_CONTEXT").env_remove("DOCKER_TLS_VERIFY");
        }
        cmd.args(self.global_args());
    }

    /// The same selection as environment variables, for docker command lines run by
    /// others (run configurations). An empty value clears an inherited variable: the
    /// CLI treats `DOCKER_HOST=""` as unset.
    pub fn env_vars(&self) -> BTreeMap<String, String> {
        let mut env = BTreeMap::new();
        let mut set = |k: &str, v: String| {
            env.insert(k.to_owned(), v);
        };
        match self {
            Self::Default => {}
            Self::Socket { path } => {
                let path = path.trim();
                set("DOCKER_HOST", if path.contains("://") { path.to_owned() } else { format!("unix://{path}") });
                set("DOCKER_CONTEXT", String::new());
                set("DOCKER_TLS_VERIFY", String::new());
            }
            Self::Tcp { host, tls_cert_dir } => {
                let host = host.trim();
                set("DOCKER_HOST", if host.contains("://") { host.to_owned() } else { format!("tcp://{host}") });
                set("DOCKER_CONTEXT", String::new());
                match tls_cert_dir.as_deref().map(str::trim).filter(|d| !d.is_empty()) {
                    // `DOCKER_CERT_PATH` holds `ca.pem`, `cert.pem` and `key.pem`, as `global_args` expects.
                    Some(dir) => {
                        set("DOCKER_TLS_VERIFY", "1".into());
                        set("DOCKER_CERT_PATH", dir.to_owned());
                    }
                    None => set("DOCKER_TLS_VERIFY", String::new()),
                }
            }
            Self::Context { name } => {
                set("DOCKER_CONTEXT", name.trim().to_owned());
                set("DOCKER_HOST", String::new());
                set("DOCKER_TLS_VERIFY", String::new());
            }
        }
        env
    }

    pub fn validate(&self) -> IdeResult<()> {
        let empty = match self {
            Self::Default => false,
            Self::Socket { path } => path.trim().is_empty(),
            Self::Tcp { host, .. } => host.trim().is_empty(),
            Self::Context { name } => name.trim().is_empty() || name.trim().starts_with('-'),
        };
        if empty { Err(IdeError::invalid("the Docker connection needs a socket, host or context")) } else { Ok(()) }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DockerConnection {
    pub id: String,
    pub name: String,
    pub endpoint: DockerEndpoint,
}

/// A registry to log in to (Docker Hub, GHCR, a private one). The password is stored separately.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DockerRegistry {
    pub id: String,
    pub name: String,
    /// `docker.io`, `ghcr.io`, `registry.example.com:5000`.
    pub address: String,
    #[serde(default)]
    pub username: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DockerSettings {
    #[serde(default)]
    pub connections: Vec<DockerConnection>,
    #[serde(default)]
    pub registries: Vec<DockerRegistry>,
}

/// Whether `c` is the connection older versions injected when nothing was configured:
/// Services lists only connections the user added, so this one is dropped on load.
fn is_injected_default(c: &DockerConnection) -> bool {
    c.id == "default" && c.name == "Docker" && c.endpoint == DockerEndpoint::Default
}

const SETTINGS_FILE: &str = "docker.json";
const PASSWORDS_FILE: &str = "docker-passwords.json";

pub fn load_settings(data_dir: &Path) -> DockerSettings {
    match std::fs::read(data_dir.join(SETTINGS_FILE)) {
        // A file written before the opt-in Services rework carries the injected default
        // (saved along with a registry or another connection); drop it unless edited.
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map(|mut s: DockerSettings| {
                s.connections.retain(|c| !is_injected_default(c));
                s
            })
            .unwrap_or_else(|e| {
                tracing::warn!("{SETTINGS_FILE}: {e}");
                DockerSettings::default()
            }),
        Err(_) => DockerSettings::default(),
    }
}

pub fn save_settings(data_dir: &Path, settings: &DockerSettings) -> IdeResult<()> {
    for c in &settings.connections {
        if c.id.is_empty() || c.name.trim().is_empty() {
            return Err(IdeError::invalid("every Docker connection needs a name"));
        }
        c.endpoint.validate()?;
    }
    for r in &settings.registries {
        if r.id.is_empty() || r.address.trim().is_empty() {
            return Err(IdeError::invalid("every Docker registry needs an address"));
        }
    }
    let bytes = serde_json::to_vec_pretty(settings).map_err(|e| IdeError::internal(e.to_string()))?;
    write_file(&data_dir.join(SETTINGS_FILE), &bytes, false)?;
    // Forget passwords of registries that are gone.
    let mut passwords = read_passwords(data_dir);
    let before = passwords.len();
    passwords.retain(|id, _| settings.registries.iter().any(|r| &r.id == id));
    if passwords.len() != before { write_passwords(data_dir, &passwords) } else { Ok(()) }
}

fn read_passwords(data_dir: &Path) -> BTreeMap<String, String> {
    std::fs::read(data_dir.join(PASSWORDS_FILE)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

fn write_passwords(data_dir: &Path, all: &BTreeMap<String, String>) -> IdeResult<()> {
    let bytes = serde_json::to_vec_pretty(all).map_err(|e| IdeError::internal(e.to_string()))?;
    write_file(&data_dir.join(PASSWORDS_FILE), &bytes, true)
}

pub fn registry_password(data_dir: &Path, id: &str) -> Option<String> {
    read_passwords(data_dir).remove(id)
}

/// Saves (or with `None` forgets) the password of registry `id`.
pub fn set_registry_password(data_dir: &Path, id: &str, password: Option<&str>) -> IdeResult<()> {
    let mut all = read_passwords(data_dir);
    match password {
        Some(p) => all.insert(id.to_owned(), p.to_owned()),
        None => all.remove(id),
    };
    write_passwords(data_dir, &all)
}

fn write_file(path: &Path, bytes: &[u8], private: bool) -> IdeResult<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("json.tmp");
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    if private {
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    }
    #[cfg(not(unix))]
    let _ = private;
    std::io::Write::write_all(&mut options.open(&tmp)?, bytes)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

/// Canonical registry host: no scheme or path; Docker Hub's aliases become `docker.io`.
pub fn registry_host(address: &str) -> String {
    let a = address.trim();
    let a = a.split_once("://").map_or(a, |(_, rest)| rest);
    let host = a.split('/').next().unwrap_or_default().to_ascii_lowercase();
    match host.as_str() {
        "index.docker.io" | "registry-1.docker.io" | "registry.hub.docker.com" | "hub.docker.com" => "docker.io".into(),
        _ => host,
    }
}

/// Registry host an image reference pulls from (`postgres:16` → `docker.io`).
pub fn reference_registry(reference: &str) -> String {
    match reference.split_once('/') {
        Some((first, _)) if first.contains('.') || first.contains(':') || first == "localhost" => registry_host(first),
        _ => "docker.io".into(),
    }
}

/// Credentials for a `docker login`.
#[derive(Clone, Debug)]
pub struct RegistryAuth {
    pub address: String,
    pub username: String,
    pub password: String,
}

/// The saved registry (with a password) matching `reference`, if any.
pub fn auth_for(data_dir: &Path, reference: &str) -> Option<RegistryAuth> {
    let host = reference_registry(reference);
    let settings = load_settings(data_dir);
    let registry =
        settings.registries.into_iter().find(|r| registry_host(&r.address) == host && !r.username.is_empty())?;
    let password = registry_password(data_dir, &registry.id)?;
    Some(RegistryAuth { address: registry.address, username: registry.username, password })
}

/// A throwaway docker config directory: logins happen there, never in the user's
/// `~/.docker/config.json`. Contexts are copied so a context endpoint still resolves.
pub(crate) struct TempConfig {
    pub dir: PathBuf,
}

impl TempConfig {
    pub fn new() -> IdeResult<Self> {
        let nanos =
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("openidea-docker-{}-{nanos}", std::process::id()));
        std::fs::create_dir_all(&dir)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
        }
        if let Some(contexts) = user_config_dir().map(|d| d.join("contexts")).filter(|d| d.is_dir()) {
            let _ = copy_dir(&contexts, &dir.join("contexts"));
        }
        Ok(Self { dir })
    }
}

impl Drop for TempConfig {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn user_config_dir() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("DOCKER_CONFIG") {
        return Some(PathBuf::from(dir));
    }
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })?;
    Some(PathBuf::from(home).join(".docker"))
}

fn copy_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for e in std::fs::read_dir(from)?.flatten() {
        let target = to.join(e.file_name());
        if e.file_type()?.is_dir() {
            copy_dir(&e.path(), &target)?;
        } else {
            std::fs::copy(e.path(), target)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoint_args() {
        assert!(DockerEndpoint::Default.global_args().is_empty());
        assert_eq!(
            DockerEndpoint::Socket { path: "/var/run/docker.sock".into() }.global_args(),
            ["--host", "unix:///var/run/docker.sock"]
        );
        let tls = DockerEndpoint::Tcp { host: "build:2376".into(), tls_cert_dir: Some("/certs".into()) }.global_args();
        assert_eq!(tls[..3], ["--host", "tcp://build:2376", "--tlsverify"]);
        assert!(tls.contains(&Path::new("/certs").join("key.pem").to_string_lossy().into_owned()));
        assert_eq!(
            DockerEndpoint::Tcp { host: "ssh://me@box".into(), tls_cert_dir: Some(" ".into()) }.global_args(),
            ["--host", "ssh://me@box"]
        );
        assert_eq!(DockerEndpoint::Context { name: "orbstack".into() }.global_args(), ["--context", "orbstack"]);
        assert!(DockerEndpoint::Context { name: "--x".into() }.validate().is_err());
    }

    #[test]
    fn endpoint_env() {
        assert!(DockerEndpoint::Default.env_vars().is_empty());
        let socket = DockerEndpoint::Socket { path: "/var/run/docker.sock".into() }.env_vars();
        assert_eq!(socket["DOCKER_HOST"], "unix:///var/run/docker.sock");
        assert_eq!(socket["DOCKER_CONTEXT"], "");
        let tls = DockerEndpoint::Tcp { host: "build:2376".into(), tls_cert_dir: Some("/certs".into()) }.env_vars();
        assert_eq!(
            (tls["DOCKER_HOST"].as_str(), tls["DOCKER_TLS_VERIFY"].as_str(), tls["DOCKER_CERT_PATH"].as_str()),
            ("tcp://build:2376", "1", "/certs")
        );
        let ssh = DockerEndpoint::Tcp { host: "ssh://me@box".into(), tls_cert_dir: None }.env_vars();
        assert_eq!((ssh["DOCKER_HOST"].as_str(), ssh["DOCKER_TLS_VERIFY"].as_str()), ("ssh://me@box", ""));
        assert!(!ssh.contains_key("DOCKER_CERT_PATH"));
        let ctx = DockerEndpoint::Context { name: " orbstack ".into() }.env_vars();
        assert_eq!((ctx["DOCKER_CONTEXT"].as_str(), ctx["DOCKER_HOST"].as_str()), ("orbstack", ""));
    }

    #[test]
    fn registries_match_references() {
        assert_eq!(reference_registry("postgres:16"), "docker.io");
        assert_eq!(reference_registry("library/postgres"), "docker.io");
        assert_eq!(reference_registry("ghcr.io/org/app:1"), "ghcr.io");
        assert_eq!(reference_registry("localhost:5000/app"), "localhost:5000");
        assert_eq!(registry_host("https://index.docker.io/v1/"), "docker.io");
        assert_eq!(registry_host("GHCR.io"), "ghcr.io");
    }

    #[test]
    fn settings_round_trip_and_passwords() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        // Nothing configured: no connection is invented.
        assert!(load_settings(dir).connections.is_empty());
        let settings = DockerSettings {
            connections: vec![DockerConnection {
                id: "c1".into(),
                name: "Build box".into(),
                endpoint: DockerEndpoint::Tcp { host: "build:2376".into(), tls_cert_dir: None },
            }],
            registries: vec![DockerRegistry {
                id: "r1".into(),
                name: "GHCR".into(),
                address: "ghcr.io".into(),
                username: "me".into(),
            }],
        };
        save_settings(dir, &settings).unwrap();
        assert_eq!(load_settings(dir), settings);
        set_registry_password(dir, "r1", Some("s3cret")).unwrap();
        let auth = auth_for(dir, "ghcr.io/org/app").unwrap();
        assert_eq!((auth.username.as_str(), auth.password.as_str()), ("me", "s3cret"));
        assert!(auth_for(dir, "postgres").is_none());
        save_settings(dir, &DockerSettings { registries: Vec::new(), ..settings }).unwrap();
        assert_eq!(registry_password(dir, "r1"), None);
        // An empty list stays empty.
        save_settings(dir, &DockerSettings { connections: Vec::new(), registries: Vec::new() }).unwrap();
        assert!(load_settings(dir).connections.is_empty());
    }

    #[test]
    fn load_drops_the_injected_default_connection() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        let injected =
            || DockerConnection { id: "default".into(), name: "Docker".into(), endpoint: DockerEndpoint::Default };
        let registry =
            DockerRegistry { id: "r1".into(), name: "GHCR".into(), address: "ghcr.io".into(), username: "me".into() };
        // Saved untouched by an older version (e.g. along with a registry): dropped on load.
        save_settings(dir, &DockerSettings { connections: vec![injected()], registries: vec![registry.clone()] })
            .unwrap();
        let loaded = load_settings(dir);
        assert!(loaded.connections.is_empty());
        assert_eq!(loaded.registries, vec![registry]);
        // A connection the user renamed or re-pointed stays theirs.
        let renamed = DockerConnection { name: "Local engine".into(), ..injected() };
        save_settings(dir, &DockerSettings { connections: vec![renamed.clone()], registries: Vec::new() }).unwrap();
        assert_eq!(load_settings(dir).connections, vec![renamed]);
        let repointed =
            DockerConnection { endpoint: DockerEndpoint::Socket { path: "/var/run/docker.sock".into() }, ..injected() };
        save_settings(dir, &DockerSettings { connections: vec![repointed.clone()], registries: Vec::new() }).unwrap();
        assert_eq!(load_settings(dir).connections, vec![repointed]);
    }
}
