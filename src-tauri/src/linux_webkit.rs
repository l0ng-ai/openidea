//! WebKitGTK's DMA-BUF renderer fails on Wayland with the NVIDIA driver: the window
//! never shows and GDK logs "Error 71 (Protocol error) dispatching to Wayland display".
//! On that combination the renderer is turned off before the first web view is created.

const DISABLE_DMABUF: &str = "WEBKIT_DISABLE_DMABUF_RENDERER";

/// Run before other threads start (`set_var`).
#[cfg(target_os = "linux")]
pub fn configure() {
    let nvidia = ["/proc/driver/nvidia/version", "/sys/module/nvidia"].iter().any(|p| std::path::Path::new(p).exists());
    if disable_dmabuf(|k| std::env::var(k).ok(), nvidia) {
        tracing::info!("Wayland with the NVIDIA driver: {DISABLE_DMABUF}=1");
        unsafe { std::env::set_var(DISABLE_DMABUF, "1") };
    }
}

/// A Wayland session on the NVIDIA driver, unless the user already set the variable.
fn disable_dmabuf(var: impl Fn(&str) -> Option<String>, nvidia: bool) -> bool {
    if !nvidia || var(DISABLE_DMABUF).is_some() {
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
        disable_dmabuf(|k| vars.iter().find(|(name, _)| *name == k).map(|(_, v)| v.to_string()), nvidia)
    }

    #[test]
    fn turns_the_dmabuf_renderer_off_on_wayland_with_nvidia_only() {
        assert!(decide(&[("WAYLAND_DISPLAY", "wayland-0")], true));
        assert!(decide(&[("WAYLAND_DISPLAY", "wayland-0"), ("GDK_BACKEND", "wayland,x11")], true));
        assert!(!decide(&[("WAYLAND_DISPLAY", "wayland-0")], false));
        assert!(!decide(&[("DISPLAY", ":0")], true));
        assert!(!decide(&[("WAYLAND_DISPLAY", "")], true));
        assert!(!decide(&[("WAYLAND_DISPLAY", "wayland-0"), ("GDK_BACKEND", "x11")], true));
    }

    #[test]
    fn keeps_the_users_own_setting() {
        assert!(!decide(&[("WAYLAND_DISPLAY", "wayland-0"), (DISABLE_DMABUF, "0")], true));
    }
}
