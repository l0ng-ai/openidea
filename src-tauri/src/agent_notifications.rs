//! Native desktop notifications for agent attention events.
//!
//! One delivery path for local and remote agents: hooked from `agent_subscribe`.
//! Opt-in via global `[notifications].agentBackground`; suppressed while any
//! OpenIDEA window is active. Click focuses the owning window and runs
//! `agents.openTask` through the menu event seam.

use ide_agent::{AgentAttentionReason, AgentEvent};
use parking_lot::Mutex;
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::LazyLock;
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::{NotificationExt, PermissionState};

const OPEN_ACTION: &str = "agents.openTask";
const MAX_SEEN: usize = 256;
const MAX_TARGETS: usize = 64;

struct Target {
    window: String,
    project: String,
    task: String,
}

struct State {
    ready: AtomicBool,
    next_id: AtomicI32,
    /// `(scope, event_id)` recently delivered — bounded FIFO.
    seen: Mutex<VecDeque<(String, String)>>,
    seen_set: Mutex<HashSet<(String, String)>>,
    /// Native notification id → open target.
    targets: Mutex<HashMap<i32, Target>>,
}

impl State {
    fn new() -> Self {
        Self {
            ready: AtomicBool::new(false),
            next_id: AtomicI32::new(1),
            seen: Mutex::new(VecDeque::new()),
            seen_set: Mutex::new(HashSet::new()),
            targets: Mutex::new(HashMap::new()),
        }
    }

    fn remember_seen(&self, scope: &str, event_id: &str) -> bool {
        let key = (scope.to_owned(), event_id.to_owned());
        let mut set = self.seen_set.lock();
        if !set.insert(key.clone()) {
            return false;
        }
        let mut seen = self.seen.lock();
        seen.push_back(key);
        while seen.len() > MAX_SEEN {
            if let Some(old) = seen.pop_front() {
                set.remove(&old);
            }
        }
        true
    }

    fn put_target(&self, id: i32, target: Target) {
        let mut targets = self.targets.lock();
        targets.insert(id, target);
        while targets.len() > MAX_TARGETS {
            let oldest = targets.keys().copied().min();
            if let Some(oldest) = oldest {
                targets.remove(&oldest);
            } else {
                break;
            }
        }
    }

    fn take_target(&self, id: i32) -> Option<Target> {
        self.targets.lock().remove(&id)
    }

    fn clear_scope(&self, window: &str) {
        self.targets.lock().retain(|_, t| t.window != window);
        let mut set = self.seen_set.lock();
        let mut seen = self.seen.lock();
        seen.retain(|(s, id)| {
            if s == window {
                set.remove(&(s.clone(), id.clone()));
                false
            } else {
                true
            }
        });
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
        tracing::warn!("agent notifications: cannot register action handler: {e}");
        STATE.ready.store(false, Ordering::Release);
    }
}

/// Project closed or window replaced: drop bookkeeping for that owner.
pub fn clear_window(window: &str) {
    STATE.clear_scope(window);
}

/// Called from the `agent_subscribe` forwarder for every event.
pub fn on_event(app: &AppHandle, window: &str, event: &AgentEvent) {
    let AgentEvent::Attention { task, event_id, reason } = event else { return };
    let owner = crate::state::AppState::owner_window(window).to_owned();
    if !STATE.remember_seen(&owner, event_id) {
        return;
    }
    let app = app.clone();
    let task = task.clone();
    let reason = *reason;
    let _ = app.clone().run_on_main_thread(move || deliver(&app, &owner, &task, reason));
}

fn deliver(app: &AppHandle, window: &str, task: &str, reason: AgentAttentionReason) {
    let Some(state) = app.try_state::<crate::state::AppState>() else { return };
    let settings = state.host.global_settings.effective();
    if !settings.notifications.agent_background {
        return;
    }
    if crate::application_focus::application_active(app) {
        return;
    }
    let project = match state.host.project(window) {
        Ok(p) => p.root.to_string_lossy().into_owned(),
        Err(_) => return,
    };
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
    STATE.put_target(id, Target { window: window.to_owned(), project, task: task.to_owned() });

    let locale = settings.appearance.locale.as_str();
    let body = body_for(reason, locale);
    let mut builder = app.notification().builder().id(id).title("OpenIDEA").body(body);
    if settings.notifications.sound {
        builder = builder.sound("default");
    }
    if let Err(e) = builder.show() {
        tracing::debug!("agent notification not shown: {e}");
        STATE.take_target(id);
    }
}

fn activate(app: &AppHandle, id: i32) {
    let Some(target) = STATE.take_target(id) else { return };
    let app = app.clone();
    let _ = app.clone().run_on_main_thread(move || {
        let Some(state) = app.try_state::<crate::state::AppState>() else { return };
        let Ok(project) = state.host.project(&target.window) else { return };
        if project.root.to_string_lossy() != target.project {
            return;
        }
        let Some(window) = app.get_webview_window(&target.window) else { return };
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        let route = crate::menu::MenuRoute { action: OPEN_ACTION.into(), arg: Some(target.task) };
        if let Err(e) = app.emit_to(&target.window, crate::menu::MENU_EVENT, &route) {
            tracing::warn!("agent notification click: {e}");
        }
    });
}

fn body_for(reason: AgentAttentionReason, locale: &str) -> &'static str {
    let zh = locale.starts_with("zh");
    match (reason, zh) {
        (AgentAttentionReason::Finished, false) => "Agent task finished.",
        (AgentAttentionReason::Finished, true) => "智能体任务已完成。",
        (AgentAttentionReason::Input, false) => "Agent task needs your input.",
        (AgentAttentionReason::Input, true) => "智能体任务需要你的输入。",
        (AgentAttentionReason::Failed, false) => "Agent task failed.",
        (AgentAttentionReason::Failed, true) => "智能体任务失败。",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ide_core::settings::NotificationSettings;

    #[test]
    fn settings_default_off() {
        assert!(!NotificationSettings::default().agent_background);
    }

    #[test]
    fn dedupe_by_scope_and_event_id() {
        let state = State::new();
        assert!(state.remember_seen("w1", "a:finished:1"));
        assert!(!state.remember_seen("w1", "a:finished:1"));
        assert!(state.remember_seen("w2", "a:finished:1"));
        assert!(state.remember_seen("w1", "a:finished:2"));
    }

    #[test]
    fn clear_window_drops_targets_and_seen() {
        let state = State::new();
        assert!(state.remember_seen("w1", "e1"));
        state.put_target(1, Target { window: "w1".into(), project: "/p".into(), task: "t".into() });
        state.put_target(2, Target { window: "w2".into(), project: "/q".into(), task: "u".into() });
        state.clear_scope("w1");
        assert!(state.take_target(1).is_none());
        assert!(state.take_target(2).is_some());
        assert!(state.remember_seen("w1", "e1"));
    }

    #[test]
    fn body_is_privacy_safe() {
        assert_eq!(body_for(AgentAttentionReason::Input, "en"), "Agent task needs your input.");
        assert!(!body_for(AgentAttentionReason::Failed, "en").contains('/'));
    }
}
