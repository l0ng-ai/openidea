//! GTK file chooser for Linux sessions where the dialog plugin has nothing to show.
//!
//! The dialog plugin is built with rfd's `xdg-portal` backend so KDE and GNOME show their own
//! chooser. Without a portal service and without `zenity`, rfd returns nothing and the UI reads
//! that as a cancelled dialog. The frontend asks `file_dialog_needs_gtk` once, and routes the
//! pickers through `gtk_pick_paths` when it answers true. GTK3 is already linked by the webview.

use ide_core::{IdeError, IdeResult, IpcPath};
use serde::Deserialize;
use specta::Type;
use std::path::PathBuf;

#[derive(Deserialize, Type)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub struct GtkFilter {
    pub name: String,
    pub extensions: Vec<String>,
}

#[derive(Deserialize, Type)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub struct GtkPickOptions {
    pub title: Option<String>,
    pub default_path: Option<PathBuf>,
    pub directory: bool,
    pub multiple: bool,
    /// A save dialog: one path, with overwrite confirmation.
    pub save: bool,
    pub filters: Vec<GtkFilter>,
}

/// True when the plugin's dialogs can't be shown here: Linux with no portal service on the session
/// bus (running or activatable) and no `zenity`.
#[tauri::command]
#[specta::specta]
pub async fn file_dialog_needs_gtk() -> bool {
    #[cfg(target_os = "linux")]
    {
        tauri::async_runtime::spawn_blocking(|| !linux::portal_reachable() && !linux::zenity_installed())
            .await
            .unwrap_or(false)
    }
    #[cfg(not(target_os = "linux"))]
    {
        false
    }
}

/// Shows a GTK file chooser attached to `window`. `None` when the user cancels.
#[tauri::command]
#[specta::specta]
pub async fn gtk_pick_paths(window: tauri::Window, options: GtkPickOptions) -> IdeResult<Option<Vec<IpcPath>>> {
    #[cfg(target_os = "linux")]
    {
        let (tx, rx) = std::sync::mpsc::channel();
        window
            .run_on_main_thread({
                let window = window.clone();
                move || {
                    let _ = tx.send(linux::pick(
                        window.gtk_window().ok().map(gtk::prelude::Cast::upcast::<gtk::Window>).as_ref(),
                        &options,
                    ));
                }
            })
            .map_err(|e| IdeError::internal(e.to_string()))?;
        let picked = tauri::async_runtime::spawn_blocking(move || rx.recv())
            .await
            .map_err(|e| IdeError::internal(e.to_string()))?;
        Ok(picked.map_err(|e| IdeError::internal(e.to_string()))?.map(|paths| paths.into_iter().map(IpcPath).collect()))
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (window, options);
        Err(IdeError::unavailable("The GTK file chooser is only available on Linux"))
    }
}

#[cfg(target_os = "linux")]
mod linux {
    use super::GtkPickOptions;
    use gtk::gio::{self, prelude::*};
    use gtk::prelude::*;
    use std::path::PathBuf;

    const PORTAL: &str = "org.freedesktop.portal.Desktop";

    fn bus_call(
        connection: &gio::DBusConnection,
        method: &str,
        parameters: Option<&gtk::glib::Variant>,
    ) -> Option<gtk::glib::Variant> {
        connection
            .call_sync(
                Some("org.freedesktop.DBus"),
                "/org/freedesktop/DBus",
                "org.freedesktop.DBus",
                method,
                parameters,
                None,
                gio::DBusCallFlags::NONE,
                2000,
                gio::Cancellable::NONE,
            )
            .ok()
    }

    /// Whether `org.freedesktop.portal.Desktop` is running or can be started on demand.
    pub fn portal_reachable() -> bool {
        let Ok(connection) = gio::bus_get_sync(gio::BusType::Session, gio::Cancellable::NONE) else {
            return false;
        };
        let running = bus_call(&connection, "NameHasOwner", Some(&(PORTAL,).to_variant()))
            .and_then(|v| v.child_value(0).get::<bool>())
            .unwrap_or(false);
        running
            || bus_call(&connection, "ListActivatableNames", None)
                .and_then(|v| v.child_value(0).get::<Vec<String>>())
                .is_some_and(|names| names.iter().any(|n| n == PORTAL))
    }

    pub fn zenity_installed() -> bool {
        std::env::var_os("PATH")
            .is_some_and(|path| std::env::split_paths(&path).any(|dir| dir.join("zenity").is_file()))
    }

    pub fn pick(parent: Option<&gtk::Window>, options: &GtkPickOptions) -> Option<Vec<PathBuf>> {
        let action = match (options.save, options.directory) {
            (true, _) => gtk::FileChooserAction::Save,
            (false, true) => gtk::FileChooserAction::SelectFolder,
            (false, false) => gtk::FileChooserAction::Open,
        };
        let accept = if options.save { "_Save" } else { "_Open" };
        let dialog = gtk::FileChooserDialog::with_buttons(
            Some(options.title.as_deref().unwrap_or(if options.save { "Save" } else { "Open" })),
            parent,
            action,
            &[("_Cancel", gtk::ResponseType::Cancel), (accept, gtk::ResponseType::Accept)],
        );
        dialog.set_select_multiple(options.multiple && !options.save);
        dialog.set_do_overwrite_confirmation(options.save);
        if let Some(default) = &options.default_path {
            if default.is_dir() {
                let _ = dialog.set_current_folder(default);
            } else {
                if let Some(parent) = default.parent().filter(|p| p.is_dir()) {
                    let _ = dialog.set_current_folder(parent);
                }
                if options.save {
                    if let Some(name) = default.file_name() {
                        dialog.set_current_name(&name.to_string_lossy());
                    }
                } else if default.is_file() {
                    let _ = dialog.set_filename(default);
                }
            }
        }
        for filter in options.filters.iter().filter(|f| !f.extensions.is_empty()) {
            let gtk_filter = gtk::FileFilter::new();
            gtk_filter.set_name(Some(&filter.name));
            for extension in &filter.extensions {
                if extension == "*" {
                    gtk_filter.add_pattern("*");
                } else {
                    // GTK patterns are case sensitive; match `.TXT` as well as `.txt`.
                    let ext: String = extension
                        .chars()
                        .map(|c| {
                            if c.is_ascii_alphabetic() {
                                format!("[{}{}]", c.to_ascii_lowercase(), c.to_ascii_uppercase())
                            } else {
                                c.to_string()
                            }
                        })
                        .collect();
                    gtk_filter.add_pattern(&format!("*.{ext}"));
                }
            }
            dialog.add_filter(gtk_filter);
        }
        let response = dialog.run();
        let paths = (response == gtk::ResponseType::Accept).then(|| dialog.filenames());
        // SAFETY: the dialog is ours, and not used after this.
        unsafe { dialog.destroy() };
        paths.filter(|p| !p.is_empty())
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use gtk::prelude::*;

    /// Needs a display and no portal service, e.g. `xvfb-run` with no session bus.
    #[test]
    #[ignore = "needs a display"]
    fn gtk_chooser_opens_without_a_portal_or_zenity() {
        gtk::init().expect("a display");
        assert!(!linux::portal_reachable(), "run without a session bus");
        let dir = std::env::temp_dir();
        let options = GtkPickOptions {
            title: Some("Open Folder".into()),
            default_path: Some(dir.clone()),
            directory: true,
            multiple: false,
            save: false,
            filters: vec![],
        };
        // Accept the chooser once it is on screen, and note its title.
        gtk::glib::timeout_add_local(std::time::Duration::from_millis(500), || {
            let chooser =
                gtk::Window::list_toplevels().into_iter().find_map(|w| w.downcast::<gtk::FileChooserDialog>().ok());
            let chooser = chooser.expect("the chooser is shown");
            assert_eq!(chooser.title().as_deref(), Some("Open Folder"));
            assert!(chooser.is_visible());
            chooser.response(gtk::ResponseType::Accept);
            gtk::glib::ControlFlow::Break
        });
        let picked = linux::pick(None, &options).expect("the chooser returned the accepted folder");
        assert_eq!(picked, vec![dir]);
    }
}
