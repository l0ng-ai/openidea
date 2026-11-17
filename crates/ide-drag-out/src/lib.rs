//! OS file drags out of an app window: the app the files are dropped on (Explorer,
//! Finder, a file manager, an SFTP client such as Xftp) copies them, as when they are
//! dragged from IDEA's Project view (#2867).
//!
//! Linux starts a GTK drag offering `text/uri-list`. Windows (OLE `DoDragDrop`) and
//! macOS (an AppKit dragging session) go through the `drag` crate. A drag is always a
//! copy, never a move, so no target can take project files away.
//!
//! [`start`] runs on the UI thread while the primary button is still held. It returns
//! once the drag has begun (Linux, macOS) or ended (Windows); `done` gets the outcome
//! when it ends, or is dropped without being called when the backend lost track of it.

use std::io;
use std::path::PathBuf;

/// How a drag ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    /// A target accepted the drop.
    Dropped,
    /// Released where nothing accepted it, or cancelled with Escape.
    Cancelled,
}

/// The paths a drag may carry: at least one, each an absolute path to a file or folder
/// on this machine. A remote project's paths name files on its server and fail here.
/// Windows also refuses paths of `MAX_PATH` or more: the shell can't make drag items of
/// them (crabnebula-dev/drag-rs#76).
pub fn local_paths<S: Into<PathBuf>>(paths: impl IntoIterator<Item = S>) -> io::Result<Vec<PathBuf>> {
    let paths: Vec<PathBuf> = paths.into_iter().map(Into::into).collect();
    if paths.is_empty() {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "no files to drag"));
    }
    for path in &paths {
        if !path.is_absolute() || std::fs::symlink_metadata(path).is_err() {
            return Err(io::Error::new(io::ErrorKind::NotFound, format!("not a local file: {}", path.display())));
        }
        if cfg!(windows) && !fits_max_path(path) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("path too long to drag: {}", path.display()),
            ));
        }
    }
    Ok(paths)
}

/// Whether `path` is shorter than Windows' `MAX_PATH` (260 UTF-16 units with the NUL).
fn fits_max_path(path: &std::path::Path) -> bool {
    path.as_os_str().to_string_lossy().encode_utf16().count() < 260
}

#[cfg(target_os = "linux")]
pub use gtk_impl::start;

#[cfg(target_os = "linux")]
mod gtk_impl {
    use super::Outcome;
    use gtk::glib::{self, SignalHandlerId};
    use gtk::prelude::*;
    use gtk::{TargetList, gdk};
    use std::cell::{Cell, RefCell};
    use std::io;
    use std::path::PathBuf;
    use std::rc::Rc;

    /// Starts dragging `paths` (see [`super::local_paths`]) from `window`; `done` runs on
    /// the UI thread when the drag ends.
    pub fn start(
        window: &gtk::ApplicationWindow,
        paths: Vec<PathBuf>,
        done: impl FnOnce(Outcome) + 'static,
    ) -> io::Result<()> {
        // `file://` URIs with every reserved or non-ASCII byte escaped.
        let uris = paths
            .iter()
            .map(|path| glib::filename_to_uri(path, None).map(|uri| uri.to_string()))
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidInput, error.to_string()))?;
        let targets = TargetList::new(&[]);
        targets.add_uri_targets(0);
        // The button that started the drag (1), not its mask: GTK ends the drag on that
        // button's release.
        let context = window
            .drag_begin_with_coordinates(&targets, gdk::DragAction::COPY, 1, None, -1, -1)
            .ok_or_else(|| io::Error::other("the window system refused to start a drag"))?;

        let outcome = Rc::new(Cell::new(Outcome::Cancelled));
        context.connect_drop_performed({
            let outcome = outcome.clone();
            move |_, _| outcome.set(Outcome::Dropped)
        });
        let handlers: Rc<RefCell<Vec<SignalHandlerId>>> = Rc::default();
        let data = window.connect_drag_data_get({
            let context = context.clone();
            move |_, ctx, selection, _, _| {
                if *ctx == context {
                    let uris: Vec<&str> = uris.iter().map(String::as_str).collect();
                    selection.set_uris(&uris);
                }
            }
        });
        // The target asks for the data after the drop (XDND is asynchronous), so the data
        // handler stays connected until `drag-end`, which GTK emits last.
        let done = Cell::new(Some(done));
        let end = window.connect_drag_end({
            let handlers = handlers.clone();
            move |window, ctx| {
                if *ctx != context {
                    return;
                }
                for handler in handlers.borrow_mut().drain(..) {
                    window.disconnect(handler);
                }
                if let Some(done) = done.take() {
                    done(outcome.get());
                }
            }
        });
        handlers.borrow_mut().extend([data, end]);
        Ok(())
    }
}

#[cfg(any(windows, target_os = "macos"))]
pub use native::start;

#[cfg(any(windows, target_os = "macos"))]
mod native {
    use super::Outcome;
    use std::io;
    use std::panic::{AssertUnwindSafe, catch_unwind};
    use std::path::PathBuf;
    use std::sync::Mutex;

    /// Starts dragging `paths` (see [`super::local_paths`]) from `window`, showing `icon`
    /// (PNG bytes) under the pointer. On Windows this returns when the drag has ended.
    pub fn start<W: raw_window_handle::HasWindowHandle>(
        window: &W,
        paths: Vec<PathBuf>,
        icon: &[u8],
        done: impl FnOnce(Outcome) + Send + 'static,
    ) -> io::Result<()> {
        let done = Mutex::new(Some(done));
        let on_end = move |result, _| {
            let done = done.lock().ok().and_then(|mut done| done.take());
            if let Some(done) = done {
                done(match result {
                    drag::DragResult::Dropped => Outcome::Dropped,
                    drag::DragResult::Cancel => Outcome::Cancelled,
                });
            }
        };
        let options = drag::Options { skip_animatation_on_cancel_or_failure: false, mode: drag::DragMode::Copy };
        // The crate unwraps where the shell can't make items of a path (network shares,
        // overlong paths: crabnebula-dev/drag-rs#72, #76); that fails this drag, not the IDE.
        let started = catch_unwind(AssertUnwindSafe(|| {
            drag::start_drag(window, drag::DragItem::Files(paths), drag::Image::Raw(icon.to_vec()), on_end, options)
        }));
        match started {
            Ok(Ok(())) => Ok(()),
            Ok(Err(error)) => Err(io::Error::other(error.to_string())),
            Err(_) => Err(io::Error::other("the system could not drag these files")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_existing_absolute_files_and_folders() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("a b ü.txt");
        std::fs::write(&file, "x").unwrap();
        let paths = local_paths([file.clone(), dir.path().to_path_buf()]).unwrap();
        assert_eq!(paths, vec![file, dir.path().to_path_buf()]);
    }

    #[test]
    fn measures_max_path_in_utf16_units() {
        let path = |len: usize| PathBuf::from(format!("C:/{}", "中".repeat(len - 3)));
        assert!(fits_max_path(&path(259)));
        assert!(!fits_max_path(&path(260)));
    }

    #[test]
    fn refuses_an_empty_drag() {
        assert_eq!(local_paths(Vec::<PathBuf>::new()).unwrap_err().kind(), io::ErrorKind::InvalidInput);
    }

    #[test]
    fn refuses_relative_and_missing_paths() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("a.txt");
        std::fs::write(&file, "x").unwrap();
        // One path that is not local fails the whole drag: none of it is half-copied.
        for bad in [PathBuf::from("a.txt"), dir.path().join("missing.txt")] {
            assert_eq!(local_paths([file.clone(), bad]).unwrap_err().kind(), io::ErrorKind::NotFound);
        }
    }
}
