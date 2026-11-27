//! The Plots tool window's matplotlib backend (see `plots/`): Python runs get `MPLBACKEND` pointing at
//! it, and `plt.show()` saves each figure as a PNG in the project's plots folder, which the IDE watches.
//!
//! The backend is found through `PYTHONPATH`, as PyCharm's is: a child process that drops `PYTHONPATH`
//! (`python -I`, a replaced environment) but keeps `MPLBACKEND` cannot import it.
use ide_core::IdeResult;
use std::collections::BTreeMap;
use std::io;
use std::path::{Path, PathBuf};

/// The backend's module name (`MPLBACKEND=module://<MODULE>`).
pub const MODULE: &str = "openidea_matplotlib_backend";

const FILE: (&str, &str) = ("openidea_matplotlib_backend.py", include_str!("plots/openidea_matplotlib_backend.py"));

/// Where the backend is installed and the folder it saves figures in.
#[derive(Clone, Debug)]
pub struct Plots {
    pub backend: PathBuf,
    pub dir: PathBuf,
}

/// Writes the backend under `dir` (an unchanged file stays).
pub fn install(dir: &Path) -> io::Result<()> {
    let (name, text) = FILE;
    let path = dir.join(name);
    if std::fs::read_to_string(&path).is_ok_and(|current| current == text) {
        return Ok(());
    }
    std::fs::create_dir_all(dir)?;
    std::fs::write(path, text)
}

/// Points matplotlib at the backend, unless the run's environment already sets `MPLBACKEND`.
/// `inherit_in`: the folder the run starts in when it inherits the IDE's environment; what it
/// inherits there (the login shell's and the project's `.envrc` variables too) counts.
pub fn add(env: &mut BTreeMap<String, String>, plots: &Plots, inherit_in: Option<&Path>) -> IdeResult<()> {
    if env.contains_key("MPLBACKEND")
        || inherit_in.is_some_and(|dir| ide_core::process::host_var_os_in(dir, "MPLBACKEND").is_some())
    {
        return Ok(());
    }
    crate::python_path::extend(env, std::slice::from_ref(&plots.backend), inherit_in.is_some())?;
    env.insert("MPLBACKEND".into(), format!("module://{MODULE}"));
    env.insert("OPENIDEA_PLOTS_DIR".into(), plots.dir.to_string_lossy().into_owned());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn plots(root: &Path) -> Plots {
        Plots { backend: root.join("backend"), dir: root.join("plots") }
    }

    #[test]
    fn installs_the_backend_and_leaves_a_users_backend_alone() {
        let tmp = tempfile::tempdir().unwrap();
        let plots = plots(tmp.path());
        install(&plots.backend).unwrap();
        install(&plots.backend).unwrap();
        assert_eq!(std::fs::read_to_string(plots.backend.join(FILE.0)).unwrap(), FILE.1);

        let mut env = BTreeMap::from([("PYTHONPATH".into(), "/src".into())]);
        add(&mut env, &plots, None).unwrap();
        assert_eq!(env["MPLBACKEND"], "module://openidea_matplotlib_backend");
        assert_eq!(env["OPENIDEA_PLOTS_DIR"], plots.dir.to_string_lossy());
        let path: Vec<_> = std::env::split_paths(&env["PYTHONPATH"]).collect();
        assert_eq!(path, [plots.backend.clone(), PathBuf::from("/src")]);

        let own = BTreeMap::from([("MPLBACKEND".into(), "Agg".into())]);
        let mut env = own.clone();
        add(&mut env, &plots, Some(tmp.path())).unwrap();
        assert_eq!(env, own);
    }

    /// Runs the real backend when this machine's `python3` has matplotlib (skipped otherwise).
    #[test]
    fn the_backend_saves_each_shown_figure_once() {
        let python = if cfg!(windows) { "python" } else { "python3" };
        if !Command::new(python).args(["-c", "import matplotlib"]).output().is_ok_and(|o| o.status.success()) {
            eprintln!("skipped: no matplotlib for {python}");
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let plots = plots(tmp.path());
        install(&plots.backend).unwrap();
        let mut env = BTreeMap::new();
        add(&mut env, &plots, None).unwrap();
        let script = "import matplotlib.pyplot as plt\n\
            plt.plot([1, 2]); plt.figure(); plt.plot([2, 1])\n\
            plt.show()\n\
            f = plt.figure(); plt.plot([3, 1]); f.show()\n\
            plt.show()\n\
            print(plt.get_backend())\n";
        let out = Command::new(python).args(["-c", script]).envs(&env).output().unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "module://openidea_matplotlib_backend");
        let mut names: Vec<String> =
            std::fs::read_dir(&plots.dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into()).collect();
        names.sort();
        // Two figures, then the third once: `f.show()` saved it and `plt.show()` doesn't again.
        assert_eq!(names.len(), 3, "{names:?}");
        assert!(names.iter().all(|n| n.ends_with(".png") && !n.starts_with('.')), "{names:?}");
    }
}
