//! Desktop adapter for application-drawn project tabs. Each member retains its WebView and services.
use crate::{
    state::AppState,
    windows::{self, WindowsState},
};
use ide_core::{IdeError, IdeEvent, IdeResult};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use tauri::{AppHandle, Manager, WebviewWindow};

#[cfg(not(target_os = "macos"))]
mod frames;

type Group = ide_workspace::window_groups::WindowGroup;

#[derive(Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WindowTab {
    pub label: String,
    pub name: String,
    pub root: Option<ide_core::IpcPath>,
    pub current: bool,
}

pub fn current(app: &AppHandle, caller: &str) -> Vec<WindowTab> {
    let state = app.state::<WindowsState>();
    let Some(group) = state.groups.lock().group(caller).cloned() else { return Vec::new() };
    let host = app.state::<AppState>();
    group
        .members
        .iter()
        .filter_map(|label| {
            let window = app.get_webview_window(label)?;
            let project = host.project(label).ok();
            let name = project.as_ref().map(|p| ide_host::ops::project::info(p).display_name).unwrap_or_else(|| {
                // Taken its launch but not finished opening: name the tab after that project.
                state
                    .pending(label)
                    .and_then(|launch| launch.project)
                    .and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
                    .unwrap_or_else(|| window.title().unwrap_or_default())
            });
            Some(WindowTab {
                label: label.clone(),
                name,
                root: project.map(|p| p.root.clone().into()),
                current: label == caller,
            })
        })
        .collect()
}

fn changed(app: &AppHandle) {
    app.state::<AppState>().sink.emit(IdeEvent::WindowGroupsChanged);
}

/// A presented group window moved or resized. Native tabs (macOS) share one frame already.
pub fn frame_changed(app: &AppHandle, label: &str) {
    #[cfg(not(target_os = "macos"))]
    frames::frame_changed(app, label);
    #[cfg(target_os = "macos")]
    let _ = (app, label);
}

/// Fullscreen for `window`. On macOS a group is one native tab group, which AppKit takes into a
/// fullscreen Space as a whole.
pub fn toggle_fullscreen(window: &WebviewWindow) -> IdeResult<bool> {
    let err = |e: tauri::Error| IdeError::internal(e.to_string());
    let on = !window.is_fullscreen().map_err(err)?;
    window.set_fullscreen(on).map_err(err)?;
    Ok(on)
}

pub fn select(app: &AppHandle, caller: &str, target: &str) -> IdeResult<()> {
    let to = app.get_webview_window(target).ok_or_else(|| IdeError::not_found("Window closed"))?;
    let state = app.state::<WindowsState>();
    let previous = state.groups.lock().select(caller, target)?;
    #[cfg(target_os = "macos")]
    let result = native_select(app, &previous, &to);
    #[cfg(not(target_os = "macos"))]
    let result = frames::present(app, &previous, target, &to);
    if result.is_err() {
        let _ = state.groups.lock().select(caller, &previous.selected);
        #[cfg(target_os = "macos")]
        if let Some(window) = app.get_webview_window(&previous.selected) {
            let _ = native_select(app, &previous, &window);
        }
        #[cfg(not(target_os = "macos"))]
        frames::restore_selection(app, &previous);
    } else if !state.quitting() {
        #[cfg(not(target_os = "macos"))]
        frames::selected(app, target);
    }
    changed(app);
    // A tab shown in a fullscreen group is in full screen too; its title bar asks again.
    app.state::<AppState>().sink.emit(IdeEvent::WindowFullscreenChanged);
    result
}

/// Shows `to` as the selected tab of the group's native tab group.
#[cfg(target_os = "macos")]
fn native_select(app: &AppHandle, group: &Group, to: &WebviewWindow) -> IdeResult<()> {
    let members = group.members.iter().filter_map(|m| app.get_webview_window(m)).collect();
    let anchor = app.get_webview_window(&group.selected).unwrap_or_else(|| to.clone());
    to.unminimize().map_err(|e| IdeError::internal(e.to_string()))?;
    crate::macos::sync_tab_group(members, &anchor, to).map_err(|e| IdeError::internal(e.to_string()))
}

pub fn join(app: &AppHandle, anchor: &str, new_window: &str) -> IdeResult<()> {
    let state = app.state::<WindowsState>();
    state.groups.lock().join(anchor, new_window)?;
    select(app, anchor, new_window)
}

pub fn merge(app: &AppHandle, caller: &str) -> IdeResult<()> {
    let members = windows::project_window_labels(app)
        .into_iter()
        .filter(|label| app.state::<AppState>().project(label).is_ok_and(|p| !p.light))
        .collect::<Vec<_>>();
    if members.len() < 2 || !members.iter().any(|label| label == caller) {
        return Err(IdeError::invalid("Open at least two project windows to create a window group"));
    }
    // Native fullscreen puts each window in a separate Space; leave it before grouping.
    for label in &members {
        if let Some(window) = app.get_webview_window(label) {
            window.set_fullscreen(false).map_err(|e| IdeError::internal(e.to_string()))?;
        }
    }
    app.state::<WindowsState>().groups.lock().merge(members, caller)?;
    select(app, caller, caller)
}

pub fn detach(app: &AppHandle, caller: &str) -> IdeResult<()> {
    let err = |e: tauri::Error| IdeError::internal(e.to_string());
    let state = app.state::<WindowsState>();
    let Some(next) = state.groups.lock().detach(caller) else {
        changed(app);
        return Ok(());
    };
    let window = app.get_webview_window(caller);
    // A tab moved out of a fullscreen group stays fullscreen in a Space of its own.
    #[cfg(target_os = "macos")]
    if let Some(window) = &window {
        crate::macos::move_tab_to_new_window(window).map_err(err)?;
    }
    if let Some(next) = app.get_webview_window(&next) {
        #[cfg(target_os = "macos")]
        if state.groups.lock().group(next.label()).is_some() {
            select(app, next.label(), next.label())?;
        }
        #[cfg(not(target_os = "macos"))]
        next.show().map_err(err)?;
    }
    if let Some(window) = window {
        if !window.is_fullscreen().map_err(err)?
            && let Ok(position) = window.outer_position()
        {
            let _ = window.set_position(tauri::PhysicalPosition::new(position.x + 32, position.y + 32));
        }
        windows::focus(&window);
    }
    changed(app);
    Ok(())
}

pub fn destroyed(app: &AppHandle, caller: &str) {
    let Some(state) = app.try_state::<WindowsState>() else { return };
    let next = state.groups.lock().detach(caller);
    let batch_done_keep = {
        let mut batch = state.tab_closes.lock();
        if let Some(b) = batch.as_mut()
            && b.pending.remove(caller)
            && b.pending.is_empty()
        {
            Some(batch.take().unwrap().keep)
        } else {
            None
        }
    };
    let next_closing = next.as_deref().is_some_and(|label| state.is_closing(label));
    let more_closing = state.has_other_pending_closes(caller);
    if !state.quitting() {
        if let Some(keep) = batch_done_keep {
            if let Some(window) = app.get_webview_window(&keep)
                && !window.is_focused().unwrap_or(false)
            {
                windows::focus(&window);
            }
        } else if !next_closing && let Some(window) = next.as_deref().and_then(|label| app.get_webview_window(label)) {
            windows::focus(&window);
        }
        if !more_closing {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let _ = persist(&app).await;
            });
        }
    }
    if !next_closing || !more_closing {
        changed(app);
    }
}

/// Tabs closing together in a batch (Close Other / Left / Right Tabs), keeping `keep`.
pub struct TabCloses {
    pub(crate) keep: String,
    pub(crate) pending: HashSet<String>,
}

impl TabCloses {
    pub(crate) fn contains(&self, label: &str) -> bool {
        self.pending.contains(label)
    }

    pub(crate) fn has_other(&self, exclude: &str) -> bool {
        self.pending.iter().any(|l| l != exclude)
    }
}

/// Closes `labels` in parallel without flipping tabs; any tab that needs a confirmation prompt
/// acquires the prompt turn and raises itself, and `keep` stays selected when the batch finishes.
pub fn close_tabs(app: &AppHandle, caller: &str, keep: &str, labels: Vec<String>) -> IdeResult<()> {
    let state = app.state::<WindowsState>();
    let members = state
        .groups
        .lock()
        .group(caller)
        .map(|g| g.members.clone())
        .ok_or_else(|| IdeError::not_found("This window is not grouped"))?;
    if !members.iter().any(|m| m == keep) {
        return Err(IdeError::invalid("The window is not in this group"));
    }
    let targets: Vec<String> = members.into_iter().filter(|m| m != keep && labels.contains(m)).collect();
    if targets.is_empty() {
        return Ok(());
    }
    let pending: HashSet<String> = targets.iter().cloned().collect();
    *state.tab_closes.lock() = Some(TabCloses { keep: keep.to_owned(), pending });
    // Pre-register every target before invoking `close()` so early responders see the full cohort.
    for label in &targets {
        state.close_requested(label);
    }
    let mut any_sent = false;
    for label in targets {
        if let Some(window) = app.get_webview_window(&label)
            && window.close().is_ok()
        {
            any_sent = true;
            continue;
        }
        if let Some(b) = state.tab_closes.lock().as_mut() {
            b.pending.remove(&label);
        }
        state.close_settled(&label);
    }
    if !any_sent {
        *state.tab_closes.lock() = None;
        if let Some(window) = app.get_webview_window(keep) {
            windows::focus(&window);
        }
    }
    Ok(())
}

/// The closing tab stayed open (either its prompt was cancelled or it returned to Welcome).
pub fn cancel_close(app: &AppHandle, caller: &str) {
    let state = app.state::<WindowsState>();
    let cancelled_batch = {
        let mut batch = state.tab_closes.lock();
        if batch.as_ref().is_some_and(|b| b.pending.contains(caller)) { batch.take() } else { None }
    };
    if let Some(batch) = cancelled_batch {
        // A vetoed Close Other/Left/Right Tabs leaves the remaining tabs open too.
        state.abort_batch(batch.pending.into_iter().filter(|l| l != caller));
        state.close_settled(caller);
        return;
    }
    state.close_settled(caller);
    // For a red-button group close where this tab stayed open (e.g. returned to Welcome),
    // select it so closing siblings disappear behind it without flashing.
    if state.groups.lock().group(caller).is_some()
        && let Some(window) = app.get_webview_window(caller)
    {
        windows::focus(&window);
    }
    if !state.has_other_pending_closes(caller) && !state.quitting() {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let _ = persist(&app).await;
        });
    }
}

/// Waits for the caller's interactive prompt turn in a parallel batch close and brings it forward.
/// Returns `false` if the batch was cancelled while waiting (the caller should stay open quietly).
pub async fn begin_prompt(app: &AppHandle, window: &WebviewWindow) -> bool {
    let label = window.label();
    let state = app.state::<WindowsState>();
    loop {
        let notified = state.close_notify.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();

        match state.try_acquire_prompt(label) {
            Ok(true) => {
                windows::focus(window);
                return true;
            }
            Ok(false) => {
                notified.await;
            }
            Err(()) => {
                state.take_aborted(label);
                return false;
            }
        }
    }
}

pub fn end_prompt(app: &AppHandle, caller: &str) {
    app.state::<WindowsState>().release_prompt(caller);
}

/// Coordinates the final hide/destroy step across windows closing together.
/// Returns `false` if the batch was cancelled while waiting (the caller must stay open).
pub async fn ready_to_close(app: &AppHandle, window: &WebviewWindow) -> bool {
    let label = window.label();
    let state = app.state::<WindowsState>();
    if !state.mark_ready(label) {
        return false;
    }

    const BARRIER_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(3);
    const POLL_STEP: std::time::Duration = std::time::Duration::from_millis(250);
    let mut waited_idle = std::time::Duration::ZERO;
    let mut last_tick = std::time::Instant::now();

    loop {
        let notified = state.close_notify.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();

        if state.take_aborted(label) {
            return false;
        }

        let (cohort, keep_label) = close_cohort(app, &state, label);
        let any_undecided =
            cohort.iter().any(|peer| peer != label && app.get_webview_window(peer).is_some() && !state.is_ready(peer));

        if !any_undecided {
            finish_cohort_visuals(app, &state, label, &cohort, keep_label.as_deref());
            state.close_notify.notify_waiters();
            return true;
        }

        match tokio::time::timeout(POLL_STEP, notified).await {
            Ok(()) => {
                waited_idle = std::time::Duration::ZERO;
                last_tick = std::time::Instant::now();
            }
            Err(_) => {
                // Never time out while another tab is waiting on the user's answer to a dialog.
                if state.has_prompt_holder() {
                    waited_idle = std::time::Duration::ZERO;
                } else {
                    waited_idle += last_tick.elapsed();
                    if waited_idle >= BARRIER_TIMEOUT {
                        let single = vec![label.to_owned()];
                        if !state.claim_hide(&single).is_empty() && state.groups.lock().group(label).is_none() {
                            windows::hide_windows(vec![window.clone()]);
                        }
                        return true;
                    }
                }
                last_tick = std::time::Instant::now();
            }
        }
    }
}

fn close_cohort(app: &AppHandle, state: &WindowsState, label: &str) -> (Vec<String>, Option<String>) {
    if state.quitting() {
        let pending = state.pending_closes();
        let mut cohort: Vec<String> = windows::project_window_labels(app)
            .into_iter()
            .filter(|l| l == label || pending.iter().any(|p| p == l))
            .collect();
        if !cohort.iter().any(|l| l == label) {
            cohort.push(label.to_owned());
        }
        return (cohort, None);
    }
    if let Some((keep, pending)) = state
        .tab_closes
        .lock()
        .as_ref()
        .filter(|b| b.pending.contains(label))
        .map(|b| (b.keep.clone(), b.pending.iter().cloned().collect::<Vec<_>>()))
    {
        return (pending, Some(keep));
    }
    let pending = state.pending_closes();
    let group_members = state.groups.lock().group(label).map(|g| g.members.clone());
    if let Some(members) = group_members {
        let mut cohort: Vec<String> =
            members.into_iter().filter(|m| m == label || pending.iter().any(|p| p == m)).collect();
        if !cohort.iter().any(|l| l == label) {
            cohort.push(label.to_owned());
        }
        return (cohort, None);
    }
    (vec![label.to_owned()], None)
}

/// Applies the visual transition once every peer in `cohort` is ready to close:
/// - Whole closing window or whole closing tab group (or quit): hide all of them in a single frame.
/// - Partial tab group close (Close Other Tabs, single tab close, or keeper returning to Welcome):
///   ensure a surviving tab is selected so the closing tabs tear down invisibly behind it.
fn finish_cohort_visuals(
    app: &AppHandle,
    state: &WindowsState,
    label: &str,
    cohort: &[String],
    keep_label: Option<&str>,
) {
    if state.quitting() {
        let to_hide = state.claim_hide(cohort);
        let windows: Vec<_> = to_hide.into_iter().filter_map(|l| app.get_webview_window(&l)).collect();
        windows::hide_windows(windows);
        return;
    }
    let group_snapshot = state.groups.lock().group(label).cloned();
    if let Some(group) = group_snapshot {
        let cohort_set: HashSet<&str> = cohort.iter().map(String::as_str).collect();
        let all_closing = group.members.iter().all(|m| cohort_set.contains(m.as_str()));
        if all_closing {
            let to_hide = state.claim_hide(&group.members);
            let windows: Vec<_> = to_hide.into_iter().filter_map(|l| app.get_webview_window(&l)).collect();
            windows::hide_windows(windows);
        } else {
            let survivor = keep_label
                .filter(|k| !cohort_set.contains(*k))
                .map(str::to_owned)
                .or_else(|| group.members.iter().find(|m| !cohort_set.contains(m.as_str())).cloned());
            // Only switch tabs if the currently visible tab is one of the closing ones.
            if cohort_set.contains(group.selected.as_str())
                && let Some(survivor) = survivor
                && !state.claim_hide(cohort).is_empty()
                && let Some(window) = app.get_webview_window(&survivor)
            {
                windows::focus(&window);
            }
        }
    } else {
        let to_hide = state.claim_hide(cohort);
        let windows: Vec<_> = to_hide.into_iter().filter_map(|l| app.get_webview_window(&l)).collect();
        windows::hide_windows(windows);
    }
}

/// Window labels in creation order: `main`, then `project-1`, `project-2`, ….
fn labels_in_order(app: &AppHandle) -> Vec<String> {
    let mut labels: Vec<String> = app.webview_windows().into_keys().collect();
    labels.sort_by_key(|l| (l != "main", l.rsplit('-').next().and_then(|n| n.parse::<u32>().ok()), l.clone()));
    labels
}

/// Saves the open project windows (groups and single windows) for "Reopen projects on startup".
/// Nothing is written while quitting, so the windows open at quit are the ones reopened.
pub async fn persist(app: &AppHandle) -> IdeResult<()> {
    let state = app.state::<WindowsState>();
    let mut previous = state.groups_persist.lock().await;
    if state.quitting() {
        return Ok(());
    }
    let host = app.state::<AppState>();
    let path = host.config_dir.join("window-groups.json");
    if previous.is_none() {
        *previous = Some(read_session(path.clone()).await);
    }
    let groups = state.groups.lock().groups().to_vec();
    let windows = labels_in_order(app);
    let project_of = |label: &str| {
        if let Some(path) = windows::window_project_path(app, label) {
            return Some(path);
        }
        // Taken its launch, not finished opening: keep the remote location or local folder.
        state.pending(label).and_then(|launch| {
            launch
                .remote
                .as_ref()
                .map(|remote| PathBuf::from(crate::remote_dev::remote_location(&remote.target, &remote.path)))
                .or_else(|| launch.project.clone().map(Into::into))
        })
    };
    let Some(saved) = ide_workspace::window_groups::session(&groups, &windows, project_of) else {
        return Ok(());
    };
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = serde_json::to_vec(&saved).map_err(|e| IdeError::internal(e.to_string()))?;
        ide_vfs::write_atomic(&path, &bytes).map(|_| ())
    })
    .await
    .map_err(|e| IdeError::internal(e.to_string()))?
}

/// The saved session; empty when there is none or it can't be read.
async fn read_session(path: PathBuf) -> Vec<ide_workspace::window_groups::SavedWindows> {
    let read = tauri::async_runtime::spawn_blocking(move || match std::fs::read(&path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| format!("{}: {e}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(format!("{}: {e}", path.display())),
    })
    .await
    .map_err(|e| e.to_string())
    .and_then(|r| r);
    read.unwrap_or_else(|e| {
        tracing::warn!("cannot read the saved windows: {e}");
        Vec::new()
    })
}

pub async fn restore(app: &AppHandle, caller: &str) -> IdeResult<()> {
    if caller != "main" {
        return Ok(());
    }
    let state = app.state::<WindowsState>();
    let host = app.state::<AppState>();
    // A remote window has no local project. Leave the flag clear until this window has
    // one, so the call that runs once the connection is up can still restore its siblings.
    let Some(root) = windows::window_project_path(app, caller) else {
        return Ok(());
    };
    let settings = ide_host::ops::project::settings_get(&host.host, caller);
    if !settings.general.reopen_last_project || state.groups_restored.swap(true, Ordering::SeqCst) {
        return Ok(());
    }
    let saved = {
        let mut previous = state.groups_persist.lock().await;
        if previous.is_none() {
            *previous = Some(read_session(host.config_dir.join("window-groups.json")).await);
        }
        previous.clone().unwrap_or_default()
    };
    // The caller's own group first (it already shows one of its projects), then every other
    // group and single window that was open at quit. Missing folders are skipped.
    let owns = |group: &ide_workspace::window_groups::SavedWindows| {
        group.projects.iter().any(|path| windows::same_saved_project(path, &root))
    };
    let order = saved.iter().filter(|group| owns(group)).chain(saved.iter().filter(|group| !owns(group)));
    for group in order {
        let mut labels = Vec::new();
        let mut selected = None;
        for path in &group.projects {
            let label = if windows::same_saved_project(path, &root) {
                Some(caller.to_owned())
            } else {
                match windows::reopen_saved_window(app, path) {
                    Ok(Some(w)) => Some(w.label().to_owned()),
                    Ok(None) => None,
                    Err(e) => {
                        tracing::warn!("cannot reopen {}: {e}", path.display());
                        None
                    }
                }
            };
            if let Some(label) = label {
                if group.projects.get(group.selected) == Some(path) {
                    selected = Some(label.clone());
                }
                labels.push(label);
            }
        }
        if labels.len() > 1 {
            let selected = selected.unwrap_or_else(|| labels[0].clone());
            state.groups.lock().merge(labels, &selected)?;
            select(app, &selected, &selected)?;
        }
    }
    Ok(())
}
