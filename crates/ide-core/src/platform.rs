use serde::{Deserialize, Serialize};
use specta::Type;

/// The Windows OS build used by ConPTY; unavailable on other platforms or on query failure.
#[cfg(windows)]
pub fn windows_build_number() -> Option<u32> {
    use windows_sys::Wdk::System::SystemServices::RtlGetVersion;
    use windows_sys::Win32::System::SystemInformation::OSVERSIONINFOW;

    let mut info =
        OSVERSIONINFOW { dwOSVersionInfoSize: std::mem::size_of::<OSVERSIONINFOW>() as u32, ..Default::default() };
    // SAFETY: `info` is initialized and declares the size of the writable structure.
    let status = unsafe { RtlGetVersion(&mut info) };
    (status >= 0 && info.dwBuildNumber > 0).then_some(info.dwBuildNumber)
}

#[cfg(not(windows))]
pub fn windows_build_number() -> Option<u32> {
    None
}

/// A caption button of a frameless window's title bar.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum WindowButton {
    Minimize,
    Maximize,
    Close,
}

/// Which caption buttons the title bar shows on each side, in order from left to right.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WindowButtonLayout {
    pub left: Vec<WindowButton>,
    pub right: Vec<WindowButton>,
}

impl Default for WindowButtonLayout {
    /// Minimise, maximise, close on the right (Windows, and Linux when the desktop says nothing).
    fn default() -> Self {
        Self { left: Vec::new(), right: vec![WindowButton::Minimize, WindowButton::Maximize, WindowButton::Close] }
    }
}

impl WindowButtonLayout {
    /// Reads GTK's `gtk-decoration-layout` (also GNOME's `button-layout`): button names separated
    /// by commas, the left side before the colon, e.g. `close,maximize,minimize:icon`. Names other
    /// than the three caption buttons (`icon`, `menu`, `appmenu`, `spacer`) are skipped, as are
    /// repeats. A value without any caption button is unusable for a frameless window: `None`.
    pub fn from_gtk_decoration_layout(layout: &str) -> Option<Self> {
        let mut seen = Vec::new();
        let mut side = |part: Option<&str>| {
            let mut buttons = Vec::new();
            for name in part.unwrap_or_default().split(',') {
                let button = match name.trim() {
                    "minimize" => WindowButton::Minimize,
                    "maximize" => WindowButton::Maximize,
                    "close" => WindowButton::Close,
                    _ => continue,
                };
                if !seen.contains(&button) {
                    seen.push(button);
                    buttons.push(button);
                }
            }
            buttons
        };
        // GTK splits at the first colon only; without one, every button is on the left.
        let mut parts = layout.splitn(2, ':');
        let left = side(parts.next());
        let right = side(parts.next());
        (!left.is_empty() || !right.is_empty()).then_some(Self { left, right })
    }

    /// The layout on Linux: the desktop's `gtk-decoration-layout` when a desktop session is running.
    /// Without one (WSLg, a bare compositor) GTK reports its built-in fallback, close only, which
    /// leaves no way to minimise or maximise the frameless window, so the default applies.
    pub fn for_linux(gtk_layout: Option<&str>, var: impl Fn(&str) -> Option<String>) -> Self {
        let desktop = ["XDG_CURRENT_DESKTOP", "XDG_SESSION_DESKTOP", "DESKTOP_SESSION"]
            .iter()
            .any(|key| var(key).is_some_and(|value| !value.trim().is_empty()));
        gtk_layout.filter(|_| desktop).and_then(Self::from_gtk_decoration_layout).unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn windows_build_is_platform_specific() {
        let build = super::windows_build_number();
        #[cfg(windows)]
        assert!(build.is_some_and(|build| build > 0));
        #[cfg(not(windows))]
        assert_eq!(build, None);
    }

    use super::{WindowButton::*, WindowButtonLayout};

    fn layout(left: &[super::WindowButton], right: &[super::WindowButton]) -> Option<WindowButtonLayout> {
        Some(WindowButtonLayout { left: left.to_vec(), right: right.to_vec() })
    }

    #[test]
    fn reads_gtk_decoration_layouts() {
        let cases = [
            // KDE Plasma with `ButtonsOnLeft=XAIS` (#3794).
            ("close,maximize,minimize:icon", layout(&[Close, Maximize, Minimize], &[])),
            ("close,minimize,maximize:", layout(&[Close, Minimize, Maximize], &[])),
            (":minimize,maximize,close", layout(&[], &[Minimize, Maximize, Close])),
            // GNOME's default.
            ("appmenu:close", layout(&[], &[Close])),
            ("menu:minimize,close", layout(&[], &[Minimize, Close])),
            ("icon,close:minimize,maximize", layout(&[Close], &[Minimize, Maximize])),
            (" close , spacer : minimize ", layout(&[Close], &[Minimize])),
            // No colon: GTK puts everything on the left.
            ("close,minimize", layout(&[Close, Minimize], &[])),
            // Only the first colon separates the sides; a button appears once.
            ("close:minimize:maximize", layout(&[Close], &[])),
            ("close,close:close,minimize", layout(&[Close], &[Minimize])),
            ("", None),
            (":", None),
            ("appmenu:", None),
            ("garbage", None),
        ];
        for (value, expected) in cases {
            assert_eq!(WindowButtonLayout::from_gtk_decoration_layout(value), expected, "{value:?}");
        }
    }

    #[test]
    fn linux_layout_needs_a_desktop_session() {
        let env = |vars: &'static [(&'static str, &'static str)]| {
            move |key: &str| vars.iter().find(|(k, _)| *k == key).map(|(_, v)| v.to_string())
        };
        let gnome = env(&[("XDG_CURRENT_DESKTOP", "ubuntu:GNOME")]);
        assert_eq!(WindowButtonLayout::for_linux(Some("appmenu:close"), gnome), layout(&[], &[Close]).unwrap());
        let kde = env(&[("DESKTOP_SESSION", "plasma")]);
        assert_eq!(
            WindowButtonLayout::for_linux(Some("close,maximize,minimize:icon"), kde),
            layout(&[Close, Maximize, Minimize], &[]).unwrap()
        );
        // WSLg: no desktop session, GTK's fallback layout.
        let wslg = env(&[("WAYLAND_DISPLAY", "wayland-0"), ("XDG_CURRENT_DESKTOP", " ")]);
        assert_eq!(WindowButtonLayout::for_linux(Some("menu:close"), wslg), WindowButtonLayout::default());
        let gnome = env(&[("XDG_SESSION_DESKTOP", "gnome")]);
        assert_eq!(WindowButtonLayout::for_linux(None, gnome), WindowButtonLayout::default());
    }

    #[test]
    fn default_layout_is_on_the_right() {
        assert_eq!(WindowButtonLayout::default(), layout(&[], &[Minimize, Maximize, Close]).unwrap());
    }
}
