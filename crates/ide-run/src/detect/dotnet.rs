//! Runnable .NET projects and launch profiles, without a solution model.

use crate::{
    RunConfig,
    dotnet::{parse_project, profiles, solution_projects},
};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::Path,
};

pub(crate) fn detect(root: &Path, out: &mut Vec<RunConfig>) {
    let mut dirs = vec![root.to_path_buf()];
    let mut projects = BTreeSet::new();
    while let Some(dir) = dirs.pop() {
        let Ok(entries) = fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().into_owned();
            if entry.file_type().is_ok_and(|t| t.is_dir()) {
                if !name.starts_with('.')
                    && !matches!(
                        name.as_str(),
                        "bin" | "obj" | "node_modules" | "target" | "build" | "dist" | "vendor" | "packages"
                    )
                {
                    dirs.push(path);
                }
            } else if entry.file_type().is_ok_and(|t| t.is_file()) {
                match path.extension().and_then(|e| e.to_str()).unwrap_or_default().to_ascii_lowercase().as_str() {
                    "csproj" => {
                        projects.insert(path);
                    }
                    "sln" | "slnx" => {
                        if let Ok(src) = fs::read_to_string(&path) {
                            for project in solution_projects(
                                &src,
                                path.extension().is_some_and(|e| e.eq_ignore_ascii_case("slnx")),
                            ) {
                                projects.insert(dir.join(project));
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
    }
    let root = dunce::canonicalize(root).unwrap_or_else(|_| root.into());
    let projects: BTreeSet<_> = projects.into_iter().filter_map(|p| dunce::canonicalize(p).ok()).collect();
    for path in projects {
        let Some(project) = fs::read_to_string(&path).ok().and_then(|s| parse_project(&s)) else { continue };
        let rel = path.strip_prefix(&root).unwrap_or(&path).to_string_lossy().replace('\\', "/");
        let name = path.file_stem().unwrap_or_default().to_string_lossy();
        let profiles = profiles(&path);
        let mut params = BTreeMap::from([
            ("project".into(), rel.clone()),
            ("framework".into(), project.frameworks.first().cloned().unwrap_or_default()),
            ("frameworks".into(), project.frameworks.join(";")),
            ("profiles".into(), serde_json::to_string(&profiles).unwrap_or_default()),
            ("launchProfile".into(), String::new()),
            ("programArgs".into(), String::new()),
        ]);
        if project.executable && !project.test {
            out.push(detected(&rel, &name, "", params.clone(), false));
            for profile in profiles.keys() {
                params.insert("launchProfile".into(), profile.clone());
                out.push(detected(&rel, &name, profile, params.clone(), false));
            }
        }
        if project.test {
            params.insert("launchProfile".into(), String::new());
            out.push(detected(&rel, &name, "", params, true));
        }
    }
}

fn detected(project: &str, name: &str, profile: &str, params: BTreeMap<String, String>, test: bool) -> RunConfig {
    let op = if test { "test" } else { "run" };
    let mut config = super::config(
        format!("dotnet:{project}:{op}:{profile}"),
        if test {
            format!("dotnet test ({name})")
        } else if profile.is_empty() {
            format!("{name} (.NET Project)")
        } else {
            format!("{name}: {profile}")
        },
        if test { "dotnet-test" } else { "dotnet" },
        "dotnet",
        &[],
    );
    config.args = command_args(&params, test);
    config.is_test = test;
    config.debug_adapter = (!test).then(|| "netcoredbg".into());
    config.extras.params = params;
    if !test {
        config.extras.before_launch.push(crate::BeforeLaunchTask { kind: "dotnetBuild".into(), target: String::new() });
    }
    config
}

fn command_args(params: &BTreeMap<String, String>, test: bool) -> Vec<String> {
    let mut args = if test {
        vec!["test".into(), params.get("project").cloned().unwrap_or_default()]
    } else {
        vec!["run".into(), "--project".into(), params.get("project").cloned().unwrap_or_default()]
    };
    if let Some(framework) = params.get("framework").filter(|s| !s.is_empty()) {
        args.extend(["--framework".into(), framework.clone()]);
    }
    if !test {
        if let Some(profile) = params.get("launchProfile").filter(|s| !s.is_empty()) {
            args.extend(["--launch-profile".into(), profile.clone()]);
        } else {
            args.push("--no-launch-profile".into());
        }
    }
    args
}
