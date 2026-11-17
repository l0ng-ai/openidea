//! Detects shortcuts the OS already gave to another app (Windows only).
//!
//! Some vendors register system-wide hotkeys (e.g. NVIDIA's overlay grabs
//! `Alt+R` / `Alt+Shift+R`), so those keystrokes never reach the IDE. Probing
//! asks Windows to register each combo for an instant: success means it is
//! free (released right away), `ERROR_HOTKEY_ALREADY_REGISTERED` means another
//! app grabbed it. Nothing is left registered.

use ide_core::IdeResult;

/// Reports which of `combos` (single-stroke `Alt+Shift+R`-style bindings) are
/// already registered to another app. Empty everywhere but Windows.
#[tauri::command]
#[specta::specta]
pub fn system_probe_hotkeys(combos: Vec<String>) -> IdeResult<Vec<String>> {
    Ok(combos.into_iter().filter(|combo| imp::grabbed(combo)).collect())
}

/// A parsed binding: `RegisterHotKey` modifiers plus a virtual-key code.
#[cfg(windows)]
struct Hotkey {
    modifiers: u32,
    vk: u32,
}

/// Splits a canonical single-stroke binding into modifiers and key; `None`
/// for chords, double-modifier gestures, mouse buttons and unknown keys.
#[cfg(windows)]
fn parse_combo(combo: &str) -> Option<Hotkey> {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{MOD_ALT, MOD_CONTROL, MOD_SHIFT, MOD_WIN};

    if combo.contains(' ') {
        return None;
    }
    let mut parts = combo.split('+');
    let key = parts.next_back()?;
    let mut modifiers = 0;
    for part in parts {
        modifiers |= match part.to_ascii_uppercase().as_str() {
            "CTRL" => MOD_CONTROL,
            "ALT" => MOD_ALT,
            "SHIFT" => MOD_SHIFT,
            "META" => MOD_WIN,
            _ => return None,
        };
    }
    if modifiers == 0 {
        return None;
    }
    Some(Hotkey { modifiers, vk: vk_of(key)? })
}

/// The virtual-key code of a binding key, or `None` when it has no single
/// `RegisterHotKey` code (mouse buttons, gestures, layout-dependent keys).
#[cfg(windows)]
fn vk_of(key: &str) -> Option<u32> {
    if key.len() == 1 {
        let c = key.as_bytes()[0].to_ascii_uppercase();
        if c.is_ascii_alphanumeric() {
            return Some(u32::from(c));
        }
        return match c {
            b'-' => Some(0xBD),
            b'=' => Some(0xBB),
            b'[' => Some(0xDB),
            b']' => Some(0xDD),
            b'\\' => Some(0xDC),
            b';' => Some(0xBA),
            b'\'' => Some(0xDE),
            b',' => Some(0xBC),
            b'.' => Some(0xBE),
            b'/' => Some(0xBF),
            b'`' => Some(0xC0),
            _ => None,
        };
    }
    // "F13" → 0x7C … "F24" → 0x87; anything else falls through to the names below.
    let fkey =
        key.strip_prefix('F').and_then(|n| n.parse::<u32>().ok()).filter(|n| (1..=24).contains(n)).map(|n| 0x6F + n);
    if fkey.is_some() {
        return fkey;
    }
    match key.to_ascii_uppercase().as_str() {
        "SPACE" => Some(0x20),
        "ENTER" | "RETURN" => Some(0x0D),
        "ESCAPE" | "ESC" => Some(0x1B),
        "TAB" => Some(0x09),
        "BACKSPACE" | "BACK" => Some(0x08),
        "DELETE" | "DEL" => Some(0x2E),
        "INSERT" | "INS" => Some(0x2D),
        "HOME" => Some(0x24),
        "END" => Some(0x23),
        "PAGEUP" | "PRIOR" => Some(0x21),
        "PAGEDOWN" | "NEXT" => Some(0x22),
        "UP" => Some(0x26),
        "DOWN" => Some(0x28),
        "LEFT" => Some(0x25),
        "RIGHT" => Some(0x27),
        _ => None,
    }
}

#[cfg(windows)]
mod imp {
    use super::{Hotkey, parse_combo};
    use std::sync::atomic::{AtomicI32, Ordering};
    use windows_sys::Win32::Foundation::{ERROR_HOTKEY_ALREADY_REGISTERED, GetLastError};
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{RegisterHotKey, UnregisterHotKey};

    /// Probe ids (never shown, never left registered).
    static NEXT_ID: AtomicI32 = AtomicI32::new(0x1DEA00);

    /// Registers `combo` for an instant: grabbed iff Windows refuses with
    /// `ERROR_HOTKEY_ALREADY_REGISTERED`. A granted registration is released
    /// before returning, so probing never steals a shortcut.
    pub(super) fn grabbed(combo: &str) -> bool {
        let Some(Hotkey { modifiers, vk }) = parse_combo(combo) else {
            return false;
        };
        // SAFETY: registering a hotkey to a null window only tests availability;
        // the id is unique per probe and unregistered on success.
        unsafe {
            let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
            if RegisterHotKey(std::ptr::null_mut(), id, modifiers, vk) != 0 {
                UnregisterHotKey(std::ptr::null_mut(), id);
                false
            } else {
                GetLastError() == ERROR_HOTKEY_ALREADY_REGISTERED
            }
        }
    }
}

#[cfg(not(windows))]
mod imp {
    /// No other platform lets background apps swallow our keystrokes this way.
    pub(super) fn grabbed(_combo: &str) -> bool {
        false
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::imp::grabbed;
    use super::parse_combo;
    use windows_sys::Win32::Foundation::{ERROR_HOTKEY_ALREADY_REGISTERED, GetLastError};
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{MOD_ALT, MOD_SHIFT, RegisterHotKey, UnregisterHotKey};

    #[test]
    fn parses_modifier_order_and_key() {
        let hotkey = parse_combo("Alt+Shift+R").expect("Alt+Shift+R parses");
        assert_eq!(hotkey.modifiers, MOD_ALT | MOD_SHIFT);
        assert_eq!(hotkey.vk, u32::from(b'R'));
        let f7 = parse_combo("Alt+F7").expect("Alt+F7 parses");
        assert_eq!(f7.modifiers, MOD_ALT);
        assert_eq!(f7.vk, 0x76);
    }

    #[test]
    fn rejects_what_cannot_be_probed() {
        for combo in ["R", "Alt+R Alt+S", "Shift Shift", "Alt+Button4", "Ctrl+Foo", ""] {
            assert!(!grabbed(combo), "{combo} must not probe");
        }
    }

    /// Holds a real hotkey, then the probe must report it as grabbed — whether
    /// our hold succeeded or another app already held it (both read 1409).
    #[test]
    fn sees_a_hotkey_held_by_another_registration() {
        const COMBO: &str = "Alt+Shift+F24";
        const VK_F24: u32 = 0x87;
        // SAFETY: a test-only registration, released below.
        let held = unsafe { RegisterHotKey(std::ptr::null_mut(), 0x1DEAFE, MOD_ALT | MOD_SHIFT, VK_F24) != 0 };
        if !held {
            assert_eq!(
                unsafe { GetLastError() },
                ERROR_HOTKEY_ALREADY_REGISTERED,
                "the test hotkey must be holdable or already held"
            );
        }
        assert!(grabbed(COMBO), "a held hotkey reads as grabbed");
        if held {
            // SAFETY: releases the registration above.
            unsafe {
                UnregisterHotKey(std::ptr::null_mut(), 0x1DEAFE);
            }
        }
    }
}
