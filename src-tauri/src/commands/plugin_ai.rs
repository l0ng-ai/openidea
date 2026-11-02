//! User-configured AI completions for authorized commit-message plugins.

#[cfg(test)]
mod tests {
    use super::*;

    fn settings() -> PluginAiConfig {
        PluginAiConfig {
            base_url: "https://example.test/v1".into(),
            model: "model".into(),
            temperature: 0.2,
            system_prompt: "write a subject".into(),
        }
    }

    #[test]
    fn endpoint_appends_chat_completions_and_rejects_unsafe_urls() {
        assert_eq!(
            completion_endpoint("https://example.test/v1/").unwrap(),
            "https://example.test/v1/chat/completions"
        );
        assert!(completion_endpoint("file:///tmp/x").is_err());
        assert!(completion_endpoint("https://user:secret@example.test/v1").is_err());
        assert!(completion_endpoint("https://example.test/v1?key=secret").is_err());
    }

    #[test]
    fn invalid_configuration_is_rejected() {
        let mut config = settings();
        assert!(validate_config(&config).is_ok());
        config.temperature = 2.1;
        assert!(validate_config(&config).is_err());
        config.temperature = 0.2;
        config.model.clear();
        assert!(validate_config(&config).is_err());
    }

    #[test]
    fn request_body_must_equal_only_authorized_input() {
        let expected = serde_json::json!({
            "model": "model", "temperature": 0.2,
            "messages": [
                {"role": "system", "content": "prompt"},
                {"role": "user", "content": "selected diff"}
            ]
        });
        assert!(validate_request_body(&expected.to_string(), "selected diff", "model", 0.2, "prompt").is_ok());
        let mut malicious = expected.clone();
        malicious["messages"][1]["content"] = serde_json::json!("selected diff plus unrelated secret");
        assert!(validate_request_body(&malicious.to_string(), "selected diff", "model", 0.2, "prompt").is_err());
        malicious = expected;
        malicious["other"] = serde_json::json!("unrelated secret");
        assert!(validate_request_body(&malicious.to_string(), "selected diff", "model", 0.2, "prompt").is_err());
        let duplicates = r#"{"model":"unrelated-secret","model":"model","temperature":0.2,"messages":[{"role":"system","content":"prompt"},{"role":"user","content":"selected diff"}]}"#;
        let canonical = validate_request_body(duplicates, "selected diff", "model", 0.2, "prompt").unwrap();
        assert!(!canonical.contains("unrelated-secret"));
    }

    #[test]
    fn provider_response_detects_escaped_and_short_keys() {
        let escaped = r#"{"choices":[{"message":{"content":"prefix \u0073ecret suffix"}}]}"#;
        assert!(sanitize_response(escaped, "secret").is_err());
        let short = r#"{"choices":[{"message":{"content":"testing feature"}}]}"#;
        assert!(sanitize_response(short, "test").is_err());
        let metadata = r#"{"metadata":"secret","choices":[{"message":{"content":"fix typo"}}]}"#;
        let clean = sanitize_response(metadata, "secret").unwrap();
        assert!(!clean.contains("metadata"));
        assert!(sanitize_response(r#"{"choices":[{"message":{"content":"fix typo"}}]}"#, "secret").is_ok());
    }

    #[tokio::test]
    async fn fake_provider_cannot_smuggle_json_escaped_key_to_plugin() {
        use std::io::{BufRead, BufReader, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                if line == "\r\n" || line.is_empty() {
                    break;
                }
            }
            let body = r#"{"choices":[{"message":{"content":"prefix \u0073ecret suffix"}}]}"#;
            write!(stream, "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body)
                .unwrap();
        });
        let url = format!("http://{address}/v1/chat/completions");
        let response = ide_http::client::post_plugin_json(&url, "secret", "{}").await.unwrap();
        let error = sanitize_response(&response, "secret").unwrap_err().message;
        assert!(!error.contains("secret"));
        server.join().unwrap();
    }

    #[test]
    fn project_prompt_overrides_global_only_when_nonblank() {
        assert_eq!(resolve_prompt("global", " project "), "project");
        assert_eq!(resolve_prompt("global", "  "), "global");
    }

    #[test]
    fn project_prompt_rejects_large_inputs() {
        assert!(validate_project_prompt("normal prompt").is_ok());
        assert!(validate_project_prompt(&"x".repeat(32 * 1024 + 1)).is_err());
    }

    #[test]
    fn project_prompts_are_isolated_and_never_written_into_projects() {
        let root = std::env::temp_dir().join(format!(
            "openidea-plugin-ai-project-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        let data = root.join("data");
        let project_a = root.join("project-a");
        let project_b = root.join("project-b");
        std::fs::create_dir_all(&project_a).unwrap();
        std::fs::create_dir_all(&project_b).unwrap();
        let store = PluginAiStore::new(data);
        store.set_project_prompt(&project_a, "only A").unwrap();
        assert_eq!(store.project_prompt(&project_a).unwrap(), "only A");
        assert_eq!(store.project_prompt(&project_b).unwrap(), "");
        assert!(!project_a.join(".openidea").exists());
        store.set_project_prompt(&project_a, "").unwrap();
        assert_eq!(store.project_prompt(&project_a).unwrap(), "");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn settings_never_expose_stored_key_and_blank_key_clears_it() {
        let root = std::env::temp_dir().join(format!(
            "openidea-plugin-ai-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        let store = PluginAiStore::new(root.clone());
        let saved = store.save(settings(), Some("secret-value".into())).unwrap();
        assert!(saved.has_api_key);
        assert!(!serde_json::to_string(&saved).unwrap().contains("secret-value"));
        assert!(store.save(settings(), None).unwrap().has_api_key);
        assert!(!store.save(settings(), Some(String::new())).unwrap().has_api_key);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn deleting_a_key_reports_storage_failure() {
        let root = std::env::temp_dir().join(format!(
            "openidea-plugin-ai-delete-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        let store = PluginAiStore::new(root.clone());
        store.save(settings(), Some("secret-value".into())).unwrap();
        // Prevent the atomic secret file rewrite while leaving the existing key readable.
        std::fs::create_dir(root.join("plugin-ai-secrets.json.tmp")).unwrap();
        assert!(store.save(settings(), Some(String::new())).is_err());
        assert!(store.get().unwrap().has_api_key);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn provider_save_failure_keeps_prior_configuration_and_key() {
        let root = std::env::temp_dir().join(format!(
            "openidea-plugin-ai-atomic-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        let store = PluginAiStore::new(root.clone());
        let initial = settings();
        store.save(initial.clone(), Some("old-secret".into())).unwrap();
        std::fs::create_dir(root.join("plugin-ai-secrets.json.tmp")).unwrap();
        let mut changed = initial.clone();
        changed.model = "new-model".into();
        assert!(store.save(changed, Some("new-secret".into())).is_err());
        let (actual, key) = store.snapshot().unwrap();
        assert_eq!(actual.model, initial.model);
        assert_eq!(key, "old-secret");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn malformed_provider_storage_is_not_treated_as_defaults() {
        let root = std::env::temp_dir().join(format!(
            "openidea-plugin-ai-corrupt-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("plugin-ai-secrets.json"), b"bad json").unwrap();
        assert!(PluginAiStore::new(root.clone()).get().is_err());
        let _ = std::fs::remove_dir_all(root);
    }
}

use crate::state::AppState;
use ide_core::{IdeError, IdeResult};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use tauri::{State, Window};

const PROVIDER_ID: &str = "provider";
const MAX_DIFF_BYTES: usize = 256 * 1024;
const MAX_REQUEST_BYTES: usize = 512 * 1024;

/// Provider settings are global. Secrets live only in the private secret store.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PluginAiConfig {
    pub base_url: String,
    pub model: String,
    pub temperature: f64,
    pub system_prompt: String,
}

impl Default for PluginAiConfig {
    fn default() -> Self {
        Self {
            base_url: "https://api.openai.com".into(),
            model: "gpt-4o-mini".into(),
            temperature: 0.2,
            system_prompt: "Write a concise Git commit message based on the selected changes.".into(),
        }
    }
}

/// Safe settings view returned to the UI; it never contains the API key.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PluginAiSettings {
    pub base_url: String,
    pub model: String,
    pub temperature: f64,
    pub system_prompt: String,
    pub has_api_key: bool,
}

/// Project prompt and whether a project is available in the current window.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ProjectPrompt {
    pub available: bool,
    pub prompt: String,
}

/// The provider and its key are one atomically replaced private record.
#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredProvider {
    config: PluginAiConfig,
    api_key: Option<String>,
}

/// Serializes updates to the config and the owner-only secret file.
pub struct PluginAiStore {
    root: PathBuf,
    lock: Mutex<()>,
    secrets: ide_ssh::secrets::SecretFile,
}

impl PluginAiStore {
    pub fn new(root: PathBuf) -> Self {
        Self {
            secrets: ide_ssh::secrets::SecretFile::new(root.join("plugin-ai-secrets.json")),
            root,
            lock: Mutex::new(()),
        }
    }

    fn load_provider(&self) -> IdeResult<StoredProvider> {
        match self.secrets.get_checked(PROVIDER_ID)? {
            Some(value) => serde_json::from_str(&value).map_err(|_| IdeError::invalid("Invalid AI provider settings")),
            None => Ok(StoredProvider::default()),
        }
    }

    fn view(provider: StoredProvider) -> PluginAiSettings {
        let config = provider.config;
        PluginAiSettings {
            base_url: config.base_url,
            model: config.model,
            temperature: config.temperature,
            system_prompt: config.system_prompt,
            has_api_key: provider.api_key.is_some_and(|key| !key.is_empty()),
        }
    }

    pub fn get(&self) -> IdeResult<PluginAiSettings> {
        let _guard = self.lock.lock();
        Ok(Self::view(self.load_provider()?))
    }

    /// `None` preserves the existing key, while an empty string deletes it.
    pub fn save(&self, config: PluginAiConfig, api_key: Option<String>) -> IdeResult<PluginAiSettings> {
        validate_config(&config)?;
        let _guard = self.lock.lock();
        let mut provider = self.load_provider()?;
        provider.config = config;
        if let Some(key) = api_key {
            provider.api_key = (!key.is_empty()).then_some(key);
        }
        let value = serde_json::to_string(&provider).map_err(|_| IdeError::invalid("Invalid AI provider settings"))?;
        self.secrets.set_checked(PROVIDER_ID, &value)?;
        Ok(Self::view(provider))
    }

    fn snapshot(&self) -> IdeResult<(PluginAiConfig, String)> {
        let _guard = self.lock.lock();
        let provider = self.load_provider()?;
        let config = provider.config;
        validate_config(&config)?;
        let key = provider
            .api_key
            .filter(|key| !key.is_empty())
            .ok_or_else(|| IdeError::invalid("Configure an AI provider API key first"))?;
        Ok((config, key))
    }

    fn project_prompts(&self) -> IdeResult<BTreeMap<String, String>> {
        match std::fs::read(self.root.join("plugin-ai-project-prompts.json")) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| IdeError::invalid("Invalid AI project prompts")),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(BTreeMap::new()),
            Err(error) => Err(error.into()),
        }
    }

    fn project_key(project: &Path) -> IdeResult<&str> {
        project.to_str().ok_or_else(|| IdeError::invalid("Project path is not UTF-8"))
    }

    fn project_prompt(&self, project: &Path) -> IdeResult<String> {
        let _guard = self.lock.lock();
        Ok(self.project_prompts()?.get(Self::project_key(project)?).cloned().unwrap_or_default())
    }

    fn set_project_prompt(&self, project: &Path, prompt: &str) -> IdeResult<()> {
        validate_project_prompt(prompt)?;
        let _guard = self.lock.lock();
        let mut prompts = self.project_prompts()?;
        if prompt.trim().is_empty() {
            prompts.remove(Self::project_key(project)?);
        } else {
            prompts.insert(Self::project_key(project)?.to_owned(), prompt.to_owned());
        }
        std::fs::create_dir_all(&self.root)?;
        let path = self.root.join("plugin-ai-project-prompts.json");
        let tmp = self.root.join("plugin-ai-project-prompts.json.tmp");
        let bytes = serde_json::to_vec_pretty(&prompts).map_err(|_| IdeError::invalid("Invalid AI project prompts"))?;
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        let mut file = options.open(&tmp)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
        }
        std::io::Write::write_all(&mut file, &bytes)?;
        std::fs::rename(tmp, path)?;
        Ok(())
    }
}

fn completion_endpoint(base: &str) -> IdeResult<String> {
    ide_http::client::plugin_completion_endpoint(base)
}

fn validate_config(config: &PluginAiConfig) -> IdeResult<()> {
    completion_endpoint(&config.base_url)?;
    if config.model.trim().is_empty() || config.model.len() > 256 {
        return Err(IdeError::invalid("AI model must be between 1 and 256 characters"));
    }
    if !config.temperature.is_finite() || !(0.0..=2.0).contains(&config.temperature) {
        return Err(IdeError::invalid("AI temperature must be between 0 and 2"));
    }
    if config.system_prompt.len() > 32 * 1024 {
        return Err(IdeError::invalid("AI system prompt is too large"));
    }
    Ok(())
}

fn resolve_prompt(global: &str, project: &str) -> String {
    let project = project.trim();
    if project.is_empty() { global.to_owned() } else { project.to_owned() }
}

fn validate_project_prompt(prompt: &str) -> IdeResult<()> {
    if prompt.len() > 32 * 1024 {
        return Err(IdeError::invalid("AI project prompt is too large"));
    }
    Ok(())
}

/// Rejects any plugin-provided data beyond the selected diff and user-configured settings.
fn validate_request_body(body: &str, diff: &str, model: &str, temperature: f64, prompt: &str) -> IdeResult<String> {
    let actual = serde_json::from_str::<serde_json::Value>(body)
        .map_err(|_| IdeError::invalid("Plugin returned an invalid AI request"))?;
    let expected = serde_json::json!({
        "model": model.trim(), "temperature": temperature,
        "messages": [
            {"role": "system", "content": prompt},
            {"role": "user", "content": diff},
        ]
    });
    if body.len() > MAX_REQUEST_BYTES || actual != expected {
        return Err(IdeError::invalid("Plugin AI request does not match the selected changes"));
    }
    // Send a fresh canonical encoding so duplicate JSON keys cannot be interpreted
    // differently by the provider than by the host's validator.
    Ok(expected.to_string())
}

/// Send only the first decoded message to the plugin, omitting all provider metadata.
fn sanitize_response(response: &str, secret: &str) -> IdeResult<String> {
    let value: serde_json::Value =
        serde_json::from_str(response).map_err(|_| IdeError::invalid("AI provider returned invalid JSON"))?;
    let message = value
        .pointer("/choices/0/message/content")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| IdeError::invalid("AI provider returned an empty response"))?;
    if message.contains(secret) {
        return Err(IdeError::invalid("AI provider response contains the configured API key"));
    }
    Ok(serde_json::json!({"choices": [{"message": {"content": message}}]}).to_string())
}

/// Returns settings without revealing the saved provider key.
#[tauri::command]
#[specta::specta]
pub fn plugin_ai_settings_get(state: State<'_, AppState>) -> IdeResult<PluginAiSettings> {
    state.plugin_ai.get()
}

/// Saves settings and optionally replaces or clears the provider key.
#[tauri::command]
#[specta::specta]
pub fn plugin_ai_settings_set(
    state: State<'_, AppState>,
    settings: PluginAiConfig,
    api_key: Option<String>,
) -> IdeResult<PluginAiSettings> {
    state.plugin_ai.save(settings, api_key)
}

/// Reads the current project's override without exposing provider credentials.
#[tauri::command]
#[specta::specta]
pub fn plugin_ai_project_prompt_get(window: Window, state: State<'_, AppState>) -> IdeResult<ProjectPrompt> {
    match state.project(window.label()) {
        Ok(project) if !project.light => {
            Ok(ProjectPrompt { available: true, prompt: state.plugin_ai.project_prompt(&project.root)? })
        }
        _ => Ok(ProjectPrompt { available: false, prompt: String::new() }),
    }
}

/// Saves the override in app data, keyed by project root; empty uses the global prompt.
#[tauri::command]
#[specta::specta]
pub fn plugin_ai_project_prompt_set(
    window: Window,
    state: State<'_, AppState>,
    prompt: String,
) -> IdeResult<ProjectPrompt> {
    validate_project_prompt(&prompt)?;
    let project = state.project(window.label())?;
    if project.light {
        return Err(IdeError::invalid("Open a project to set its AI prompt"));
    }
    state.plugin_ai.set_project_prompt(&project.root, &prompt)?;
    Ok(ProjectPrompt { available: true, prompt })
}

/// Runs the authorized provider in the current project, keeping the API key out of the plugin and UI.
#[tauri::command]
#[specta::specta]
pub async fn plugin_generate_commit_message(
    window: Window,
    state: State<'_, AppState>,
    plugin_id: String,
    diff: String,
) -> IdeResult<String> {
    if diff.trim().is_empty() || diff.len() > MAX_DIFF_BYTES || diff.chars().count() > 12_000 {
        return Err(IdeError::invalid("Selected changes are empty or too large"));
    }
    let project = state.project(window.label())?;
    let host = state.plugins.clone();
    host.sync_project(&project.root);
    let session = host.authorize_ai(&plugin_id, &project.root)?;
    let (config, key) = state.plugin_ai.snapshot()?;
    let endpoint = completion_endpoint(&config.base_url)?;
    let prompt = resolve_prompt(&config.system_prompt, &state.plugin_ai.project_prompt(&project.root)?);
    if prompt.len() > 32 * 1024 {
        return Err(IdeError::invalid("AI system prompt is too large"));
    }
    let request_arg = serde_json::json!({
        "diff": &diff,
        "model": &config.model,
        "temperature": config.temperature,
        "systemPrompt": &prompt,
    })
    .to_string();
    let worker_host = host.clone();
    let worker_session = session.clone();
    let body = tauri::async_runtime::spawn_blocking(move || {
        worker_host.run_ai_command(&worker_session, "build-request", Some(&request_arg))
    })
    .await
    .map_err(|_| IdeError::internal("Failed to build AI request"))??
    .ok_or_else(|| IdeError::invalid("Plugin returned an empty AI request"))?;
    let body = validate_request_body(&body, &diff, &config.model, config.temperature, &prompt)?;
    host.check_ai_session(&session)?;
    let response = ide_http::client::post_plugin_json(&endpoint, &key, &body).await?;
    let response = sanitize_response(&response, &key)?;
    let result =
        tauri::async_runtime::spawn_blocking(move || host.run_ai_command(&session, "parse-response", Some(&response)))
            .await
            .map_err(|_| IdeError::internal("Failed to parse AI response"))??
            .ok_or_else(|| IdeError::invalid("Plugin returned an empty commit message"))?;
    if result.trim().is_empty() || result.len() > 16 * 1024 {
        return Err(IdeError::invalid("Plugin returned an invalid commit message"));
    }
    Ok(result)
}
