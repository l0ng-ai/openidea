//! WebKitGTK's DMA-BUF renderer fails on Wayland with the NVIDIA driver: the window
//! never shows and GDK logs "Error 71 (Protocol error) dispatching to Wayland display".
//! Turning the driver's explicit sync off for this process avoids it and keeps the
//! renderer, so that is done before the first web view is created. Turning the DMA-BUF
//! renderer off also avoids it, but then WebKit paints on the CPU and a tool window drag
//! stalls the UI for seconds; setting `WEBKIT_DISABLE_DMABUF_RENDERER=1` still does that.

const DISABLE_DMABUF: &str = "WEBKIT_DISABLE_DMABUF_RENDERER";
const DISABLE_EXPLICIT_SYNC: &str = "__NV_DISABLE_EXPLICIT_SYNC";

/// Run before other threads start (`set_var`).
#[cfg(target_os = "linux")]
pub fn configure() {
    let nvidia = ["/proc/driver/nvidia/version", "/sys/module/nvidia"].iter().any(|p| std::path::Path::new(p).exists());
    if disable_explicit_sync(|k| std::env::var(k).ok(), nvidia) {
        tracing::info!("Wayland with the NVIDIA driver: {DISABLE_EXPLICIT_SYNC}=1");
        unsafe { std::env::set_var(DISABLE_EXPLICIT_SYNC, "1") };
    }
}

/// A Wayland session on the NVIDIA driver, unless the user already chose a workaround
/// (either variable set keeps their setting).
fn disable_explicit_sync(var: impl Fn(&str) -> Option<String>, nvidia: bool) -> bool {
    if !nvidia || var(DISABLE_DMABUF).is_some() || var(DISABLE_EXPLICIT_SYNC).is_some() {
        return false;
    }
    let wayland_display = var("WAYLAND_DISPLAY").is_some_and(|v| !v.is_empty());
    // GDK tries the backends of `GDK_BACKEND` in order.
    let gdk_wayland =
        var("GDK_BACKEND").is_none_or(|b| matches!(b.split(',').next().map(str::trim), Some("wayland" | "*" | "")));
    wayland_display && gdk_wayland
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
}
