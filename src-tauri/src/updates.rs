//! Desktop updater coordination shared by all webviews.

use crate::commands::window::{UpdateSource, check_update, update_endpoint_env, updates_configured};
use crate::state::AppState;
use ide_core::updates::{UpdateCheck, UpdatePolicy};
use ide_core::{IdeEvent, IdeResult};
use parking_lot::Mutex;
use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};
use tokio::sync::Notify;

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

fn emit_status(state: &AppState) {
    let status = state.updates.state.lock().policy.status.clone();
    state.sink.emit(IdeEvent::UpdateStatusChanged { status });
}

fn announce_available(app: &AppHandle) {
    if !automatic_enabled(app) {
        return;
    }
    let state = app.state::<AppState>();
    let owner = {
        let mut ready = state.updates.ready.lock();
        ready.retain(|label| app.get_webview_window(label).is_some());
        let focused = crate::windows::target_window(app);
        ready_owner(focused.as_ref().map(|window| window.label()), &crate::windows::project_window_labels(app), &ready)
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
}
