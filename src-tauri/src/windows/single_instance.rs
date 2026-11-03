//! Let external editors forward file-open requests to an elevated IDE on Windows.

use tauri::AppHandle;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    ChangeWindowMessageFilterEx, FindWindowW, GetWindowThreadProcessId, MSGFLT_ALLOW, WM_COPYDATA,
};

/// The single-instance plugin creates its receiver before app setup runs.
pub fn allow_external_launches(app: &AppHandle) {
    // These names are defined by tauri-plugin-single-instance's Windows backend.
    // Keep the exception on that receiver, not on the webview or the whole process.
    let identifier = &app.config().identifier;
    let class: Vec<u16> = format!("{identifier}-sic").encode_utf16().chain(Some(0)).collect();
    let title: Vec<u16> = format!("{identifier}-siw").encode_utf16().chain(Some(0)).collect();
    // SAFETY: both strings are NUL-terminated. Validate ownership before changing
    // the filter, and allow only the plugin's existing argument-transfer message.
    unsafe {
        let receiver = FindWindowW(class.as_ptr(), title.as_ptr());
        let mut owner = 0;
        if receiver.is_null() {
            tracing::warn!("cannot find single-instance receiver for external editor launches");
            return;
        }
        GetWindowThreadProcessId(receiver, &mut owner);
        if owner != std::process::id() {
            tracing::warn!("single-instance receiver belongs to another process");
            return;
        }
        if ChangeWindowMessageFilterEx(receiver, WM_COPYDATA, MSGFLT_ALLOW, std::ptr::null_mut()) == 0 {
            tracing::warn!(error = %std::io::Error::last_os_error(), "cannot allow external editor launches");
        }
    }
}
