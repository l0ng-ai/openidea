//! Settings action example. A real connection test can use host::fetch with a
//! declared network capability and a secret-backed Authorization header.
use openidea_plugin::{Error, Invocation, NotificationLevel, Plugin, host, register_plugin};

#[derive(Default)]
pub struct Profiles;

impl Plugin for Profiles {
    fn run_command(&mut self, id: &str, ctx: &Invocation, _arg: Option<&str>) -> Result<Option<String>, Error> {
        if id != "test" {
            return Err(Error::Invalid("unknown command".into()));
        }
        let json = host::setting("profiles").unwrap_or_else(|| "[]".into());
        let profiles: serde_json::Value = serde_json::from_str(&json).map_err(|e| Error::Invalid(e.to_string()))?;
        let rows = profiles.as_array().ok_or("model profiles must be an array")?;
        if rows.is_empty() {
            return Err(Error::Invalid("Add a model profile before testing".into()));
        }
        host::notify(NotificationLevel::Info, "Model Profiles", &format!("Read {} saved profile(s)", rows.len()));
        Ok(Some(serde_json::json!({ "profiles": profiles, "hasProject": ctx.project().is_some() }).to_string()))
    }
}

register_plugin!(Profiles);
