//! System Settings › HTTP Proxy on the host: the global settings made current for
//! connections and child processes, the password kept in the saved passwords
//! (owner-only `proxy-password.json`) instead of `settings.toml`.

use crate::Host;
use ide_core::IdeResult;
use ide_core::settings::Settings;

const PASSWORD_KEY: &str = "httpProxy";

impl Host {
    /// `settings` with the saved proxy password filled in, as the Settings dialog edits it.
    pub fn with_proxy_password(&self, mut settings: Settings) -> Settings {
        // A password typed into settings.toml by hand counts too, unless one was saved.
        if let Some(password) = self.proxy_password.get(PASSWORD_KEY) {
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
            match password.as_str().filter(|p| !p.is_empty()) {
                Some(p) => self.proxy_password.set(PASSWORD_KEY, p)?,
                None => self.proxy_password.delete(PASSWORD_KEY),
            }
        }
        Ok((key != "proxy.password").then_some(value))
    }
}
