//! Logcat tool window: Android devices and their logs (`ide-android`).

use crate::state::AppState;
use ide_android::{AndroidDevice, LogcatLine};
use ide_core::{IdeError, IdeResult, RequestId};
use tauri::State;
use tauri::ipc::Channel;

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> IdeResult<T> + Send + 'static) -> IdeResult<T> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| IdeError::internal(e.to_string()))?
}

/// Devices `adb` knows about, online ones first.
#[tauri::command]
#[specta::specta]
pub async fn android_devices() -> IdeResult<Vec<AndroidDevice>> {
    blocking(ide_android::devices).await
}

/// Follows `serial`'s log until the request is cancelled, in batches of lines.
/// `clear` empties the device's buffers first.
#[tauri::command]
#[specta::specta]
pub async fn android_logcat(
    state: State<'_, AppState>,
    request: RequestId,
    serial: String,
    clear: bool,
    on_lines: Channel<Vec<LogcatLine>>,
) -> IdeResult<()> {
    let cancel = state.begin_request(request);
    let result = tauri::async_runtime::spawn_blocking(move || {
        ide_android::logcat(&serial, clear, &cancel, &mut |batch| {
            let _ = on_lines.send(batch);
        })
    })
    .await
    .map_err(|e| IdeError::internal(e.to_string()))?;
    state.end_request(request);
    result
}
