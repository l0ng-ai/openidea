//! The Plots tool window's matplotlib backend (see `plots/`): Python runs get `MPLBACKEND` pointing at
//! it, and `plt.show()` saves each figure as a PNG in the project's plots folder, which the IDE watches.
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

/// Points matplotlib at the backend, unless the run's environment (or, when it inherits it, the
/// IDE's own) already sets `MPLBACKEND`.
pub fn add(env: &mut BTreeMap<String, String>, plots: &Plots, inherit: bool) -> IdeResult<()> {
    if env.contains_key("MPLBACKEND") || (inherit && crate::system_env().contains_key("MPLBACKEND")) {
        return Ok(());
    }
    crate::python_path::extend(env, std::slice::from_ref(&plots.backend), inherit)?;
    env.insert("MPLBACKEND".into(), format!("module://{MODULE}"));
    env.insert("OPENIDEA_PLOTS_DIR".into(), plots.dir.to_string_lossy().into_owned());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn installs_the_backend_and_leaves_a_users_backend_alone() {
        let tmp = tempfile::tempdir().unwrap();
        let plots = Plots { backend: tmp.path().join("backend"), dir: tmp.path().join("plots") };
        install(&plots.backend).unwrap();
        install(&plots.backend).unwrap();
        assert_eq!(std::fs::read_to_string(plots.backend.join(FILE.0)).unwrap(), FILE.1);

        let mut env = BTreeMap::from([("PYTHONPATH".into(), "/src".into())]);
        add(&mut env, &plots, false).unwrap();
        assert_eq!(env["MPLBACKEND"], "module://openidea_matplotlib_backend");
        assert_eq!(env["OPENIDEA_PLOTS_DIR"], plots.dir.to_string_lossy());
        let path: Vec<_> = std::env::split_paths(&env["PYTHONPATH"]).collect();
        assert_eq!(path, [plots.backend.clone(), PathBuf::from("/src")]);

        let mut own = BTreeMap::from([("MPLBACKEND".into(), "Agg".into())]);
        add(&mut own, &plots, false).unwrap();
        assert_eq!(own, BTreeMap::from([("MPLBACKEND".into(), "Agg".into())]));
    }
}
