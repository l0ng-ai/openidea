use ide_core::{IdeError, IdeResult};
use std::time::Duration;

/// Installed WSL distros, for the "Connect to WSL" picker. `wsl.exe` can stall while the WSL
/// service starts, so the wait is bounded.
#[tauri::command]
#[specta::specta]
pub async fn wsl_distros() -> IdeResult<Vec<String>> {
    let list = tokio::task::spawn_blocking(ide_core::wsl::list_distros);
    match tokio::time::timeout(Duration::from_secs(8), list).await {
        Ok(joined) => joined.map_err(|e| IdeError::internal(e.to_string())),
        Err(_) => Err(IdeError::internal("wsl.exe did not answer in time")),
    }
}

/// The WSL project a `\\wsl.localhost\<distro>\…` folder stands for, so the frontend opens it
/// through the distro and not as a network folder. `None` for any other path.
#[tauri::command]
#[specta::specta]
pub fn wsl_resolve(path: std::path::PathBuf) -> Option<crate::windows::RemoteLaunch> {
    crate::windows::wsl_launch(&path)
}
