//! System Settings › HTTP Proxy on the host: the global settings made current for
//! connections and child processes, the password kept in the saved passwords
//! (the OS credential store) instead of `settings.toml`, or for the session
//! when there is no credential store.

use crate::Host;
use ide_core::IdeResult;
use ide_core::settings::Settings;

const PASSWORD_KEY: &str = "httpProxy";

impl Host {
    /// `settings` with the saved proxy password filled in, as the Settings dialog edits it.
    pub fn with_proxy_password(&self, mut settings: Settings) -> Settings {
        // A password typed into settings.toml by hand counts too, unless one was saved.
        let session = || self.proxy_session_password.lock().clone();
        if let Some(password) = self.proxy_password.get(PASSWORD_KEY).or_else(session) {
            settings.proxy.password = password;
        }
        settings
    }

    /// Makes the global proxy settings the proxy of every later connection and child process.
    pub fn apply_proxy(&self) {
        let settings = self.with_proxy_password(self.global_settings.effective());
        if let Some(problem) = settings.proxy.problem() {
            tracing::warn!("HTTP proxy: {problem}");
        }
        ide_core::proxy_settings::set_proxy(settings.proxy);
    }

    /// Takes the proxy password out of a settings write of `key` and saves it.
    /// Returns the value left to write, `None` when nothing is.
    pub(crate) fn take_proxy_password(
        &self,
        key: &str,
        mut value: serde_json::Value,
    ) -> IdeResult<Option<serde_json::Value>> {
        let password = match key {
            "proxy.password" => Some(value.take()),
            "proxy" => value.as_object_mut().and_then(|o| o.remove("password")),
            _ => return Ok(Some(value)),
        };
        if let Some(password) = password {
            let password = password.as_str().filter(|p| !p.is_empty());
            let mut session = self.proxy_session_password.lock();
            *session = None;
            match password {
                Some(p) => {
                    if let Err(e) = self.proxy_password.set(PASSWORD_KEY, p) {
                        tracing::warn!("the HTTP proxy password is kept for this session only: {}", e.message);
                        *session = Some(p.to_owned());
                    }
                }
                None => self.proxy_password.delete(PASSWORD_KEY),
            }
        }
        Ok((key != "proxy.password").then_some(value))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ide_ssh::secrets::{SecretFile, StoreError, StoreResult, Vault};
    use std::sync::Arc;

    /// A machine without a credential store (a headless Linux host).
    struct NoStore;

    impl Vault for NoStore {
        fn available(&self) -> bool {
            false
        }
        fn get(&self, _: &str, _: &str) -> StoreResult<String> {
            Err(StoreError::NoDefaultStore)
        }
        fn set(&self, _: &str, _: &str, _: &str) -> StoreResult<()> {
            Err(StoreError::NoDefaultStore)
        }
        fn delete(&self, _: &str, _: &str) -> StoreResult<()> {
            Err(StoreError::NoDefaultStore)
        }
    }

    #[tokio::test]
    async fn without_a_credential_store_the_password_lasts_the_session() {
        let tmp = tempfile::tempdir().unwrap();
        let mut host = Host::new(crate::HostConfig {
            config_dir: tmp.path().join("config"),
            data_dir: tmp.path().join("data"),
            local_data_dir: tmp.path().join("data"),
            languages: Arc::new(ide_language::LanguageRegistry::load(None).unwrap()),
            syntax: Arc::default(),
            sink_for: Box::new(|_| Arc::new(ide_core::NullSink)),
            owner: |w| w,
            runtime: tokio::runtime::Handle::current(),
            project_environment: false,
        });
        let path = tmp.path().join("data/proxy-password.json");
        host.proxy_password = SecretFile::with_vault(path, |v| serde_json::from_value(v).ok(), Arc::new(NoStore));

        let left = host.take_proxy_password("proxy.password", serde_json::json!("s3cret")).unwrap();
        assert_eq!(left, None);
        assert_eq!(host.with_proxy_password(Settings::default()).proxy.password, "s3cret");
        host.take_proxy_password("proxy.password", serde_json::json!("")).unwrap();
        assert_eq!(host.with_proxy_password(Settings::default()).proxy.password, "");
    }
}
