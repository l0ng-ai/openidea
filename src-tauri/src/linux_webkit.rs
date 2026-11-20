//! WebKitGTK's DMA-BUF renderer fails on Wayland with the NVIDIA driver: the window
//! never shows and GDK logs "Error 71 (Protocol error) dispatching to Wayland display".
//! Turning the driver's explicit sync off for this process avoids it and keeps the
//! renderer, so that is done before the first web view is created. Turning the DMA-BUF
//! renderer off also avoids it, but then WebKit paints on the CPU and a tool window drag
//! stalls the UI for seconds; setting `WEBKIT_DISABLE_DMABUF_RENDERER=1` still does that.
//!
//! On Wayland, GTK's default input method goes through the compositor (text-input-v3).
//! With IBus behind it, a dead key waiting for its second key makes WebKit collapse every
//! new selection in the window to its caret (Select All, mouse drags, text fields) until a
//! composition completes. GTK's own IBus module does not, so IBus sessions use that.

const DISABLE_DMABUF: &str = "WEBKIT_DISABLE_DMABUF_RENDERER";
const DISABLE_EXPLICIT_SYNC: &str = "__NV_DISABLE_EXPLICIT_SYNC";
const IM_MODULE: &str = "GTK_IM_MODULE";

/// Run before other threads start (`set_var`).
#[cfg(target_os = "linux")]
pub fn configure() {
    let nvidia = ["/proc/driver/nvidia/version", "/sys/module/nvidia"].iter().any(|p| std::path::Path::new(p).exists());
    if disable_explicit_sync(|k| std::env::var(k).ok(), nvidia) {
        tracing::info!("Wayland with the NVIDIA driver: {DISABLE_EXPLICIT_SYNC}=1");
        unsafe { std::env::set_var(DISABLE_EXPLICIT_SYNC, "1") };
    }
    if use_ibus_module(|k| std::env::var(k).ok(), gtk_ibus_module_installed) {
        tracing::info!("Wayland with IBus: {IM_MODULE}=ibus");
        unsafe { std::env::set_var(IM_MODULE, "ibus") };
    }
}

/// GTK 3's IBus input method module (`ibus-gtk3`), wherever the distribution keeps it.
#[cfg(target_os = "linux")]
fn gtk_ibus_module_installed() -> bool {
    const MODULE: &str = "gtk-3.0/3.0.0/immodules/im-ibus.so";
    let lib_dirs = ["/usr/lib", "/usr/lib64", "/usr/local/lib"];
    lib_dirs.iter().any(|dir| {
        let dir = std::path::Path::new(dir);
        dir.join(MODULE).exists()
            || std::fs::read_dir(dir)
                .into_iter()
                .flatten()
                .flatten()
                .any(|multiarch| multiarch.path().join(MODULE).exists())
    })
}

/// A Wayland session whose input method is IBus, unless the user chose a GTK module.
fn use_ibus_module(var: impl Fn(&str) -> Option<String>, module_installed: impl FnOnce() -> bool) -> bool {
    if var(IM_MODULE).is_some_and(|v| !v.is_empty()) || !gdk_wayland(&var) {
        return false;
    }
    let ibus = var("XMODIFIERS").is_some_and(|v| v.split_whitespace().any(|m| m == "@im=ibus"));
    ibus && module_installed()
}

/// Applies Appearance › Smooth scrolling to every new web view
#[cfg(target_os = "linux")]
pub fn smooth_scrolling_plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    use tauri::Manager;
    tauri::plugin::Builder::new("linux-smooth-scrolling")
        .on_webview_ready(|webview| {
            let enabled = webview
                .try_state::<crate::state::AppState>()
                .is_some_and(|s| s.global_settings.effective().appearance.smooth_scrolling);
            let _ = webview.with_webview(move |platform| set_smooth_scrolling(&platform, enabled));
        })
        .build()
}

#[cfg(target_os = "linux")]
pub fn set_smooth_scrolling(platform: &tauri::webview::PlatformWebview, enabled: bool) {
    use webkit2gtk::{SettingsExt, WebViewExt};
    if let Some(settings) = platform.inner().settings() {
        settings.set_enable_smooth_scrolling(enabled);
    }
}

/// A Wayland session on the NVIDIA driver, unless the user already chose a workaround
/// (either variable set keeps their setting).
fn disable_explicit_sync(var: impl Fn(&str) -> Option<String>, nvidia: bool) -> bool {
    if !nvidia || var(DISABLE_DMABUF).is_some() || var(DISABLE_EXPLICIT_SYNC).is_some() {
        return false;
    }
    gdk_wayland(&var)
}

/// GDK will open a Wayland display (it tries the backends of `GDK_BACKEND` in order).
fn gdk_wayland(var: &impl Fn(&str) -> Option<String>) -> bool {
    let wayland_display = var("WAYLAND_DISPLAY").is_some_and(|v| !v.is_empty());
    let backend =
        var("GDK_BACKEND").is_none_or(|b| matches!(b.split(',').next().map(str::trim), Some("wayland" | "*" | "")));
    wayland_display && backend
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decide(vars: &[(&str, &str)], nvidia: bool) -> bool {
        disable_explicit_sync(|k| vars.iter().find(|(name, _)| *name == k).map(|(_, v)| v.to_string()), nvidia)
    }

    #[test]
    fn turns_explicit_sync_off_on_wayland_with_nvidia_only() {
        assert!(decide(&[("WAYLAND_DISPLAY", "wayland-0")], true));
        assert!(decide(&[("WAYLAND_DISPLAY", "wayland-0"), ("GDK_BACKEND", "wayland,x11")], true));
        assert!(!decide(&[("WAYLAND_DISPLAY", "wayland-0")], false));
        assert!(!decide(&[("DISPLAY", ":0")], true));
        assert!(!decide(&[("WAYLAND_DISPLAY", "")], true));
        assert!(!decide(&[("WAYLAND_DISPLAY", "wayland-0"), ("GDK_BACKEND", "x11")], true));
    }

    #[test]
    fn keeps_the_users_own_setting() {
        assert!(!decide(&[("WAYLAND_DISPLAY", "wayland-0"), (DISABLE_DMABUF, "1")], true));
        assert!(!decide(&[("WAYLAND_DISPLAY", "wayland-0"), (DISABLE_EXPLICIT_SYNC, "0")], true));
    }

    fn decide_im(vars: &[(&str, &str)], installed: bool) -> bool {
        use_ibus_module(|k| vars.iter().find(|(name, _)| *name == k).map(|(_, v)| v.to_string()), || installed)
    }

    #[test]
    fn uses_the_ibus_module_on_wayland_with_ibus_only() {
        let gnome = [("WAYLAND_DISPLAY", "wayland-0"), ("XMODIFIERS", "@im=ibus")];
        assert!(decide_im(&gnome, true));
        assert!(decide_im(&[gnome[0], gnome[1], (IM_MODULE, "")], true));
        assert!(!decide_im(&gnome, false));
        assert!(!decide_im(&[("WAYLAND_DISPLAY", "wayland-0"), ("XMODIFIERS", "@im=fcitx")], true));
        assert!(!decide_im(&[("WAYLAND_DISPLAY", "wayland-0")], true));
        assert!(!decide_im(&[("DISPLAY", ":0"), ("XMODIFIERS", "@im=ibus")], true));
        assert!(!decide_im(&[gnome[0], gnome[1], ("GDK_BACKEND", "x11")], true));
    }

    #[test]
    fn keeps_the_users_input_method_module() {
        let vars = [("WAYLAND_DISPLAY", "wayland-0"), ("XMODIFIERS", "@im=ibus"), (IM_MODULE, "wayland")];
        assert!(!decide_im(&vars, true));
    }
}
