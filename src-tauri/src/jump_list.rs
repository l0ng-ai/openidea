//! Windows taskbar Jump List: the recent projects of the running window.
//!
//! The list is built while OpenIDEA runs, so its taskbar button offers the same
//! recent projects as Welcome / File › Open Recent. `set_app_id` must run before
//! the first window is created so the taskbar groups every launch under one
//! AppUserModelID.

use ide_workspace::RecentProject;

/// Windows shows only a handful of custom destinations; keep the taskbar menu short.
const MAX_ITEMS: usize = 10;
const CATEGORY: &str = "Recent Projects";
/// Marks a second-instance launch from a Jump List item, so it opens in the existing window.
pub const OPEN_RECENT_ARG: &str = "--open-recent";

pub fn set_app_id(app_id: &str) {
    #[cfg(windows)]
    imp::set_app_id(app_id);
    #[cfg(not(windows))]
    let _ = app_id;
}

/// Rebuilds the taskbar Jump List in the background; `items` is newest first.
pub fn refresh(app: &tauri::AppHandle, items: Vec<RecentProject>) {
    #[cfg(windows)]
    imp::refresh(app, items);
    #[cfg(not(windows))]
    let _ = (app, items);
}

/// The entries a Jump List shows: newest first, capped at [`MAX_ITEMS`].
pub(crate) fn visible_items(items: &[RecentProject]) -> Vec<(&str, &std::path::Path)> {
    items.iter().take(MAX_ITEMS).map(|item| (item.name.as_str(), item.path.0.as_path())).collect()
}

#[cfg(windows)]
mod imp {
    use super::*;
    use std::sync::Mutex;
    use windows::Win32::Storage::EnhancedStorage::{PKEY_AppUserModel_ID, PKEY_Title};
    use windows::Win32::System::Com::StructuredStorage::{PROPVARIANT, PropVariantClear};
    use windows::Win32::System::Com::{
        CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, CoCreateInstance, CoInitializeEx, CoUninitialize,
    };
    use windows::Win32::UI::Shell::Common::{IObjectArray, IObjectCollection};
    use windows::Win32::UI::Shell::PropertiesSystem::IPropertyStore;
    use windows::Win32::UI::Shell::{
        DestinationList, EnumerableObjectCollection, ICustomDestinationList, IShellLinkW,
        SetCurrentProcessExplicitAppUserModelID, ShellLink,
    };
    use windows::core::{HSTRING, Interface};

    /// Shell COM is not thread-safe here; serialize updates from simultaneous project opens.
    static UPDATE_LOCK: Mutex<()> = Mutex::new(());

    pub fn set_app_id(app_id: &str) {
        if let Err(error) = unsafe { SetCurrentProcessExplicitAppUserModelID(&HSTRING::from(app_id)) } {
            tracing::warn!(%error, "cannot set the taskbar AppUserModelID");
        }
    }

    pub fn refresh(app: &tauri::AppHandle, items: Vec<RecentProject>) {
        let app_id = app.config().identifier.clone();
        let worker = std::thread::Builder::new().name("openidea-jump-list".into()).spawn(move || {
            let _guard = UPDATE_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            let com = ComGuard::new();
            if let Err(error) = update(&app_id, &items) {
                tracing::warn!(%error, "cannot update the taskbar Jump List");
            }
            drop(com);
        });
        if let Err(error) = worker {
            tracing::warn!(%error, "cannot start the taskbar Jump List worker");
        }
    }

    struct ComGuard {
        uninitialize: bool,
    }

    impl ComGuard {
        fn new() -> Self {
            let result = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
            let uninitialize = result.0 >= 0;
            if !uninitialize {
                tracing::debug!(%result, "COM already initialized for the taskbar Jump List");
            }
            Self { uninitialize }
        }
    }

    impl Drop for ComGuard {
        fn drop(&mut self) {
            if self.uninitialize {
                unsafe { CoUninitialize() };
            }
        }
    }

    fn update(app_id: &str, items: &[RecentProject]) -> windows::core::Result<()> {
        let app_id_hstring = HSTRING::from(app_id);
        let visible = visible_items(items);
        unsafe {
            let list: ICustomDestinationList = CoCreateInstance(&DestinationList, None, CLSCTX_INPROC_SERVER)?;
            list.SetAppID(&app_id_hstring)?;
            if visible.is_empty() {
                let _ = list.DeleteList(&app_id_hstring);
                return Ok(());
            }
            let mut min_slots = 0u32;
            let _removed: IObjectArray = list.BeginList(&mut min_slots)?;
            let collection: IObjectCollection =
                CoCreateInstance(&EnumerableObjectCollection, None, CLSCTX_INPROC_SERVER)?;
            let exe = HSTRING::from(std::env::current_exe()?.to_string_lossy().as_ref());
            for (name, path) in visible {
                let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)?;
                link.SetPath(&exe)?;
                let mut arguments = String::with_capacity(path.as_os_str().len() + OPEN_RECENT_ARG.len() + 3);
                arguments.push_str(OPEN_RECENT_ARG);
                arguments.push(' ');
                arguments.push('"');
                arguments.push_str(&path.to_string_lossy());
                arguments.push('"');
                link.SetArguments(&HSTRING::from(arguments.as_str()))?;
                link.SetDescription(&HSTRING::from(path.to_string_lossy().as_ref()))?;
                if let Some(parent) = path.parent() {
                    link.SetWorkingDirectory(&HSTRING::from(parent.to_string_lossy().as_ref()))?;
                }
                link.SetIconLocation(&exe, 0)?;
                let properties: IPropertyStore = link.cast()?;
                let mut title = PROPVARIANT::from(name);
                let mut app_id_value = PROPVARIANT::from(app_id);
                let title_result = properties.SetValue(&PKEY_Title, &title);
                let app_id_result = properties.SetValue(&PKEY_AppUserModel_ID, &app_id_value);
                let _ = PropVariantClear(&mut title);
                let _ = PropVariantClear(&mut app_id_value);
                title_result?;
                app_id_result?;
                properties.Commit()?;
                collection.AddObject(&link)?;
            }
            let destinations: IObjectArray = collection.cast()?;
            list.AppendCategory(&HSTRING::from(CATEGORY), &destinations)?;
            list.CommitList()?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ide_core::IpcPath;

    fn item(name: &str, path: &str) -> RecentProject {
        RecentProject { path: IpcPath::from(path), name: name.into(), opened_at_ms: 0.0, branch: None }
    }

    #[test]
    fn shows_the_newest_items_capped() {
        let items: Vec<_> = (0..15).map(|i| item(&format!("p{i}"), &format!("/p/{i}"))).collect();
        let visible = visible_items(&items);
        assert_eq!(visible.len(), 10);
        assert_eq!(visible[0].0, "p0");
        assert_eq!(visible[9].0, "p9");
    }
}
