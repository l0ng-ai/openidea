//! Receive external file-open requests when the editor has a higher integrity level.

use ide_core::{IdeError, IdeResult};
use tauri::AppHandle;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    ChangeWindowMessageFilterEx, FindWindowW, GetWindowThreadProcessId, MSGFLT_ALLOW, WM_COPYDATA,
};

/// Called after the single-instance plugin creates its receiver and app state is ready.
pub fn allow_external_launches(app: &AppHandle) -> IdeResult<()> {
    // tauri-plugin-single-instance names its receiver using the configured identifier,
    // including the worktree suffix in debug builds. Never change a webview's filter.
    let identifier = &app.config().identifier;
    let class: Vec<u16> = format!("{identifier}-sic").encode_utf16().chain(Some(0)).collect();
    let title: Vec<u16> = format!("{identifier}-siw").encode_utf16().chain(Some(0)).collect();
    // SAFETY: both strings are NUL-terminated. Check ownership before allowing the
    // plugin's argument-transfer message on this one window.
    unsafe {
        let receiver = FindWindowW(class.as_ptr(), title.as_ptr());
        if receiver.is_null() {
            return Err(IdeError::unavailable("Cannot find the single-instance receiver for external editor requests"));
        }
        let mut owner = 0;
        if GetWindowThreadProcessId(receiver, &mut owner) == 0 {
            return Err(IdeError::unavailable(format!(
                "Cannot identify the single-instance receiver: {}",
                std::io::Error::last_os_error()
            )));
        }
        if owner != std::process::id() {
            return Err(IdeError::unavailable("The single-instance receiver belongs to another process"));
        }
        if ChangeWindowMessageFilterEx(receiver, WM_COPYDATA, MSGFLT_ALLOW, std::ptr::null_mut()) == 0 {
            return Err(IdeError::unavailable(format!(
                "Cannot enable external editor requests: {}. Run Unity and OpenIDEA with the same permissions.",
                std::io::Error::last_os_error()
            )));
        }
    }
    Ok(())
}
