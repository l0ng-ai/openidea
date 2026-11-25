//! OS notification centre toasts for in-IDE balloons while OpenIDEA is unfocused.
//!
//! Driven by `show_system_notification` from the notification store. Honour
//! global `[notifications].systemNotifications`; suppressed while any window is
//! active. Click focuses the window that raised the toast — balloon actions stay
//! in the IDE.

use parking_lot::Mutex;
use std::collections::HashMap;
use std::sync::LazyLock;
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use tauri::{AppHandle, Manager};
use tauri_plugin_notification::{NotificationExt, PermissionState};

const MAX_TARGETS: usize = 64;

struct State {
    ready: AtomicBool,
    next_id: AtomicI32,
    /// Native notification id → owning window label.
    targets: Mutex<HashMap<i32, String>>,
}

impl State {
    fn new() -> Self {
        Self { ready: AtomicBool::new(false), next_id: AtomicI32::new(1), targets: Mutex::new(HashMap::new()) }
    }

    fn put_target(&self, id: i32, window: String) {
        let mut targets = self.targets.lock();
        targets.insert(id, window);
        while targets.len() > MAX_TARGETS {
            let oldest = targets.keys().copied().min();
            if let Some(oldest) = oldest {
                targets.remove(&oldest);
            } else {
                break;
            }
        }
    }

    fn take_target(&self, id: i32) -> Option<String> {
        self.targets.lock().remove(&id)
    }

    fn clear_window(&self, window: &str) {
        self.targets.lock().retain(|_, w| w != window);
    }
}

static STATE: LazyLock<State> = LazyLock::new(State::new);

/// Registers the notification plugin's activation handler once.
pub fn init(app: &AppHandle) {
    if STATE.ready.swap(true, Ordering::AcqRel) {
        return;
    }
    let handle = app.clone();
    if let Err(e) = app.notification().on_action(move |performed| {
        if performed.action_id() != "tap" {
            return;
        }
        let Some(n) = performed.notification() else { return };
        activate(&handle, n.id());
    }) {
        tracing::warn!("system notifications: cannot register action handler: {e}");
        STATE.ready.store(false, Ordering::Release);
    }
}

/// Project closed or window replaced: drop click targets for that owner.
pub fn clear_window(window: &str) {
    STATE.clear_window(window);
}

/// Show an OS toast when the setting is on and no OpenIDEA window is focused.
pub fn show(app: &AppHandle, window: &str, title: String, body: String) {
    let owner = crate::state::AppState::owner_window(window).to_owned();
    let app = app.clone();
    let _ = app.clone().run_on_main_thread(move || deliver(&app, &owner, &title, &body));
}

fn deliver(app: &AppHandle, window: &str, title: &str, body: &str) {
    let Some(state) = app.try_state::<crate::state::AppState>() else { return };
    let settings = state.host.global_settings.effective();
    if !settings.notifications.system_notifications {
        return;
    }
    if crate::application_focus::application_active(app) {
        return;
    }
    init(app);
    if !STATE.ready.load(Ordering::Acquire) {
        return;
    }
    // Desktop always reports Granted without an OS prompt (not proof of visible delivery).
    let granted = app
        .notification()
        .permission_state()
        .ok()
        .or_else(|| app.notification().request_permission().ok())
        .is_some_and(|s| s == PermissionState::Granted);
    if !granted {
        return;
    }

    let id = STATE.next_id.fetch_add(1, Ordering::Relaxed);
    STATE.put_target(id, window.to_owned());

    let mut builder = app.notification().builder().id(id).title(title).body(body);
    if settings.notifications.sound {
        builder = builder.sound("default");
    }
    if let Err(e) = builder.show() {
        tracing::debug!("system notification not shown: {e}");
        STATE.take_target(id);
    }
}

fn activate(app: &AppHandle, id: i32) {
    let Some(window_label) = STATE.take_target(id) else { return };
    let app = app.clone();
    let _ = app.clone().run_on_main_thread(move || {
        let Some(window) = app.get_webview_window(&window_label) else { return };
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use ide_core::settings::NotificationSettings;

    #[test]
    fn settings_default_on() {
        assert!(NotificationSettings::default().system_notifications);
    }

    #[test]
    fn clear_window_drops_targets() {
        let state = State::new();
        state.put_target(1, "w1".into());
        state.put_target(2, "w2".into());
        state.clear_window("w1");
        assert!(state.take_target(1).is_none());
        assert_eq!(state.take_target(2).as_deref(), Some("w2"));
    }
}
