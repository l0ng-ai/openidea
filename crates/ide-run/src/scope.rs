//! A configuration's module and relative paths move together when projects are nested.

use crate::RunConfig;
use ide_core::{ipc_path::to_ipc, project_roots};
use std::path::{Path, PathBuf};

pub fn owner(root: &Path, config: &RunConfig) -> PathBuf {
    if matches!(config.kind.as_str(), "dotnet" | "dotnet-test")
        && let Some(project) = config.extras.params.get("project").filter(|p| !p.is_empty())
    {
        return project_roots::resolve(root, Path::new(project)).parent().unwrap_or(root).to_path_buf();
    }
    let module = (config.kind == "go")
        .then(|| config.extras.params.get("module"))
        .flatten()
        .map(String::as_str)
        .or(config.extras.module.as_deref())
        .map(Path::new)
        .or(config.cwd.as_deref())
        .unwrap_or(Path::new(""));
    project_roots::resolve(root, module)
}

pub fn rebase(config: &mut RunConfig, from: &Path, relative_to: Option<&Path>) {
    let path = |value: &str| {
        let absolute = project_roots::resolve(from, Path::new(value));
        to_ipc(&relative_to.map_or(absolute.clone(), |root| project_roots::relative(root, &absolute)))
    };
    let cwd = config.cwd.as_deref().unwrap_or(Path::new("")).to_path_buf();
    config.cwd = Some(path(&to_ipc(&cwd)).into());
    if config.extras.module.is_some() || !matches!(config.kind.as_str(), "application" | "spring-boot") {
        config.extras.module = Some(path(config.extras.module.as_deref().unwrap_or("")));
    }
    if config.kind == "go" && config.extras.params.contains_key("goKind") {
        config.extras.params.entry("module".into()).or_default();
    }
    for file in &mut config.extras.env_files {
        *file = path(file);
    }
    for file in [&mut config.extras.stdin_file, &mut config.extras.output_file].into_iter().flatten() {
        *file = path(file);
    }
    let keys: &[&str] = match config.kind.as_str() {
        "go" => &["module", "outputDir"],
        "dotnet" | "dotnet-test" => &["project", "targetPath"],
        _ => &[],
    };
    for key in keys {
        if let Some(value) = config.extras.params.get_mut(*key)
            && (*key == "module" || !value.is_empty())
        {
            *value = path(value);
        }
    }
    if !matches!(config.kind.as_str(), "shell" | "compound") && Path::new(&config.command).components().count() > 1 {
        // Executables are relative to the old cwd, unlike env/input/output files.
        let cwd = project_roots::resolve(from, &cwd);
        config.command = to_ipc(&project_roots::resolve(&cwd, Path::new(&config.command)));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    #[test]
    fn default_go_module_moves_with_member_but_unknown_jvm_module_stays_inferred() {
        let temp = tempfile::tempdir().unwrap();
        for (kind, params) in
            [("go", serde_json::json!({"goKind":"build", "target":"."})), ("application", serde_json::json!({}))]
        {
            let mut config: RunConfig = serde_json::from_value(serde_json::json!({
                "id":"run", "name":"run", "kind":kind, "command":"tool", "args":[], "cwd":null,
                "env":{}, "detected":false, "isTest":false, "debugAdapter":null, "params":params
            }))
            .unwrap();
            rebase(&mut config, temp.path(), None);
            if kind == "go" {
                assert_eq!(config.extras.params["module"], to_ipc(temp.path()));
            } else {
                assert_eq!(config.extras.module, None);
            }
        }
    }

    #[test]
    fn workspace_members_rebase_every_typed_root_without_changing_targets() {
        let temp = tempfile::tempdir().unwrap();
        let member = temp.path().join("member with spaces");
        for (kind, params) in [
            ("application", BTreeMap::<String, String>::new()),
            (
                "go",
                BTreeMap::from([
                    ("module".into(), "api".into()),
                    ("target".into(), "./cmd/server".into()),
                    ("outputDir".into(), "bin".into()),
                ]),
            ),
            ("dotnet", BTreeMap::from([("project".into(), "src/App.csproj".into())])),
        ] {
            let mut config: RunConfig = serde_json::from_value(serde_json::json!({
                "id":"run", "name":"run", "kind":kind, "command":"tool", "args":["unchanged"], "cwd":null,
                "env":{}, "detected":true, "isTest":false, "debugAdapter":null,
                "module":"app", "params":params, "envFiles":[".env"], "stdinFile":"input.txt", "outputFile":"out/result.txt"
            })).unwrap();
            rebase(&mut config, &member, None);
            assert_eq!(config.cwd.as_deref(), Some(member.as_path()));
            assert_eq!(config.extras.module.as_deref(), Some(to_ipc(&member.join("app")).as_str()));
            assert_eq!(config.extras.env_files, [to_ipc(&member.join(".env"))]);
            assert_eq!(config.extras.stdin_file, Some(to_ipc(&member.join("input.txt"))));
            assert_eq!(config.extras.output_file, Some(to_ipc(&member.join("out/result.txt"))));
            assert_eq!(config.args, ["unchanged"]);
            if kind == "go" {
                assert_eq!(config.extras.params["module"], to_ipc(&member.join("api")));
                assert_eq!(config.extras.params["outputDir"], to_ipc(&member.join("bin")));
                assert_eq!(config.extras.params["target"], "./cmd/server");
            }
            if kind == "dotnet" {
                assert_eq!(config.extras.params["project"], to_ipc(&member.join("src/App.csproj")));
            }
        }
    }
}
