//! Desktop updater coordination shared by all webviews.

mod download;

use crate::commands::window::{UpdateSource, check_update, update_endpoint_env, updater, updates_configured};
use crate::state::AppState;
use ide_core::updates::{UpdateCheck, UpdatePolicy};
use ide_core::{CancellationToken, IdeError, IdeEvent, IdeResult};
use parking_lot::Mutex;
use std::collections::HashSet;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};
use tauri_plugin_updater::Update;
use tokio::sync::Notify;

/// One verified download, kept on disk until its installer has finished.
pub(crate) struct DownloadedUpdate {
    pub update: Update,
    pub bytes: Vec<u8>,
    pub path: PathBuf,
}

/// Tauri patches the installer copies; the raw exe shipped in the portable zip keeps no bundle type.
pub fn portable_target(os: &str, arch: &str, bundle: Option<tauri::utils::config::BundleType>) -> Option<String> {
    (os == "windows" && bundle.is_none()).then(|| format!("windows-{arch}-portable"))
}

#[derive(Default)]
pub struct Updates {
    started: AtomicBool,
    ready: Mutex<HashSet<String>>,
    system_locale: Mutex<String>,
    pub wake: Notify,
    gate: tokio::sync::Mutex<()>,
    pub state: Mutex<CheckState>,
}

#[derive(Default)]
pub struct CheckState {
    pub policy: UpdatePolicy,
    revision: u64,
    result: Option<IdeResult<UpdateCheck>>,
}

impl Updates {
    pub fn forget_window(&self, window: &str) {
        self.ready.lock().remove(window);
    }
}

fn automatic_enabled(app: &AppHandle) -> bool {
    updates_configured(app) && app.state::<AppState>().global_settings.effective().general.auto_check_updates
}

/// Called after an ordinary window has installed its event handlers. The task survives window closes and HMR.
pub fn window_ready(app: &AppHandle, window: &str, ready: bool, system_locale: String) {
    if !ready {
        app.state::<AppState>().updates.forget_window(window);
        return;
    }
    app.state::<AppState>().updates.ready.lock().insert(window.to_owned());
    *app.state::<AppState>().updates.system_locale.lock() = system_locale;
    if !updates_configured(app) || (cfg!(debug_assertions) && update_endpoint_env().is_none()) {
        return;
    }
    if app.state::<AppState>().updates.started.swap(true, Ordering::SeqCst) {
        announce_available(app);
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            let state = app.state::<AppState>();
            let wake = state.updates.wake.notified();
            let delay = automatic_enabled(&app).then(|| state.updates.state.lock().policy.due_in(Instant::now()));
            if delay.is_some_and(|d| d.is_zero()) {
                if let Err(error) = check(&app, None).await {
                    tracing::warn!(%error, "automatic update check failed");
                }
                continue;
            }
            match delay {
                Some(delay) => tokio::select! {
                    _ = tokio::time::sleep(delay) => {},
                    _ = wake => {},
                },
                None => wake.await,
            }
        }
    });
}

/// `None` is an automatic check; explicit sources are manual checks and always return their result.
pub async fn check(app: &AppHandle, source: Option<UpdateSource>) -> IdeResult<UpdateCheck> {
    let state = app.state::<AppState>();
    let revision = state.updates.state.lock().revision;
    let _gate = state.updates.gate.lock().await;
    let automatic = source.is_none();
    {
        let current = state.updates.state.lock();
        if !automatic
            && current.revision != revision
            && let Some(result) = &current.result
        {
            return result.clone();
        }
        if automatic && (!automatic_enabled(app) || !current.policy.due_in(Instant::now()).is_zero()) {
            return Ok(UpdateCheck { enabled: updates_configured(app), update: None });
        }
    }
    let settings = state.global_settings.effective();
    let source = source.unwrap_or_else(|| {
        UpdateSource::resolve(
            &settings.general.update_source,
            &settings.appearance.locale,
            &state.updates.system_locale.lock(),
        )
    });
    state.updates.state.lock().policy.begin(Instant::now());
    emit_status(&state);
    let result = check_update(app, source).await;
    let checked_at = result
        .as_ref()
        .ok()
        .filter(|check| check.enabled)
        .map(|_| SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs_f64() * 1000.0);
    {
        let mut current = state.updates.state.lock();
        current.policy.finish(checked_at);
        current.revision += 1;
        current.result = Some(result.clone());
    }
    emit_status(&state);
    state.updates.wake.notify_one();
    if automatic {
        announce_available(app);
    }
    result
}

/// Downloads an update to a signature-keyed `.part` file, resuming from bytes
/// kept by a previous attempt or process, and verifies the completed package.
pub(crate) async fn download_update(
    app: &AppHandle,
    source: UpdateSource,
    token: &CancellationToken,
    mut progress: impl FnMut(u64, Option<u64>),
) -> IdeResult<DownloadedUpdate> {
    let updater = updater(app, source)?.ok_or_else(|| IdeError::unavailable("updates are not configured"))?;
    let update =
        cancellable(token, async { updater.check().await.map_err(|error| IdeError::unavailable(error.to_string())) })
            .await?
            .ok_or_else(|| IdeError::not_found("no update available"))?;
    let directory = app
        .path()
        .app_cache_dir()
        .map_err(|error| IdeError::internal(format!("update cache directory: {error}")))?
        .join("updates");
    tokio::fs::create_dir_all(&directory).await?;
    let key = cache_key(&update.version, &update.target, &update.signature);
    let path = directory.join(format!("{key}.part"));
    if let Err(error) = cleanup_stale_cache_files(&path).await {
        tracing::warn!(%error, "cannot clean obsolete update downloads");
    }
    let client = ide_http::client::shared()?;
    for attempt in 0..3 {
        let outcome =
            cancellable(token, download::fetch(&client, update.download_url.as_str(), &path, &mut progress)).await?;
        match cancellable(token, verify_file(update.clone(), path.clone())).await {
            Ok(bytes) => return Ok(DownloadedUpdate { update, bytes, path }),
            Err(error) if outcome.resumed && attempt < 2 => {
                tracing::warn!(%error, "discarding a mixed update checkpoint");
                tokio::fs::remove_file(&path).await?;
            }
            Err(_) if outcome.total.is_none() && attempt < 2 => {
                tracing::warn!("an update response of unknown length failed verification; resuming");
            }
            Err(error) => {
                if outcome.resumed || outcome.total.is_some() {
                    tokio::fs::remove_file(&path).await?;
                }
                return Err(error);
            }
        }
    }
    Err(IdeError::internal("update download did not produce a verified package"))
}

/// Runs one fallible stage until it finishes or the command is cancelled. The
/// check and signature-verification stages previously escaped cancellation
/// while the download itself was cancellable.
async fn cancellable<T>(token: &CancellationToken, future: impl Future<Output = IdeResult<T>>) -> IdeResult<T> {
    tokio::select! {
        result = future => result,
        _ = token.cancelled() => Err(IdeError::cancelled()),
    }
}

/// Stable cache identity shared by GitHub and CNB for the same signed artifact.
fn cache_key(version: &str, target: &str, signature: &str) -> String {
    let hash = blake3::hash(format!("{version}\0{target}\0{signature}").as_bytes()).to_hex();
    format!("{version}-{target}-{hash}")
}

/// Reads and verifies a completed checkpoint on the blocking pool.
async fn verify_file(update: Update, path: PathBuf) -> IdeResult<Vec<u8>> {
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = std::fs::read(path)?;
        update.verify(&bytes).map_err(|error| IdeError::internal(error.to_string()))?;
        Ok(bytes)
    })
    .await
    .map_err(|error| IdeError::internal(error.to_string()))?
}

/// Keeps the current signed artifact's checkpoint and backup while removing
/// obsolete releases and abandoned fallback temporaries.
async fn cleanup_stale_cache_files(path: &Path) -> IdeResult<()> {
    let Some(directory) = path.parent() else { return Ok(()) };
    let keep_part = path.file_name();
    let mut keep_backup = path.file_name().unwrap_or_default().to_os_string();
    keep_backup.push(".backup");
    let mut entries = tokio::fs::read_dir(directory).await?;
    while let Some(entry) = entries.next_entry().await? {
        if !entry.file_type().await?.is_file() {
            continue;
        }
        let name = entry.file_name();
        if Some(name.as_os_str()) == keep_part || name == keep_backup {
            continue;
        }
        let text = name.to_string_lossy();
        if text.ends_with(".part") || text.ends_with(".ready") || text.ends_with(".full") || text.ends_with(".backup") {
            let _ = tokio::fs::remove_file(entry.path()).await;
        }
    }
    Ok(())
}

fn emit_status(state: &AppState) {
    let status = state.updates.state.lock().policy.status.clone();
    state.sink.emit(IdeEvent::UpdateStatusChanged { status });
}

fn announce_available(app: &AppHandle) {
    if !automatic_enabled(app) {
        return;
    }
    let state = app.state::<AppState>();
    // Asking a window whether it is focused waits for the main thread, where
    // `app_update_window_ready` takes `ready`: never hold the lock across it.
    let focused = crate::windows::target_window(app);
    let live = crate::windows::project_window_labels(app);
    let owner = {
        let mut ready = state.updates.ready.lock();
        ready.retain(|label| app.get_webview_window(label).is_some());
        ready_owner(focused.as_ref().map(|window| window.label()), &live, &ready)
    };
    let Some(owner) = owner else { return };
    let update = {
        let current = state.updates.state.lock();
        let update = current.result.as_ref().and_then(|r| r.as_ref().ok()).and_then(|r| r.update.clone());
        update.filter(|update| !current.policy.announced(&update.version))
    };
    if let Some(update) = update {
        state.window_sink(&owner).emit(IdeEvent::UpdateAvailable { update });
    }
}

fn ready_owner(preferred: Option<&str>, live: &[String], ready: &HashSet<String>) -> Option<String> {
    preferred
        .map(AppState::owner_window)
        .filter(|label| ready.contains(*label) && live.iter().any(|live| live.as_str() == *label))
        .map(str::to_owned)
        .or_else(|| live.iter().find(|label| ready.contains(*label)).cloned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_unbundled_windows_builds_select_portable_updates() {
        use tauri::utils::config::BundleType;
        for arch in ["x86_64", "aarch64"] {
            assert_eq!(portable_target("windows", arch, None), Some(format!("windows-{arch}-portable")));
            for bundle in [BundleType::Msi, BundleType::Nsis] {
                assert_eq!(portable_target("windows", arch, Some(bundle)), None);
            }
            for os in ["linux", "macos"] {
                assert_eq!(portable_target(os, arch, None), None);
            }
        }
    }

    #[test]
    fn notifications_only_target_live_owners_that_have_subscribed() {
        let live = vec!["main".into(), "project-2".into()];
        let ready = HashSet::from(["main".into(), "closed-window".into()]);
        for focused in [Some("project-2"), Some("settings-main"), Some("closed-window"), None] {
            assert_eq!(ready_owner(focused, &live, &ready), Some("main".into()));
        }
        assert_eq!(ready_owner(Some("main"), &live, &HashSet::new()), None);
        assert_eq!(ready_owner(Some("closed-window"), &[], &ready), None);
    }

    /// The cache identity stays stable across mirrors only while the signed bytes do.
    #[test]
    fn cache_identity_follows_the_signature_not_the_download_url() {
        let first = cache_key("0.1.50", "darwin-aarch64", "signature-a");
        assert_eq!(first, cache_key("0.1.50", "darwin-aarch64", "signature-a"));
        assert_ne!(first, cache_key("0.1.50", "darwin-aarch64", "signature-b"));
        assert_ne!(first, cache_key("0.1.51", "darwin-aarch64", "signature-a"));
    }

    /// Starting a download keeps its signed artifact's checkpoint and restores
    /// its backup, while obsolete releases and fallback temporaries go away.
    #[tokio::test]
    async fn stale_update_cache_files_are_removed() {
        let dir = tempfile::tempdir().unwrap();
        let current = dir.path().join("current.part");
        for name in
            ["current.part", "current.part.backup", "current.part.full", "old.part", "old.ready", "old.part.backup"]
        {
            tokio::fs::write(dir.path().join(name), b"x").await.unwrap();
        }
        tokio::fs::write(dir.path().join("unrelated.json"), b"{}").await.unwrap();

        cleanup_stale_cache_files(&current).await.unwrap();

        assert!(current.exists());
        assert!(dir.path().join("current.part.backup").exists());
        assert!(dir.path().join("unrelated.json").exists());
        for name in ["current.part.full", "old.part", "old.ready", "old.part.backup"] {
            assert!(!dir.path().join(name).exists(), "{name} was kept");
        }
    }

    /// Signature verification is wrapped in the same cancellation boundary as
    /// network work, so a late Cancel cannot fall through into installation.
    #[tokio::test]
    async fn cancelled_stage_stops_before_installation() {
        let token = CancellationToken::new();
        token.cancel();
        let error = cancellable(&token, async {
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            Ok(())
        })
        .await
        .unwrap_err();
        assert_eq!(error.kind, ide_core::error::ErrorKind::Cancelled);
    }
}
