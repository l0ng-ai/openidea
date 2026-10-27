//! App-wide SSH connections, one per SSH configuration, shared by every
//! feature that works on that host (deployment, run targets, data sources).

use crate::secrets::SecretFile;
use crate::session::{ConnectError, Session, UnknownHostKey};
use crate::target::{SshFiles, SshTarget};
use ide_core::remote_settings::{SshAuth, SshConfiguration};
use ide_core::{IdeError, IdeResult};
use parking_lot::{Mutex, RwLock};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

pub struct SshManager {
    files: SshFiles,
    saved: SecretFile,
    /// Secrets entered this session (not saved, or not yet), by configuration id.
    entered: Mutex<HashMap<String, String>>,
    configs: RwLock<Vec<SshConfiguration>>,
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    /// Serialises connecting per configuration so concurrent users share one
    /// session (an unreachable host doesn't hold up the others).
    opening: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    /// Host keys awaiting the user's trust, by key (configuration id or a caller's own).
    unknown: Mutex<HashMap<String, UnknownHostKey>>,
}

impl SshManager {
    /// `secrets` is the file of saved SSH passwords.
    pub fn new(secrets: PathBuf) -> Self {
        Self::with_files(secrets, SshFiles::default())
    }

    pub fn with_files(secrets: PathBuf, files: SshFiles) -> Self {
        Self {
            files,
            saved: SecretFile::new(secrets),
            entered: Mutex::default(),
            configs: RwLock::default(),
            sessions: Mutex::default(),
            opening: Mutex::default(),
            unknown: Mutex::default(),
        }
    }

    pub fn files(&self) -> &SshFiles {
        &self.files
    }

    /// Replaces the configurations (Settings › SSH Configurations); sessions of
    /// changed or removed ones are closed, secrets of removed ones forgotten.
    pub fn set_configs(&self, configs: Vec<SshConfiguration>) {
        let old = std::mem::replace(&mut *self.configs.write(), configs.clone());
        for o in old {
            match configs.iter().find(|c| c.id == o.id) {
                Some(n)
                    if n.host == o.host
                        && n.port == o.port
                        && n.user == o.user
                        && n.auth == o.auth
                        && n.key_file == o.key_file => {}
                Some(_) => {
                    self.sessions.lock().remove(&o.id);
                }
                None => {
                    self.sessions.lock().remove(&o.id);
                    self.entered.lock().remove(&o.id);
                    self.saved.delete(&o.id);
                }
            }
        }
    }

    pub fn configs(&self) -> Vec<SshConfiguration> {
        self.configs.read().clone()
    }

    pub fn config(&self, id: &str) -> IdeResult<SshConfiguration> {
        self.configs
            .read()
            .iter()
            .find(|c| c.id == id)
            .cloned()
            .ok_or_else(|| IdeError::not_found(format!("no SSH configuration {id}")))
    }

    /// Remembers the password / passphrase of configuration `id` for the session,
    /// and in the saved passwords with `save` (`None` forgets it).
    pub fn set_secret(&self, id: &str, secret: Option<String>, save: bool) {
        match &secret {
            Some(s) => {
                self.entered.lock().insert(id.to_owned(), s.clone());
            }
            None => {
                self.entered.lock().remove(id);
            }
        }
        match (secret, save) {
            (Some(s), true) => {
                if let Err(e) = self.saved.set(id, &s) {
                    tracing::warn!("could not save the SSH password: {}", e.message);
                }
            }
            _ => self.saved.delete(id),
        }
    }

    /// The known password / passphrase of configuration `id`.
    pub fn secret(&self, config: &SshConfiguration) -> Option<String> {
        if let Some(s) = self.entered.lock().get(&config.id) {
            return Some(s.clone());
        }
        config.save_secret.then(|| self.saved.get(&config.id)).flatten()
    }

    /// The shared session of configuration `id`, connecting first if needed.
    pub async fn session(&self, id: &str) -> IdeResult<Arc<Session>> {
        if let Some(s) = self.live(id) {
            return Ok(s);
        }
        let lock = self.opening.lock().entry(id.to_owned()).or_default().clone();
        let _opening = lock.lock().await;
        if let Some(s) = self.live(id) {
            return Ok(s);
        }
        let config = self.config(id)?;
        let secret = self.secret(&config);
        let session = Arc::new(self.connect(id, &SshTarget::from(&config), secret.as_deref()).await?);
        self.sessions.lock().insert(id.to_owned(), session.clone());
        Ok(session)
    }

    fn live(&self, id: &str) -> Option<Arc<Session>> {
        let mut sessions = self.sessions.lock();
        match sessions.get(id) {
            Some(s) if !s.is_closed() => Some(s.clone()),
            Some(_) => {
                sessions.remove(id);
                None
            }
            None => None,
        }
    }

    /// A private session to `target`; an unknown host key is kept under `key`
    /// for [`SshManager::trust_host`].
    pub async fn connect(&self, key: &str, target: &SshTarget, secret: Option<&str>) -> IdeResult<Session> {
        match Session::connect(target, secret, &self.files).await {
            Ok(s) => Ok(s),
            Err(ConnectError::Other(e)) => Err(e),
            Err(ConnectError::UnknownHostKey(k)) => {
                let e = k.error();
                self.unknown.lock().insert(key.to_owned(), *k);
                Err(e)
            }
        }
    }

    /// Connects with `config` as given (not necessarily saved) and describes the host.
    pub async fn test(&self, config: &SshConfiguration, secret: Option<String>) -> IdeResult<String> {
        let secret = secret.or_else(|| self.secret(config));
        let session = self.connect(&config.id, &SshTarget::from(config), secret.as_deref()).await?;
        let out = session.exec("uname -srm 2>/dev/null || ver", None).await?;
        let os = out.stdout_str().trim().to_owned();
        Ok(if os.is_empty() {
            format!("Connected to {}", session.label())
        } else {
            format!("Connected to {}: {os}", session.label())
        })
    }

    /// Trusts the host key that failed the last connection under `key` (adds it to `known_hosts`).
    pub async fn trust_host(&self, key: &str) -> IdeResult<()> {
        let k = self.unknown.lock().remove(key).ok_or_else(|| IdeError::not_found("no host key to trust"))?;
        let path = self.files.known_hosts.clone();
        tokio::task::spawn_blocking(move || k.trust(&path)).await.map_err(|e| IdeError::internal(e.to_string()))?
    }

    pub fn disconnect(&self, id: &str) {
        self.sessions.lock().remove(id);
    }

    /// Ids of the configurations with an open session.
    pub fn connected(&self) -> Vec<String> {
        self.sessions.lock().iter().filter(|(_, s)| !s.is_closed()).map(|(k, _)| k.clone()).collect()
    }

    /// Whether connecting to `config` will need a secret the user has not given.
    pub fn needs_secret(&self, config: &SshConfiguration) -> bool {
        config.auth == SshAuth::Password && self.secret(config).is_none()
    }
}
