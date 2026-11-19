use crate::project::Project;
use ide_core::IdeResult;
use ide_dap::LaunchConfig;
use ide_workspace::roots::RootKind;
use std::collections::BTreeMap;
use std::path::PathBuf;

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

pub(super) fn prepare_debug(config: &mut LaunchConfig, paths: &[PathBuf]) -> IdeResult<()> {
    // Adapter-specific env takes precedence over the common launch fields in DAP.
    let mut extra: Option<serde_json::Value> = config.extra_json.as_deref().and_then(|s| serde_json::from_str(s).ok());
    // A custom adapter may run on another host; local paths are not portable.
    if extra.as_ref().is_some_and(|e| e.get("debugServer").is_some()) {
        return Ok(());
    }
    if let Some(env) = extra.as_mut().and_then(|e| e.get_mut("env")) {
        if env.is_null() {
            *env = serde_json::json!({});
        }
        if !env.is_object() {
            return Ok(());
        }
        let mut vars = BTreeMap::new();
        if let Some(value) = env.get("PYTHONPATH").and_then(|v| v.as_str()) {
            vars.insert("PYTHONPATH".into(), value.to_owned());
        }
        ide_run::python_path::extend(&mut vars, paths, env.get("PYTHONPATH").is_none())?;
        env["PYTHONPATH"] = serde_json::json!(vars["PYTHONPATH"]);
        config.extra_json = extra.map(|e| e.to_string());
    } else {
        ide_run::python_path::extend(&mut config.env, paths, true)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

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
        prepare_debug(&mut config, std::slice::from_ref(&root)).unwrap();
        assert_eq!(config.extra_json, before);
        assert!(config.env.is_empty());
        config.extra_json = Some(serde_json::json!({"env": null}).to_string());
        prepare_debug(&mut config, std::slice::from_ref(&root)).unwrap();
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
            prepare_debug(&mut config, std::slice::from_ref(&root)).unwrap();
            let vars: BTreeMap<String, String> = if extra {
                let value: serde_json::Value = serde_json::from_str(config.extra_json.as_deref().unwrap()).unwrap();
                serde_json::from_value(value["env"].clone()).unwrap()
            } else {
                config.env
            };
            assert_eq!(std::env::split_paths(&vars["PYTHONPATH"]).collect::<Vec<_>>(), [root, vendor]);
        }
    }
}
