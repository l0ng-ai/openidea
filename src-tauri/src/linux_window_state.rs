//! Restore GTK geometry after mapping, using the scale of the window's actual output.

mod geometry;
#[cfg(target_os = "linux")]
use geometry::*;
use tauri::utils::config::WindowConfig;

fn build_hidden(config: &mut WindowConfig) -> bool {
    std::mem::replace(&mut config.visible, false)
}

#[cfg(target_os = "linux")]
mod runtime {
    use super::*;
    use parking_lot::Mutex;
    use std::collections::HashMap;
    use tauri::{AppHandle, Listener, Manager, Window, WindowEvent, plugin::TauriPlugin};

    const FILE: &str = tauri_plugin_window_state::DEFAULT_FILENAME;

    #[derive(Default)]
    enum Phase {
        #[default]
        Mapping,
        Size {
            target: Size,
            scale: f64,
            request: u64,
        },
        Mode,
        Tracking,
    }

    #[derive(Default)]
    struct Pending {
        limits: Limits,
        configured: bool,
        presented: bool,
        presentation_request: u64,
        saved: Geometry,
        normal: Size,
        history: ModeHistory,
        restore_position: bool,
        phase: Phase,
        mode_requested: bool,
        mode_request: u64,
    }

    #[derive(Default)]
    struct Cache {
        saved: HashMap<String, Geometry>,
        windows: HashMap<String, Pending>,
        next_request: u64,
    }

    struct Frame {
        size: Size,
        scale: f64,
        mode: Mode,
        position: Option<tauri::PhysicalPosition<i32>>,
        monitors: Vec<tauri::Monitor>,
        work_area: Option<Size>,
        visible: bool,
    }

    fn frame(window: &Window) -> Option<Frame> {
        let size = window.inner_size().ok()?;
        Some(Frame {
            visible: window.is_visible().ok()?,
            size: Size(size.width, size.height),
            scale: window.scale_factor().ok()?,
            mode: Mode {
                maximized: window.is_maximized().ok()?,
                fullscreen: window.is_fullscreen().ok()?,
                minimized: window.is_minimized().ok()?,
            },
            position: window.outer_position().ok(),
            monitors: window.available_monitors().unwrap_or_default(),
            work_area: window
                .current_monitor()
                .ok()
                .flatten()
                .map(|m| Size(m.work_area().size.width, m.work_area().size.height)),
        })
    }

    fn key(label: &str) -> &str {
        if crate::windows::is_settings_window(label) { "settings" } else { label }
    }

    pub fn prepare(app: &AppHandle, config: &mut WindowConfig) -> bool {
        let hint_monitor = app.primary_monitor().ok().flatten();
        let hint_scale = hint_monitor.as_ref().map_or(1.0, |m| m.scale_factor());
        let hint_area = hint_monitor.map(|m| Size(m.work_area().size.width, m.work_area().size.height));
        let cache = app.state::<Mutex<Cache>>();
        let mut cache = cache.lock();
        let saved = cache.saved.get(key(&config.label)).cloned().unwrap_or_else(|| Geometry {
            maximized: config.maximized,
            fullscreen: config.fullscreen,
            ..Default::default()
        });
        cache.next_request += 1;
        let presentation_request = cache.next_request;
        let pending = Pending {
            presentation_request,
            limits: Limits {
                min: (config.min_width.unwrap_or(1.0), config.min_height.unwrap_or(1.0)),
                max: (config.max_width, config.max_height),
            },
            normal: Size(saved.width, saved.height),
            saved,
            restore_position: true,
            ..Default::default()
        };
        if pending.saved.width > 0 && pending.saved.height > 0 {
            // This only reduces the first-frame jump; mapped geometry is authoritative.
            let size = restore_size(pending.normal, hint_scale, pending.limits.in_work_area(hint_area, hint_scale));
            config.width = f64::from(size.0) / hint_scale;
            config.height = f64::from(size.1) / hint_scale;
        }
        cache.windows.insert(config.label.clone(), pending);
        // Establish a normal window before asking GTK to maximize or fullscreen it.
        config.maximized = false;
        config.fullscreen = false;
        build_hidden(config)
    }

    fn sample(window: &Window, allow_restore: bool, accept_constrained_size: bool) {
        let Some(frame) = frame(window) else { return };
        if !frame.visible {
            return;
        }
        let cache = window.state::<Mutex<Cache>>();
        let mut cache = cache.lock();
        cache.next_request += 1;
        let request = cache.next_request;
        let Some(pending) = cache.windows.get_mut(window.label()) else { return };
        if !pending.presented && pending.saved.width == 0 {
            pending.normal = remember_size(pending.normal, frame.size, false, frame.mode);
        }
        if !pending.configured || !pending.presented {
            return;
        }
        if !allow_restore && !matches!(pending.phase, Phase::Tracking) {
            return;
        }
        let transition = if matches!(pending.phase, Phase::Tracking) {
            pending.history.observe(frame.mode, allow_restore)
        } else {
            NormalTransition::Stable
        };
        if transition == NormalTransition::WaitForResize {
            let normal = pending.normal;
            let saved = cache.saved.entry(key(window.label()).to_owned()).or_default();
            (saved.width, saved.height) = (normal.0, normal.1);
            saved.maximized = frame.mode.maximized;
            saved.fullscreen = frame.mode.fullscreen;
            return;
        }
        if transition == NormalTransition::Restore {
            // The compositor may have changed output/DPI while maximized or minimized.
            pending.saved.set_normal_size(pending.normal);
            pending.phase = Phase::Mapping;
            pending.mode_requested = false;
        }
        let mut fit_settings = false;
        let mut position = None;
        if matches!(pending.phase, Phase::Mapping) {
            if pending.restore_position {
                pending.restore_position = false;
                let saved = &pending.saved;
                let (x, y) = if saved.maximized { (saved.prev_x, saved.prev_y) } else { (saved.x, saved.y) };
                if frame.monitors.iter().any(|m| {
                    let p = m.position();
                    let s = m.size();
                    i64::from(x) < i64::from(p.x) + i64::from(s.width)
                        && i64::from(x) + i64::from(saved.width) > i64::from(p.x)
                        && i64::from(y) < i64::from(p.y) + i64::from(s.height)
                        && i64::from(y) + i64::from(saved.height) > i64::from(p.y)
                }) {
                    position = Some(tauri::PhysicalPosition::new(x, y));
                }
            }
            if pending.saved.width > 0 && pending.saved.height > 0 {
                let target = restore_size(
                    Size(pending.saved.width, pending.saved.height),
                    frame.scale,
                    pending.limits.in_work_area(frame.work_area, frame.scale),
                );
                pending.phase = Phase::Size { target, scale: frame.scale, request: 0 };
            } else {
                pending.normal = remember_size(pending.normal, frame.size, false, frame.mode);
                pending.phase = Phase::Mode;
            }
        }
        if let Phase::Size { target, scale, request: sent } = pending.phase {
            if frame.size != target && !accept_constrained_size {
                if sent != 0 && scale == frame.scale {
                    return;
                }
                // Re-evaluate after output scale changes, rather than reusing monitor 0's scale.
                let target = restore_size(
                    Size(pending.saved.width, pending.saved.height),
                    frame.scale,
                    pending.limits.in_work_area(frame.work_area, frame.scale),
                );
                pending.phase = Phase::Size { target, scale: frame.scale, request };
                drop(cache);
                if let Some(position) = position {
                    let _ = window.set_position(position);
                }
                if let Err(error) = window.set_size(tauri::PhysicalSize::new(target.0, target.1)) {
                    tracing::warn!("cannot restore Linux window size: {error}");
                }
                settle_constrained_size(window, request);
                return;
            }
            if scale != frame.scale && !accept_constrained_size {
                pending.phase = Phase::Mapping;
                drop(cache);
                sample(window, true, false);
                return;
            }
            pending.normal = remember_size(pending.normal, frame.size, false, frame.mode);
            pending.phase = Phase::Mode;
        }
        if matches!(pending.phase, Phase::Mode) {
            let (maximize, fullscreen) = (pending.saved.maximized, pending.saved.fullscreen);
            let reached = if fullscreen { frame.mode.fullscreen } else { !maximize || frame.mode.maximized };
            let action = mode_action(reached, pending.mode_requested, accept_constrained_size);
            if action == ModeAction::Wait {
                return;
            }
            if action == ModeAction::Request {
                pending.mode_requested = true;
                pending.mode_request = request;
                let mut snapshot = pending.saved.clone();
                (snapshot.width, snapshot.height) = (pending.normal.0, pending.normal.1);
                cache.saved.insert(key(window.label()).to_owned(), snapshot);
                drop(cache);
                if let Some(position) = position {
                    let _ = window.set_position(position);
                }
                if maximize {
                    let _ = window.maximize();
                }
                if fullscreen {
                    let _ = window.set_fullscreen(true);
                }
                settle_constrained_size(window, request);
                return;
            }
            pending.phase = Phase::Tracking;
            fit_settings = crate::windows::is_settings_window(window.label());
        }
        pending.history = ModeHistory(frame.mode);
        pending.normal = remember_size(pending.normal, frame.size, false, frame.mode);
        let normal = pending.normal;
        let saved = cache.saved.entry(key(window.label()).to_owned()).or_default();
        (saved.width, saved.height) = (normal.0, normal.1);
        saved.maximized = frame.mode.maximized;
        saved.fullscreen = frame.mode.fullscreen;
        if frame.mode.normal()
            && let Some(pos) = frame.position
        {
            (saved.x, saved.y, saved.prev_x, saved.prev_y) = (pos.x, pos.y, pos.x, pos.y);
        }
        drop(cache);
        if let Some(position) = position {
            let _ = window.set_position(position);
        }
        if fit_settings {
            let app = window.app_handle().clone();
            let label = window.label().to_owned();
            let _ = window.run_on_main_thread(move || {
                if let Some(parent) = crate::windows::settings_parent(&label).and_then(|p| app.get_webview_window(p))
                    && let Some(settings) = app.get_webview_window(&label)
                    && let Err(error) = crate::windows::place_settings_window(&settings, &parent)
                {
                    tracing::warn!("cannot fit restored settings window: {error}");
                }
            });
        }
    }

    fn settle_constrained_size(window: &Window, request: u64) {
        let window = window.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
            let cloned = window.clone();
            let _ = window.run_on_main_thread(move || {
                let waiting = cloned.state::<Mutex<Cache>>().lock().windows.get(cloned.label()).is_some_and(|p| {
                    matches!(p.phase, Phase::Size { request: current, .. } if current == request)
                        || matches!(p.phase, Phase::Mode) && p.mode_request == request
                });
                if waiting {
                    // Window-manager constraints may reject a size without producing an exact match.
                    sample(&cloned, true, true);
                }
            });
        });
    }

    pub fn normal_size_requested(app: &AppHandle, label: &str, size: tauri::PhysicalSize<u32>) {
        let cache = app.state::<Mutex<Cache>>();
        let mut cache = cache.lock();
        cache.next_request += 1;
        let request = cache.next_request;
        if let Some(pending) = cache.windows.get_mut(label) {
            pending.normal = Size(size.width, size.height);
            pending.saved.set_normal_size(pending.normal);
            pending.mode_requested = false;
            pending.presented = false;
            pending.presentation_request = request;
            pending.phase = Phase::Mapping;
        }
        let saved = cache.saved.entry(key(label).to_owned()).or_default();
        saved.set_normal_size(Size(size.width, size.height));
        drop(cache);
        if let Some(webview) = app.get_webview_window(label) {
            request_presentation(webview.as_ref(), request);
        }
    }

    fn request_presentation(webview: &tauri::Webview, request: u64) {
        // A configure precedes output-enter. A second animation frame follows the
        // first paint, allowing GTK to learn the scale of the assigned output.
        let script = r#"
(() => {
  const state = window.__OPENIDEA_WINDOW_GEOMETRY__ ??= { request: 0, scheduled: false };
  state.request = __REQUEST_ID__;
  state.ready ??= () => {
    if (document.hidden || state.scheduled) return;
    const request = state.request;
    state.scheduled = true;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      state.scheduled = false;
      if (document.hidden) return;
      const api = window.__TAURI_INTERNALS__;
      const label = api?.metadata?.currentWindow?.label;
      if (label) api.invoke('plugin:event|emit', {
        event: 'openidea://window-state-presented', payload: { label, request }
      });
      if (request !== state.request) state.ready();
    }));
  };
  if (!state.listening) {
    state.listening = true;
    document.addEventListener('visibilitychange', state.ready);
  }
  state.ready();
})();
"#
        .replace("__REQUEST_ID__", &request.to_string());
        let _ = webview.eval(script);
    }

    pub fn save_before_close(app: &AppHandle) {
        for window in app.webview_windows().values() {
            sample(&window.as_ref().window(), false, false);
        }
        persist(app);
    }

    fn persist(app: &AppHandle) {
        let write = || -> Result<(), Box<dyn std::error::Error>> {
            let dir = app.path().app_config_dir()?;
            std::fs::create_dir_all(&dir)?;
            let cache = app.state::<Mutex<Cache>>();
            let data = serde_json::to_vec_pretty(&cache.lock().saved)?;
            let temporary = dir.join(format!("{FILE}.tmp"));
            std::fs::write(&temporary, data)?;
            std::fs::rename(temporary, dir.join(FILE))?;
            Ok(())
        };
        if let Err(error) = write() {
            tracing::warn!("cannot save Linux window state: {error}");
        }
    }

    pub fn plugin() -> TauriPlugin<tauri::Wry> {
        tauri::plugin::Builder::new("linux-window-state")
            .setup(|app, _| {
                let saved = app
                    .path()
                    .app_config_dir()
                    .ok()
                    .and_then(|dir| std::fs::read(dir.join(FILE)).ok())
                    .and_then(|data| serde_json::from_slice(&data).ok())
                    .unwrap_or_default();
                app.manage(Mutex::new(Cache { saved, ..Default::default() }));
                let handle = app.clone();
                app.listen("openidea://window-state-presented", move |event| {
                    #[derive(serde::Deserialize)]
                    struct Presented {
                        label: String,
                        request: u64,
                    }
                    let Ok(presented) = serde_json::from_str::<Presented>(event.payload()) else { return };
                    let Some(webview) = handle.get_webview_window(&presented.label) else { return };
                    let window = webview.as_ref().window();
                    let cloned = window.clone();
                    let _ = window.run_on_main_thread(move || {
                        if !cloned.is_visible().unwrap_or(false) {
                            return;
                        }
                        if let Some(pending) = cloned.state::<Mutex<Cache>>().lock().windows.get_mut(cloned.label()) {
                            if pending.presentation_request != presented.request {
                                return;
                            }
                            pending.presented = true;
                        }
                        sample(&cloned, true, false);
                    });
                });
                Ok(())
            })
            .on_page_load(|webview, payload| {
                if payload.event() == tauri::webview::PageLoadEvent::Finished {
                    let request = webview
                        .state::<Mutex<Cache>>()
                        .lock()
                        .windows
                        .get(webview.window().label())
                        .map(|p| p.presentation_request);
                    if let Some(request) = request {
                        request_presentation(webview, request);
                    }
                }
            })
            .on_window_ready(|window| {
                let cloned = window.clone();
                window.on_window_event(move |event| match event {
                    WindowEvent::Resized(_) => {
                        if let Some(pending) = cloned.state::<Mutex<Cache>>().lock().windows.get_mut(cloned.label()) {
                            pending.configured = true;
                        }
                        let request = cloned
                            .state::<Mutex<Cache>>()
                            .lock()
                            .windows
                            .get(cloned.label())
                            .filter(|p| !p.presented)
                            .map(|p| p.presentation_request);
                        if let Some(request) = request
                            && let Some(webview) = cloned.app_handle().get_webview_window(cloned.label())
                        {
                            request_presentation(webview.as_ref(), request);
                        }
                        sample(&cloned, true, false);
                    }
                    WindowEvent::Moved(_) => sample(&cloned, false, false),
                    WindowEvent::Destroyed => {
                        cloned.state::<Mutex<Cache>>().lock().windows.remove(cloned.label());
                    }
                    _ => {}
                });
            })
            .on_event(|app, event| {
                if let tauri::RunEvent::Exit = event {
                    persist(app);
                }
            })
            .build()
    }
}

#[cfg(target_os = "linux")]
pub use runtime::{normal_size_requested, plugin, prepare, save_before_close};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hidden_creation_preserves_geometry() {
        let mut config = WindowConfig { width: 1201.0, height: 801.0, ..Default::default() };
        assert!(build_hidden(&mut config));
        assert!(!config.visible);
        assert_eq!((config.width, config.height), (1201.0, 801.0));
        assert!(!build_hidden(&mut config));
    }
}
