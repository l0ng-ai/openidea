//! The Plots tool window: matplotlib figures that Python runs and debug sessions save (see
//! [`ide_run::plots`]) reach the window as [`IdeEvent::PlotAdded`].
use crate::Host;
use crate::project::Project;
use ide_core::IdeEvent;
use ide_run::plots::Plots;
use notify::{RecursiveMode, Watcher};
use std::io;
use std::path::Path;

/// The backend and plots folder for a Python run of `project`, installed and watched on first use;
/// `None` when Settings › Python turns the tool window off.
pub(crate) fn prepare(host: &Host, project: &Project) -> Option<Plots> {
    if !project.settings.effective().languages.python.show_plots_in_tool_window {
        return None;
    }
    let plots = Plots { backend: host.local_data_dir.join("matplotlib-backend"), dir: project.cache_dir.join("plots") };
    match ide_run::plots::install(&plots.backend).and_then(|()| watch(project, &plots.dir)) {
        Ok(()) => Some(plots),
        Err(e) => {
            tracing::warn!("cannot set up the Plots tool window in {}: {e}", plots.dir.display());
            None
        }
    }
}

fn watch(project: &Project, dir: &Path) -> io::Result<()> {
    let mut slot = project.plots_watch.lock();
    if slot.is_some() {
        return Ok(());
    }
    // Figures of an earlier session are not shown again.
    let _ = std::fs::remove_dir_all(dir);
    std::fs::create_dir_all(dir)?;
    let sink = project.sink.clone();
    // Every event of a finished PNG is sent (create, rename, modify); the window keeps each path once.
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        for path in res.map(|e| e.paths).unwrap_or_default() {
            if is_plot(&path) && path.is_file() {
                sink.emit(IdeEvent::PlotAdded { path: path.to_string_lossy().into_owned() });
            }
        }
    })
    .map_err(io::Error::other)?;
    watcher.watch(dir, RecursiveMode::NonRecursive).map_err(io::Error::other)?;
    *slot = Some(watcher);
    Ok(())
}

/// A finished figure: the backend writes `.<name>.png` first, then renames it.
fn is_plot(path: &Path) -> bool {
    path.extension().is_some_and(|e| e == "png")
        && path.file_name().is_some_and(|n| !n.to_string_lossy().starts_with('.'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_finished_pngs_are_plots() {
        assert!(is_plot(Path::new("/c/plots/1-2-0.png")));
        assert!(!is_plot(Path::new("/c/plots/.1-2-0.png")));
        assert!(!is_plot(Path::new("/c/plots/notes.txt")));
    }
}
