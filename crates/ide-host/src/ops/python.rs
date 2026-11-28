use crate::project::Project;
use ide_core::IdeResult;
use ide_dap::LaunchConfig;
use ide_workspace::roots::RootKind;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

pub(super) fn paths(project: &Project) -> Vec<PathBuf> {
    let mut paths = vec![project.root.clone()];
    paths.extend(project.content_roots());
    for root in project.roots().roots {
        if matches!(root.kind, RootKind::Source | RootKind::Test) {
            let path = project.root.join(root.path);
            if !paths.contains(&path) {
                paths.push(path);
            }
        }
    }
    paths
}

/// `paths` plus the folders added to the paths of the interpreter a launch uses (All
/// Interpreters › Show Paths): `command` when it names a Python executable, else the
/// interpreter of the project or workspace member at `near`. Run, Debug and the console
/// resolve it the same way, so the same file imports the same modules in each.
pub(super) fn with_user_paths(
    mut paths: Vec<PathBuf>,
    config_dir: &Path,
    project: &Project,
    command: Option<&str>,
    near: Option<&Path>,
) -> Vec<PathBuf> {
    if let Some(python) = launch_python(config_dir, project, command, near) {
        for path in ide_sdk::apply::interpreter_user_paths(&python, &project.settings.effective()) {
            if !paths.contains(&path) {
                paths.push(path);
            }
        }
    }
    paths
}

/// The interpreter a launch uses: `command` when it names a Python executable, else the
/// interpreter of the project or workspace member at `near`.
fn launch_python(config_dir: &Path, project: &Project, command: Option<&str>, near: Option<&Path>) -> Option<PathBuf> {
    let named = command
        .filter(|c| ide_sdk::apply::is_python_command(c))
        .map(PathBuf::from)
        .filter(|p| p.is_absolute() && p.is_file())
        .map(|p| ide_core::project_roots::resolve(&project.root, &p));
    named.or_else(|| super::sdk::effective_python(config_dir, project, near))
}

/// The conda environment of the interpreter a launch uses ([`launch_python`]), to activate.
pub(super) fn conda_prefix(
    config_dir: &Path,
    project: &Project,
    command: Option<&str>,
    near: Option<&Path>,
) -> Option<PathBuf> {
    ide_sdk::apply::conda_env_prefix(&launch_python(config_dir, project, command, near)?)
}

/// The interpreter a debugpy launch names (`"python": "<executable>"`), if it names one.
pub(super) fn debug_python(config: &LaunchConfig) -> Option<String> {
    let extra: serde_json::Value = serde_json::from_str(config.extra_json.as_deref()?).ok()?;
    extra.get("python")?.as_str().map(str::to_owned)
}

/// Adds the project's import paths, and the Plots tool window's backend (`plots`, with the folder
/// the debuggee starts in), to a debugpy launch's environment.
pub(super) fn prepare_debug(
    config: &mut LaunchConfig,
    paths: &[PathBuf],
    plots: Option<(&ide_run::plots::Plots, &Path)>,
    conda: Option<&Path>,
) -> IdeResult<()> {
    // Adapter-specific env takes precedence over the common launch fields in DAP.
    let mut extra: Option<serde_json::Value> = config.extra_json.as_deref().and_then(|s| serde_json::from_str(s).ok());
    // A custom adapter may run on another host; local paths are not portable.
    if extra.as_ref().is_some_and(|e| e.get("debugServer").is_some()) {
        return Ok(());
    }
    let plots = plots.filter(|_| !config.env.contains_key("MPLBACKEND"));
    if let Some(env) = extra.as_mut().and_then(|e| e.get_mut("env")) {
        if env.is_null() {
            *env = serde_json::json!({});
        }
        let Some(object) = env.as_object_mut() else {
            return Ok(());
        };
        let mut vars: BTreeMap<String, String> =
            object.iter().filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_owned()))).collect();
        let inherit = !vars.contains_key("PYTHONPATH");
        ide_run::python_path::extend(&mut vars, paths, inherit)?;
        if let Some(prefix) = conda {
            ide_run::python_path::activate_conda(&mut vars, prefix, inherit)?;
        }
        if let Some((plots, dir)) = plots {
            ide_run::plots::add(&mut vars, plots, Some(dir))?;
        }
        for (key, value) in vars {
            object.insert(key, serde_json::json!(value));
        }
        config.extra_json = extra.map(|e| e.to_string());
    } else {
        ide_run::python_path::extend(&mut config.env, paths, true)?;
        if let Some(prefix) = conda {
            ide_run::python_path::activate_conda(&mut config.env, prefix, true)?;
        }
        if let Some((plots, dir)) = plots {
            ide_run::plots::add(&mut config.env, plots, Some(dir))?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn debug_activates_the_interpreters_conda_environment() {
        let root = std::env::temp_dir().join("project");
        let prefix = std::env::temp_dir().join("miniforge3").join("envs").join("ds");
        let mut config = LaunchConfig {
            name: "Python".into(),
            adapter: "debugpy".into(),
            request: "launch".into(),
            program: None,
            args: vec![],
            cwd: None,
            env: BTreeMap::new(),
            extra_json: Some(serde_json::json!({"env": {"CONDA_DEFAULT_ENV": "mine"}}).to_string()),
        };
        prepare_debug(&mut config, std::slice::from_ref(&root), None, Some(&prefix)).unwrap();
        let value: serde_json::Value = serde_json::from_str(config.extra_json.as_deref().unwrap()).unwrap();
        let env = &value["env"];
        assert_eq!(env["CONDA_PREFIX"], prefix.to_string_lossy().as_ref());
        assert_eq!(env["CONDA_DEFAULT_ENV"], "mine");
        let path = env.as_object().unwrap().iter().find(|(k, _)| k.eq_ignore_ascii_case("PATH")).unwrap().1;
        let first = std::env::split_paths(path.as_str().unwrap()).next().unwrap();
        assert!(first.starts_with(&prefix), "{first:?}");
    }

    #[test]
    fn debug_preserves_remote_paths_and_handles_null_env() {
        let root = std::env::temp_dir().join("project");
        let mut config = LaunchConfig {
            name: "Python".into(),
            adapter: "debugpy".into(),
            request: "launch".into(),
            program: None,
            args: vec![],
            cwd: None,
            env: BTreeMap::new(),
            extra_json: Some(serde_json::json!({"env": null, "debugServer": "remote:5678"}).to_string()),
        };
        let before = config.extra_json.clone();
        prepare_debug(&mut config, std::slice::from_ref(&root), None, None).unwrap();
        assert_eq!(config.extra_json, before);
        assert!(config.env.is_empty());
        config.extra_json = Some(serde_json::json!({"env": null}).to_string());
        prepare_debug(&mut config, std::slice::from_ref(&root), None, None).unwrap();
        let value: serde_json::Value = serde_json::from_str(config.extra_json.as_deref().unwrap()).unwrap();
        let paths = std::env::split_paths(value["env"]["PYTHONPATH"].as_str().unwrap()).collect::<Vec<_>>();
        assert_eq!(paths[0], root);
    }

    #[test]
    fn debug_uses_the_effective_environment_field() {
        for extra in [false, true] {
            let root = std::env::temp_dir().join("project");
            let vendor = root.join("vendor");
            let vars = BTreeMap::from([("PYTHONPATH".into(), vendor.to_string_lossy().into_owned())]);
            let mut config = LaunchConfig {
                name: "Python".into(),
                adapter: "debugpy".into(),
                request: "launch".into(),
                program: Some("app/main.py".into()),
                args: vec![],
                cwd: None,
                env: vars.clone(),
                extra_json: extra.then(|| serde_json::json!({"env": vars}).to_string()),
            };
            prepare_debug(&mut config, std::slice::from_ref(&root), None, None).unwrap();
            let vars: BTreeMap<String, String> = if extra {
                let value: serde_json::Value = serde_json::from_str(config.extra_json.as_deref().unwrap()).unwrap();
                serde_json::from_value(value["env"].clone()).unwrap()
            } else {
                config.env
            };
            assert_eq!(std::env::split_paths(&vars["PYTHONPATH"]).collect::<Vec<_>>(), [root, vendor]);
        }
    }

    #[test]
    fn debug_adds_the_plots_backend_to_the_launch_env_unless_it_sets_one() {
        let root = std::env::temp_dir().join("project");
        if ide_core::process::host_var_os_in(&root, "MPLBACKEND").is_some() {
            eprintln!("skipped: this machine sets MPLBACKEND");
            return;
        }
        let plots = ide_run::plots::Plots { backend: root.join("backend"), dir: root.join("plots") };
        let launch = |extra: serde_json::Value, env: BTreeMap<String, String>| LaunchConfig {
            name: "Python".into(),
            adapter: "debugpy".into(),
            request: "launch".into(),
            program: Some("main.py".into()),
            args: vec![],
            cwd: None,
            env,
            extra_json: Some(extra.to_string()),
        };
        let env_of = |config: &LaunchConfig| -> serde_json::Value {
            serde_json::from_str::<serde_json::Value>(config.extra_json.as_deref().unwrap()).unwrap()["env"].clone()
        };

        // The launch's own variables stay as they are, other values included.
        let mut config = launch(serde_json::json!({"env": {"DEBUG": "1", "LEVEL": 3}}), BTreeMap::new());
        prepare_debug(&mut config, std::slice::from_ref(&root), Some((&plots, &root)), None).unwrap();
        let env = env_of(&config);
        assert_eq!((env["DEBUG"].as_str(), env["LEVEL"].as_i64()), (Some("1"), Some(3)));
        assert_eq!(env["MPLBACKEND"], "module://openidea_matplotlib_backend");
        assert_eq!(env["OPENIDEA_PLOTS_DIR"], plots.dir.to_string_lossy().as_ref());
        let path: Vec<_> = std::env::split_paths(env["PYTHONPATH"].as_str().unwrap()).collect();
        // A PYTHONPATH this machine sets follows.
        assert_eq!(path[..2], [plots.backend.clone(), root.clone()]);

        // A backend the launch names, in either environment field, is kept.
        let mut config = launch(serde_json::json!({"env": {"MPLBACKEND": "Agg"}}), BTreeMap::new());
        prepare_debug(&mut config, std::slice::from_ref(&root), Some((&plots, &root)), None).unwrap();
        let env = env_of(&config);
        assert_eq!(env["MPLBACKEND"], "Agg");
        assert!(env.get("OPENIDEA_PLOTS_DIR").is_none());
        let own = BTreeMap::from([("MPLBACKEND".into(), "TkAgg".into())]);
        let mut config = launch(serde_json::json!({}), own);
        prepare_debug(&mut config, std::slice::from_ref(&root), Some((&plots, &root)), None).unwrap();
        assert_eq!(config.env["MPLBACKEND"], "TkAgg");
        assert!(!config.env.contains_key("OPENIDEA_PLOTS_DIR"));
    }
}
