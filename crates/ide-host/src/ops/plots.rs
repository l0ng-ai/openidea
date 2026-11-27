//! The Plots tool window: matplotlib figures that Python runs and debug sessions save (see
//! [`ide_run::plots`]) reach the window as [`IdeEvent::PlotAdded`].
use crate::Host;
use crate::project::Project;
use ide_command::command;
use ide_core::{IdeEvent, IdeResult, SharedSink};
use ide_run::plots::Plots;
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// The backend and plots folder for a Python run of `project`, installed and watched on first use
/// (off the async runtime: the first use empties the folder); `None` when Settings › Python turns
/// the tool window off.
pub(crate) async fn prepare(host: &Host, project: &Arc<Project>) -> Option<Plots> {
    if !project.settings.effective().languages.python.show_plots_in_tool_window {
        return None;
    }
    let plots = Plots { backend: host.local_data_dir.join("matplotlib-backend"), dir: project.cache_dir.join("plots") };
    let (project, target) = (project.clone(), plots.clone());
    let ready = super::blocking_value(move || {
        ide_run::plots::install(&target.backend).and_then(|()| watch(&project, &target.dir))
    })
    .await;
    match ready {
        Ok(Ok(())) => Some(plots),
        Ok(Err(e)) => {
            tracing::warn!("cannot set up the Plots tool window in {}: {e}", plots.dir.display());
            None
        }
        Err(e) => {
            tracing::warn!("cannot set up the Plots tool window: {}", e.message);
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
    *slot = Some(watch_dir(dir, project.sink.clone())?);
    Ok(())
}

/// Sends `PlotAdded` for each finished figure in `dir`. A file can be reported more than once
/// (created, renamed, modified); the window lists each path once.
fn watch_dir(dir: &Path, sink: SharedSink) -> io::Result<RecommendedWatcher> {
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        for path in res.map(|e| e.paths).unwrap_or_default() {
            if is_plot(&path) && path.is_file() {
                sink.emit(IdeEvent::PlotAdded { path: path.to_string_lossy().into_owned() });
            }
        }
    })
    .map_err(io::Error::other)?;
    watcher.watch(dir, RecursiveMode::NonRecursive).map_err(io::Error::other)?;
    Ok(watcher)
}

/// A finished figure: the backend writes `.<name>.png` first, then renames it.
fn is_plot(path: &Path) -> bool {
    path.extension().is_some_and(|e| e == "png")
        && path.file_name().is_some_and(|n| !n.to_string_lossy().starts_with('.'))
}

/// Deletes figures the Plots tool window dropped; only figures in this project's plots folder.
#[command(trust = always)]
pub async fn plots_delete(host: &Host, window: &str, paths: Vec<PathBuf>) -> IdeResult<()> {
    let dir = host.project(window)?.cache_dir.join("plots");
    super::blocking_value(move || {
        for path in paths.iter().filter(|p| p.parent() == Some(dir.as_path()) && is_plot(p)) {
            let _ = std::fs::remove_file(path);
        }
    })
    .await
}

ide_command::domain!(
    plots:
    plots_delete,
);

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    #[test]
    fn only_finished_pngs_are_plots() {
        assert!(is_plot(Path::new("/c/plots/1-2-0.png")));
        assert!(!is_plot(Path::new("/c/plots/.1-2-0.png")));
        assert!(!is_plot(Path::new("/c/plots/notes.txt")));
    }

    #[test]
    fn reports_a_figure_once_it_is_renamed_into_place() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = dunce::canonicalize(tmp.path()).unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        let sink: SharedSink = Arc::new(move |e: IdeEvent| {
            let _ = tx.send(e);
        });
        let _watch = watch_dir(&dir, sink).unwrap();
        std::fs::write(dir.join(".1-2-0.png"), b"png").unwrap();
        std::fs::rename(dir.join(".1-2-0.png"), dir.join("1-2-0.png")).unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut seen = Vec::new();
        while Instant::now() < deadline {
            if let Ok(IdeEvent::PlotAdded { path }) = rx.recv_timeout(Duration::from_millis(200)) {
                seen.push(path);
            } else if !seen.is_empty() {
                break;
            }
        }
        assert!(!seen.is_empty(), "no PlotAdded event");
        assert!(seen.iter().all(|p| p.ends_with("1-2-0.png") && !p.ends_with(".1-2-0.png")), "{seen:?}");
    }
}
