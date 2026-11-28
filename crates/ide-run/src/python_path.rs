//! Python imports see the same content/source roots as the IDE.
use ide_core::{IdeError, IdeResult};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

pub fn extend(env: &mut BTreeMap<String, String>, roots: &[PathBuf], inherit: bool) -> IdeResult<()> {
    if roots.is_empty() {
        return Ok(());
    }
    let inherited = if inherit { crate::system_env().remove("PYTHONPATH") } else { None };
    let existing = env.get("PYTHONPATH").or(inherited.as_ref());
    let mut paths = Vec::new();
    for root in roots {
        if !paths.contains(root) {
            paths.push(root.clone());
        }
    }
    if let Some(existing) = existing {
        for path in std::env::split_paths(existing) {
            if !paths.contains(&path) {
                paths.push(path);
            }
        }
    }
    let joined =
        std::env::join_paths(paths).map_err(|e| IdeError::invalid(format!("invalid Python import path: {e}")))?;
    env.insert("PYTHONPATH".into(), joined.to_string_lossy().into_owned());
    Ok(())
}

/// What `conda activate <prefix>` sets for a launch of that environment's Python:
/// `CONDA_PREFIX`, `CONDA_DEFAULT_ENV` and the environment's folders in front of PATH (on
/// Windows they hold the DLLs its packages load). The `CONDA_*` values replace inherited ones
/// (an IDE started with `base` active) unless `user_set` says the launch's own configuration
/// set them; PATH keeps its entries after the environment's.
pub fn activate_conda(
    env: &mut BTreeMap<String, String>,
    prefix: &Path,
    inherit: bool,
    user_set: impl Fn(&str) -> bool,
) -> IdeResult<()> {
    let text = prefix.to_string_lossy().into_owned();
    // As conda names it: `base`, the name of an env in an `envs/` folder, else its full path.
    let name = if prefix.join("condabin").is_dir() {
        "base".to_owned()
    } else if prefix.parent().is_some_and(|p| p.file_name().is_some_and(|n| n == "envs")) {
        prefix.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
    } else {
        text.clone()
    };
    for (key, value) in [("CONDA_PREFIX", text), ("CONDA_DEFAULT_ENV", name)] {
        if !user_set(key) {
            env.insert(key.into(), value);
        }
    }
    // Windows spells it `Path`; keys are case-insensitive there.
    let is_path = |k: &str| if cfg!(windows) { k.eq_ignore_ascii_case("PATH") } else { k == "PATH" };
    let key = env.keys().find(|k| is_path(k)).cloned();
    let inherited = if inherit && key.is_none() {
        crate::system_env().into_iter().find(|(k, _)| is_path(k)).map(|(_, v)| v)
    } else {
        None
    };
    let existing = key.as_ref().and_then(|k| env.get(k)).or(inherited.as_ref());
    let mut paths = conda_dirs(prefix, cfg!(windows));
    for path in existing.into_iter().flat_map(std::env::split_paths) {
        if !paths.contains(&path) {
            paths.push(path);
        }
    }
    let joined = std::env::join_paths(paths).map_err(|e| IdeError::invalid(format!("invalid PATH: {e}")))?;
    env.insert(key.unwrap_or_else(|| "PATH".into()), joined.to_string_lossy().into_owned());
    Ok(())
}

/// The folders `conda activate` puts on PATH for the environment at `prefix`.
fn conda_dirs(prefix: &Path, windows: bool) -> Vec<PathBuf> {
    if !windows {
        return vec![prefix.join("bin")];
    }
    let library = prefix.join("Library");
    vec![
        prefix.to_path_buf(),
        library.join("mingw-w64").join("bin"),
        library.join("usr").join("bin"),
        library.join("bin"),
        prefix.join("Scripts"),
        prefix.join("bin"),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_configured_paths_without_duplicates_or_system_leaks() {
        let root = std::env::temp_dir().join("python project");
        let other = root.join("vendor");
        let value = std::env::join_paths([&other, &root]).unwrap().to_string_lossy().into_owned();
        let mut env = BTreeMap::from([("PYTHONPATH".into(), value)]);
        extend(&mut env, std::slice::from_ref(&root), false).unwrap();
        assert_eq!(std::env::split_paths(&env["PYTHONPATH"]).collect::<Vec<_>>(), [root, other]);
    }

    #[test]
    fn conda_activation_puts_the_environments_folders_first_and_keeps_set_values() {
        let prefix = std::env::temp_dir().join("miniforge3").join("envs").join("ds");
        assert_eq!(conda_dirs(&prefix, false), [prefix.join("bin")]);
        let windows = conda_dirs(&prefix, true);
        assert_eq!(windows.first(), Some(&prefix));
        assert!(windows.contains(&prefix.join("Library").join("bin")), "{windows:?}");

        let other = std::env::temp_dir().join("tools");
        // An env file brought the IDE's own `base` activation; the configuration set its env name.
        let mut env = BTreeMap::from([
            ("PATH".to_owned(), std::env::join_paths([&other]).unwrap().to_string_lossy().into_owned()),
            ("CONDA_PREFIX".to_owned(), "/opt/miniforge3".to_owned()),
            ("CONDA_DEFAULT_ENV".to_owned(), "mine".to_owned()),
        ]);
        activate_conda(&mut env, &prefix, false, |k| k == "CONDA_DEFAULT_ENV").unwrap();
        let path: Vec<_> = std::env::split_paths(&env["PATH"]).collect();
        assert_eq!(path.first(), conda_dirs(&prefix, cfg!(windows)).first());
        assert_eq!(path.last(), Some(&other));
        assert_eq!(env["CONDA_PREFIX"], prefix.to_string_lossy());
        assert_eq!(env["CONDA_DEFAULT_ENV"], "mine");
        // Not inheriting and nothing set: PATH holds only the environment's folders.
        let mut env = BTreeMap::new();
        activate_conda(&mut env, &prefix, false, |_| false).unwrap();
        assert_eq!(std::env::split_paths(&env["PATH"]).collect::<Vec<_>>(), conda_dirs(&prefix, cfg!(windows)));
        assert_eq!(env["CONDA_DEFAULT_ENV"], "ds");
        // A `--prefix` environment outside `envs/` is named by its path, as conda does.
        let elsewhere = std::env::temp_dir().join("work").join(".conda");
        let mut env = BTreeMap::new();
        activate_conda(&mut env, &elsewhere, false, |_| false).unwrap();
        assert_eq!(env["CONDA_DEFAULT_ENV"], elsewhere.to_string_lossy());
    }
}
