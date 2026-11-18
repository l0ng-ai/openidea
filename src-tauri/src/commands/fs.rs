use crate::state::AppState;
use ide_command::desktop_command;
use ide_core::IdeResult;
use ide_host::ops::fs;
use std::path::{Path, PathBuf};
use tauri::{State, Window};

/// Opens a project file with its default application, or with `application` when set (an absolute
/// app / executable path, or a simple program name). The checks run here, in the backend, instead of
/// widening the webview's opener permissions: the window must be a trusted local project and the
/// file must lie inside it.
#[desktop_command(trust = always)]
#[tauri::command]
#[specta::specta]
pub async fn fs_open_with_system(
    window: Window,
    state: State<'_, AppState>,
    path: PathBuf,
    application: Option<String>,
) -> IdeResult<()> {
    if state.remote_dev.get(window.label()).is_some() {
        return Err(ide_core::IdeError::unavailable("files of a remote window open on their own machine"));
    }
    let target = fs::system_open_target(&state.host, window.label(), path)?;
    let application = application.map(validate_open_with).transpose()?;
    state
        .host
        .blocking(move || {
            tauri_plugin_opener::open_path(&target, application.as_deref())
                .map_err(|e| ide_core::IdeError::internal(format!("cannot open with the system application: {e}")))
        })
        .await
}

/// Absolute app/executable path, or a single path-segment program name (`vlc`). Rejects shell-ish values.
fn validate_open_with(with: String) -> IdeResult<String> {
    let path = Path::new(&with);
    if path.is_absolute() {
        #[cfg(target_os = "macos")]
        if path.extension().is_some_and(|e| e == "app") && path.is_dir() {
            return Ok(with);
        }
        if path.is_file() {
            return Ok(with);
        }
        return Err(ide_core::IdeError::invalid(format!("{with}: no such application")));
    }
    if !with.is_empty() && !with.contains('/') && !with.contains('\\') && !with.contains('\0') {
        return Ok(with);
    }
    Err(ide_core::IdeError::invalid("application must be an absolute path or a program name"))
}

#[cfg(test)]
mod tests {
    use super::validate_open_with;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn validate_open_with_accepts_existing_file_and_simple_names() {
        let dir = std::env::temp_dir()
            .join(format!("openidea-open-with-{}", SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
        fs::create_dir_all(&dir).unwrap();
        let bin = dir.join("tool");
        fs::write(&bin, b"x").unwrap();
        assert_eq!(validate_open_with(bin.to_string_lossy().into()).unwrap(), bin.to_string_lossy());
        assert_eq!(validate_open_with("vlc".into()).unwrap(), "vlc");
        assert!(validate_open_with("../evil".into()).is_err());
        assert!(validate_open_with("a/b".into()).is_err());
        assert!(validate_open_with(dir.join("missing").to_string_lossy().into()).is_err());
        let _ = fs::remove_dir_all(&dir);
    }
}

ide_command::desktop_domain!(fs_open_with_system);
