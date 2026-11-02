//! macOS window tab preferences, applied to application-drawn project tabs.
use crate::windows::{Launch, WindowsState};
use ide_core::{IdeError, IdeResult};
use ide_workspace::window_groups::{TabbingPreference, should_group_new_project};
use objc2::MainThreadMarker;
use objc2_app_kit::{NSWindow, NSWindowUserTabbingPreference};
use tauri::{AppHandle, Manager, WebviewWindow};

static GROUPED_WINDOW_LABELS: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());

pub fn set_grouped_window_restore(label: &str, grouped: bool) {
    let mut labels = GROUPED_WINDOW_LABELS.lock().unwrap();
    labels.retain(|existing| existing != label);
    if grouped {
        labels.push(label.to_owned());
    }
}

pub fn restore_independent_window(label: &str) -> bool {
    !GROUPED_WINDOW_LABELS.lock().unwrap().iter().any(|existing| existing == label)
}

fn observe_tab_order(app: &AppHandle) {
    use objc2::rc::Retained;
    use objc2::runtime::ProtocolObject;
    use objc2_app_kit::NSApplicationDidUpdateNotification;
    use objc2_foundation::{NSNotificationCenter, NSObjectProtocol};
    thread_local! {
        static OBSERVER: std::cell::RefCell<Option<Retained<ProtocolObject<dyn NSObjectProtocol>>>> = const { std::cell::RefCell::new(None) };
    }
    OBSERVER.with_borrow_mut(|observer| {
        if observer.is_some() {
            return;
        }
        let handle = app.clone();
        let block = block2::RcBlock::new(move |_| {
            let _ = catch_tab_exception(|| {
                sync_tab_order(&handle);
                Ok(())
            });
        });
        *observer = Some(unsafe {
            NSNotificationCenter::defaultCenter().addObserverForName_object_queue_usingBlock(
                Some(NSApplicationDidUpdateNotification),
                None,
                None,
                &block,
            )
        });
    });
}

fn sync_tab_titles(app: &AppHandle, caller: &str, force: bool) {
    for tab in crate::window_groups::current(app, caller) {
        let Some(window) = app.get_webview_window(&tab.label) else { continue };
        let Ok(pointer) = window.ns_window() else { continue };
        unsafe {
            let native: *mut objc2::runtime::AnyObject = objc2::msg_send![pointer.cast::<NSWindow>(), tab];
            if native.is_null() {
                continue;
            }
            let title: objc2::rc::Retained<objc2_foundation::NSString> = objc2::msg_send![native, title];
            let expected = objc2_foundation::NSString::from_str(&tab.name);
            if force || title != expected {
                let _: () = objc2::msg_send![native, setTitle: &*expected];
            }
        }
    }
}

fn sync_tab_order(app: &AppHandle) {
    let state = app.state::<WindowsState>();
    let groups = state.groups.lock().groups().to_vec();
    let mut changed = false;
    for snapshot in groups {
        let windows: Vec<_> = snapshot
            .members
            .iter()
            .filter_map(|label| {
                let window = app.get_webview_window(label)?;
                Some((window.ns_window().ok()? as usize, label.clone()))
            })
            .collect();
        if windows.len() != snapshot.members.len() {
            continue;
        }
        let (ordered, selected) = unsafe {
            let anchor = windows[0].0 as *mut NSWindow;
            let group: *mut objc2::runtime::AnyObject = objc2::msg_send![anchor, tabGroup];
            if group.is_null() {
                continue;
            }
            let native: *mut objc2::runtime::AnyObject = objc2::msg_send![group, windows];
            let count: usize = objc2::msg_send![native, count];
            if count != windows.len() {
                continue;
            }
            let selected_window: *mut NSWindow = objc2::msg_send![group, selectedWindow];
            let Some(selected) = windows
                .iter()
                .find(|(pointer, _)| *pointer == selected_window as usize)
                .map(|(_, label)| label.clone())
            else {
                continue;
            };
            let ordered = (0..count)
                .filter_map(|index| {
                    let window: *mut NSWindow = objc2::msg_send![native, objectAtIndex: index];
                    windows.iter().find(|(pointer, _)| *pointer == window as usize).map(|(_, label)| label.clone())
                })
                .collect::<Vec<_>>();
            (ordered, selected)
        };
        sync_tab_titles(app, &snapshot.selected, ordered != snapshot.members);
        if ordered != snapshot.members || selected != snapshot.selected {
            let mut model = state.groups.lock();
            if model.group(&snapshot.selected) == Some(&snapshot) && model.reorder(&snapshot.selected, ordered).is_ok()
            {
                let _ = model.select(&snapshot.selected, &selected);
                changed = true;
            }
        }
    }
    if changed {
        crate::window_groups::changed(app);
        let handle = app.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(error) = crate::window_groups::persist(&handle).await {
                tracing::warn!(?error, "Cannot persist native tab order");
            }
        });
    }
}

pub fn reorder_project_tabs(app: &AppHandle, caller: &str, labels: Vec<String>) -> IdeResult<()> {
    let handle = app.clone();
    let caller = caller.to_owned();
    on_main_thread(app, move || {
        sync_tab_order(&handle);
        let state = handle.state::<WindowsState>();
        let previous = state
            .groups
            .lock()
            .group(&caller)
            .cloned()
            .ok_or_else(|| IdeError::not_found("This window is not grouped"))?;
        state.groups.lock().reorder(&caller, labels.clone())?;
        if let Err(error) = update_project_tabs(&handle, &labels, &previous.selected, true) {
            let _ = state.groups.lock().reorder(&caller, previous.members.clone());
            return Err(error);
        }
        crate::window_groups::changed(&handle);
        Ok(())
    })
}

pub fn select_project_tab(app: &AppHandle, members: &[String], selected: &str) -> IdeResult<()> {
    update_project_tabs(app, members, selected, false)
}

fn update_project_tabs(app: &AppHandle, members: &[String], selected: &str, reorder: bool) -> IdeResult<()> {
    let handle = app.clone();
    let members = members.to_vec();
    let selected = selected.to_owned();
    on_main_thread(app, move || unsafe {
        observe_tab_order(&handle);
        let windows = members
            .iter()
            .map(|label| {
                let window = handle.get_webview_window(label).ok_or_else(|| IdeError::not_found("Window closed"))?;
                let pointer = window.ns_window().map_err(|e| IdeError::internal(e.to_string()))? as usize;
                Ok((pointer, label == &selected))
            })
            .collect::<IdeResult<Vec<_>>>()?;
        let mut anchor = windows.first().ok_or_else(|| IdeError::invalid("Empty window group"))?.0 as *mut NSWindow;
        for &(pointer, _) in &windows {
            let window = pointer as *mut NSWindow;
            let visible: bool = objc2::msg_send![window, isVisible];
            if visible {
                anchor = window;
                break;
            }
        }
        let existing: *mut objc2::runtime::AnyObject = objc2::msg_send![anchor, tabGroup];
        if !existing.is_null() {
            let current: *mut NSWindow = objc2::msg_send![existing, selectedWindow];
            if !current.is_null() {
                anchor = current;
            }
        }
        for &(pointer, _) in &windows {
            let group: *mut objc2::runtime::AnyObject = objc2::msg_send![anchor, tabGroup];
            let window = pointer as *mut NSWindow;
            if window == anchor {
                continue;
            }
            let other: *mut objc2::runtime::AnyObject = objc2::msg_send![window, tabGroup];
            if group.is_null() || other != group {
                native_tab_operation(
                    &format!("addTabbedWindow anchor={anchor:p} window={window:p} members={members:?}"),
                    || {
                        let _: () = objc2::msg_send![anchor, addTabbedWindow: window, ordered: 1isize];
                    },
                )?;
            }
        }
        let group: *mut objc2::runtime::AnyObject = objc2::msg_send![anchor, tabGroup];
        if !group.is_null() {
            let selected_index = windows
                .iter()
                .position(|(_, current)| *current)
                .ok_or_else(|| IdeError::invalid("Selected window is not in the group"))?;
            let reorder_indices = (0..selected_index).chain((selected_index + 1..windows.len()).rev());
            for index in reorder_indices.filter(|_| reorder) {
                let pointer = windows[index].0;
                let group: *mut objc2::runtime::AnyObject = objc2::msg_send![anchor, tabGroup];
                if group.is_null() {
                    return Err(IdeError::internal("Native window group disappeared during reorder"));
                }
                let native: *mut objc2::runtime::AnyObject = objc2::msg_send![group, windows];
                let current: *mut NSWindow = objc2::msg_send![native, objectAtIndex: index];
                let window = pointer as *mut NSWindow;
                if current != window {
                    let count: usize = objc2::msg_send![native, count];
                    let source = (0..count)
                        .find(|&position| {
                            let candidate: *mut NSWindow = objc2::msg_send![native, objectAtIndex: position];
                            candidate == window
                        })
                        .ok_or_else(|| IdeError::internal("Window missing from native tab group"))?;
                    let order = if source < index { 1isize } else { -1isize };
                    native_tab_operation(&format!("moveTabbedWindow label={} index={index}", members[index]), || {
                        let _: () = objc2::msg_send![group, removeWindow: window];
                        let _: () = objc2::msg_send![current, addTabbedWindow: window, ordered: order];
                    })?;
                }
            }
            if let Some(&(pointer, _)) = windows.iter().find(|(_, current)| *current) {
                let window = pointer as *mut NSWindow;
                let group: *mut objc2::runtime::AnyObject = objc2::msg_send![window, tabGroup];
                if group.is_null() {
                    return Err(IdeError::internal("Selected window lost its native tab group"));
                }
                native_tab_operation(&format!("setSelectedWindow label={selected}"), || {
                    let _: () = objc2::msg_send![group, setSelectedWindow: window];
                })?;
                let minimized: bool = objc2::msg_send![window, isMiniaturized];
                if minimized {
                    let _: () = objc2::msg_send![window, deminiaturize: std::ptr::null::<objc2::runtime::AnyObject>()];
                }
                native_tab_operation(&format!("makeKeyAndOrderFront label={selected}"), || {
                    let _: () =
                        objc2::msg_send![window, makeKeyAndOrderFront: std::ptr::null::<objc2::runtime::AnyObject>()];
                })?;
            }
        } else {
            return Err(IdeError::internal("Cannot create native window group"));
        }
        sync_tab_titles(&handle, &selected, true);
        sync_tab_order(&handle);
        Ok(())
    })
}

pub fn detach_project_tab(window: &WebviewWindow) -> IdeResult<()> {
    let app = window.app_handle().clone();
    let window = window.clone();
    on_main_thread(&app, move || unsafe {
        let pointer = window.ns_window().map_err(|e| IdeError::internal(e.to_string()))?;
        let window = pointer.cast::<NSWindow>();
        let group: *mut objc2::runtime::AnyObject = objc2::msg_send![window, tabGroup];
        if !group.is_null() {
            let _: () = objc2::msg_send![group, removeWindow: window];
        }
        Ok(())
    })
}

fn native_tab_operation(operation: &str, action: impl FnOnce()) -> IdeResult<()> {
    objc2::exception::catch(std::panic::AssertUnwindSafe(action)).map_err(|exception| {
        let message = format!("Native project tab operation failed: operation={operation}: {exception:?}");
        tracing::error!("{message}");
        IdeError::internal(message)
    })
}

fn catch_tab_exception(action: impl FnOnce() -> IdeResult<()>) -> IdeResult<()> {
    objc2::exception::catch(std::panic::AssertUnwindSafe(action)).unwrap_or_else(|exception| {
        let message = format!("Native project tab operation failed: {exception:?}");
        tracing::error!("{message}");
        Err(IdeError::internal(message))
    })
}

fn on_main_thread(app: &AppHandle, action: impl FnOnce() -> IdeResult<()> + Send + 'static) -> IdeResult<()> {
    if MainThreadMarker::new().is_some() {
        return catch_tab_exception(action);
    }
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    app.run_on_main_thread(move || {
        let _ = sender.send(catch_tab_exception(action));
    })
    .map_err(|e| IdeError::internal(e.to_string()))?;
    receiver.recv().map_err(|e| IdeError::internal(e.to_string()))?
}

fn tabbing_preference(app: &AppHandle) -> IdeResult<TabbingPreference> {
    fn read(mtm: MainThreadMarker) -> TabbingPreference {
        match NSWindow::userTabbingPreference(mtm) {
            NSWindowUserTabbingPreference::Always => TabbingPreference::Always,
            NSWindowUserTabbingPreference::InFullScreen => TabbingPreference::InFullScreen,
            _ => TabbingPreference::Manually,
        }
    }
    if let Some(mtm) = MainThreadMarker::new() {
        return Ok(read(mtm));
    }
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    app.run_on_main_thread(move || {
        let _ = tx.send(read(MainThreadMarker::new().expect("AppKit main thread")));
    })
    .map_err(|e| IdeError::internal(e.to_string()))?;
    rx.recv().map_err(|e| IdeError::internal(e.to_string()))
}

/// Capture before building the new window, which takes focus itself.
pub fn new_project_tab_target(app: &AppHandle, launch: &Launch) -> IdeResult<Option<WebviewWindow>> {
    let windows = app.webview_windows();
    let active = windows
        .values()
        .find(|w| w.is_focused().unwrap_or(false))
        .cloned()
        .or_else(|| app.state::<WindowsState>().last_focused().and_then(|label| windows.get(&label).cloned()));
    let active = active.and_then(|w| {
        let label = crate::windows::settings_parent(w.label()).unwrap_or(w.label());
        windows.get(label).cloned()
    });
    let active = active.filter(|w| {
        let host = app.state::<crate::state::AppState>();
        host.project(w.label()).is_ok_and(|p| !p.light) || host.remote_dev.get(w.label()).is_some()
    });
    let fullscreen = active.as_ref().is_some_and(|w| w.is_fullscreen().unwrap_or(false));
    let light_edit = launch.project.is_none() && launch.remote.is_none();
    Ok(should_group_new_project(tabbing_preference(app)?, fullscreen, active.is_some(), light_edit)
        .then_some(active)
        .flatten())
}
