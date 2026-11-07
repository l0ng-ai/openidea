use crate::Host;
use ide_core::{IdeError, IdeResult, RequestId};
use ide_ssh::secrets::SecretFile;
pub use ide_vcs::commit_message::CommitAiConfig;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::io::Write;
use std::path::{Path, PathBuf};

#[derive(Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CommitAiSettings {
    pub config: CommitAiConfig,
    pub has_api_key: bool,
}

/// Bounded reads for AI evidence. A symlink contributes its target path, never its target's contents.
pub async fn vcs_commit_ai_read_text(
    host: &Host,
    window: &str,
    path: PathBuf,
    revision: Option<String>,
) -> IdeResult<String> {
    let project = host.project(window)?;
    host.blocking(move || {
        const LIMIT: usize = 1_000_000;
        let large = || IdeError::invalid("Selected changes are too large. Select fewer files or blocks.");
        let text = project.with_log_repo_of(&path, |repo| {
            if let Some(revision) = revision {
                if !matches!(revision.as_str(), "HEAD" | ":0") {
                    return Err(IdeError::invalid("invalid AI diff revision"));
                }
                let bytes = repo.file_bytes_at(&path, Some(&revision))?.unwrap_or_default();
                if bytes.len() > LIMIT {
                    return Err(large());
                }
                return Ok(repo
                    .file_at(&path, Some(&revision), project.vcs_encoding(&path, Some(&revision))?)?
                    .unwrap_or_default());
            }
            let metadata = std::fs::symlink_metadata(&path)?;
            if metadata.file_type().is_symlink() {
                return Ok(std::fs::read_link(&path)?.to_string_lossy().into_owned());
            }
            if !metadata.is_file() {
                return Err(IdeError::invalid("Select individual files to generate a commit message"));
            }
            if metadata.len() > LIMIT as u64 {
                return Err(large());
            }
            project.text_of(&path)
        })?;
        if text.len() > LIMIT {
            return Err(large());
        }
        Ok(text)
    })
    .await
}

fn load_config(path: &Path) -> IdeResult<CommitAiConfig> {
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| IdeError::invalid(e.to_string())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(CommitAiConfig::default()),
        Err(e) => Err(e.into()),
    }
}

fn paths(host: &Host) -> (PathBuf, SecretFile) {
    (host.config_dir.join("commit-ai.json"), SecretFile::new(host.data_dir.join("commit-ai-key.json")))
}

pub async fn vcs_commit_ai_settings(host: &Host) -> IdeResult<CommitAiSettings> {
    let (path, secrets) = paths(host);
    host.blocking(move || {
        Ok(CommitAiSettings { config: load_config(&path)?, has_api_key: secrets.get("api-key").is_some() })
    })
    .await
}

/// `None` preserves the stored key; an empty string forgets it. Keys never return to the UI.
pub async fn vcs_commit_ai_save_settings(
    host: &Host,
    mut config: CommitAiConfig,
    api_key: Option<String>,
) -> IdeResult<CommitAiSettings> {
    config.base_url = config.base_url.trim().to_owned();
    config.model = config.model.trim().to_owned();
    if !config.base_url.is_empty() || !config.model.is_empty() {
        config.endpoint()?;
    }
    let (path, secrets) = paths(host);
    host.blocking(move || {
        let parent = path.parent().ok_or_else(|| IdeError::internal("missing AI settings directory"))?;
        std::fs::create_dir_all(parent)?;
        let mut file = tempfile::NamedTempFile::new_in(parent)?;
        file.write_all(&serde_json::to_vec_pretty(&config).map_err(|e| IdeError::internal(e.to_string()))?)?;
        if let Some(key) = api_key {
            let key = key.trim();
            if key.is_empty() {
                secrets.delete("api-key");
                if secrets.get("api-key").is_some() {
                    return Err(IdeError::unavailable("Could not remove the stored AI API key"));
                }
            } else {
                secrets.set("api-key", key)?;
            }
        }
        file.persist(path).map_err(|e| IdeError::from(e.error))?;
        Ok(CommitAiSettings { config, has_api_key: secrets.get("api-key").is_some() })
    })
    .await
}

pub async fn vcs_generate_commit_message(
    host: &Host,
    window: &str,
    request: RequestId,
    diff: String,
) -> IdeResult<String> {
    host.require_trust(window)?;
    let cancel = host.begin_project_request(window, request);
    let (path, secrets) = paths(host);
    let result = async {
        let (config, key) =
            host.blocking(move || Ok((load_config(&path)?, secrets.get("api-key").unwrap_or_default()))).await?;
        let client = ide_http::client::build_with_redirect_policy(
            &ide_core::proxy_settings::proxy(),
            reqwest::redirect::Policy::none(),
        )?;
        ide_vcs::commit_message::generate(client, &config, &key, &diff, &cancel).await
    }
    .await;
    host.end_request(request);
    result
}
