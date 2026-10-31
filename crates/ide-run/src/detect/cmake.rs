//! CMake targets come from the File API codemodel, including evaluated subdirectories.

use super::{ConfigExt, config};
use crate::{BeforeLaunchTask, RunConfig};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};

fn json(path: &Path) -> Option<Value> {
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}

fn reply_file(reply: &Path, name: &str) -> Option<Value> {
    // File API references are file names, never paths outside the reply directory.
    (Path::new(name).components().count() == 1).then(|| json(&reply.join(name))).flatten()
}

fn before(config: &mut RunConfig, id: &str) {
    config.extras.before_launch.push(BeforeLaunchTask { kind: "run".into(), target: id.into() });
}

pub(super) fn detect(root: &Path, out: &mut Vec<RunConfig>) {
    if !root.join("CMakeLists.txt").is_file() {
        return;
    }
    let mut builds = Vec::new();
    if let Ok(entries) = fs::read_dir(root) {
        builds.extend(entries.flatten().filter_map(|e| {
            let p = e.path();
            (p.is_dir() && p.join("CMakeCache.txt").is_file()).then_some(p)
        }));
    }
    if builds.is_empty() {
        builds.push(root.join("build"));
    }
    builds.sort();
    builds.dedup();
    for build in builds {
        let dir = build.strip_prefix(root).unwrap_or(&build).to_string_lossy().replace('\\', "/");
        let configuration = fs::read_to_string(build.join("CMakeCache.txt"))
            .ok()
            .and_then(|cache| {
                let values = cache.lines().find_map(|line| line.strip_prefix("CMAKE_CONFIGURATION_TYPES:STRING="))?;
                Some(if values.split(';').any(|c| c == "Debug") {
                    "Debug".to_owned()
                } else {
                    values.split(';').find(|s| !s.is_empty())?.to_owned()
                })
            })
            .unwrap_or_else(|| "Debug".into());
        let prefix = format!("cmake:{dir}");
        let configure_id = format!("{prefix}:configure");
        let build_id = format!("{prefix}:build");
        let mut args = vec!["-S", ".", "-B", &dir, "-DCMAKE_EXPORT_COMPILE_COMMANDS=ON"];
        if !build.join("CMakeCache.txt").is_file() {
            args.push("-DCMAKE_BUILD_TYPE=Debug");
        }
        let mut configure = config(&configure_id, format!("CMake Configure ({dir})"), "cmake", "cmake", &args);
        configure.extras.params.insert("buildDir".into(), dir.clone());
        out.push(configure);
        let mut all = config(
            &build_id,
            format!("CMake Build ({dir})"),
            "cmake",
            "cmake",
            &["--build", &dir, "--config", &configuration],
        );
        // `cmake --build` regenerates by itself once a build directory is configured.
        if !build.join("CMakeCache.txt").is_file() {
            before(&mut all, &configure_id);
        }
        out.push(all);
        let mut test = config(
            format!("{prefix}:test"),
            format!("CTest ({dir})"),
            "cmake",
            "ctest",
            &["--test-dir", &dir, "-C", &configuration, "--output-on-failure"],
        );
        before(&mut test, &build_id);
        out.push(test);
        targets(root, &build, &dir, &prefix, out);
    }
}

fn targets(root: &Path, build: &Path, dir: &str, prefix: &str, out: &mut Vec<RunConfig>) {
    let reply = build.join(".cmake/api/v1/reply");
    let Some(index_path) = fs::read_dir(&reply).ok().and_then(|entries| {
        entries
            .flatten()
            .map(|e| e.path())
            .filter(|p| {
                let name = p.file_name().unwrap_or_default().to_string_lossy();
                name.starts_with("index-") && name.ends_with(".json")
            })
            .max()
    }) else {
        return;
    };
    let Some(index) = json(&index_path) else { return };
    let Some(reference) = index["objects"]
        .as_array()
        .and_then(|a| a.iter().find(|o| o["kind"] == "codemodel" && o["version"]["major"] == 2))
    else {
        return;
    };
    let Some(model) = reference["jsonFile"].as_str().and_then(|n| reply_file(&reply, n)) else { return };
    let Some(configurations) = model["configurations"].as_array() else { return };
    let source_root = model["paths"]["source"].as_str().map(PathBuf::from).unwrap_or_else(|| root.into());
    if source_root.canonicalize().ok() != root.canonicalize().ok() {
        return;
    }
    let source_root = dunce::canonicalize(&source_root).unwrap_or(source_root);
    for configuration in configurations {
        let name = configuration["name"].as_str().unwrap_or("");
        let Some(targets) = configuration["targets"].as_array() else { continue };
        for target in targets {
            let Some(target) = target["jsonFile"].as_str().and_then(|n| reply_file(&reply, n)) else { continue };
            if target["type"] != "EXECUTABLE" {
                continue;
            }
            let (Some(target_name), Some(artifact)) =
                (target["name"].as_str(), target["artifacts"][0]["path"].as_str())
            else {
                continue;
            };
            let id = format!("{prefix}:{name}:{target_name}");
            let target_build_id = format!("{id}:build");
            let mut args = vec!["--build", dir, "--target", target_name];
            if !name.is_empty() {
                args.extend(["--config", name]);
            }
            let build_config =
                config(&target_build_id, format!("Build {target_name} ({dir} {name})"), "cmake", "cmake", &args);
            out.push(build_config);
            let binary = build.join(artifact);
            let mut run =
                config(&id, format!("{target_name} ({dir} {name})"), "native", &binary.to_string_lossy(), &[])
                    .debug("lldb-dap");
            before(&mut run, &target_build_id);
            let sources: Vec<String> = target["sources"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|s| {
                    let p = source_root.join(s["path"].as_str()?);
                    Some(p.to_string_lossy().replace('\\', "/"))
                })
                .collect();
            run.extras.params.insert("cmakeSources".into(), sources.join("\n"));
            if let Some(recorded) = model["paths"]["source"].as_str() {
                run.extras.params.insert("cmakeSourceRoot".into(), recorded.into());
                run.extras
                    .params
                    .insert("cmakeCanonicalSourceRoot".into(), source_root.to_string_lossy().replace('\\', "/"));
            }
            out.push(run);
        }
    }
}

/// Request the codemodel only when the user runs a configure configuration.
pub(crate) fn prepare(config: &RunConfig, cwd: &Path) -> crate::IdeResult<()> {
    if config.kind == "cmake"
        && config.args.first().is_some_and(|a| a == "-S")
        && let Some(dir) = config.extras.params.get("buildDir")
    {
        let query = cwd.join(dir).join(".cmake/api/v1/query/client-openidea");
        fs::create_dir_all(&query)?;
        fs::write(query.join("codemodel-v2"), "")?;
    }
    Ok(())
}
