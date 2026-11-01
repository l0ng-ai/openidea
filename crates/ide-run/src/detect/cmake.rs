//! CMake targets come from the File API codemodel, including evaluated subdirectories.

use super::{ConfigExt, config};
use crate::{BeforeLaunchTask, RunConfig};
use ide_core::settings::CMakeProfile;
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

pub(super) fn detect(root: &Path, profiles: Option<&[CMakeProfile]>, out: &mut Vec<RunConfig>) {
    if !root.join("CMakeLists.txt").is_file() {
        return;
    }
    if let Some(profiles) = profiles {
        for (index, profile) in profiles.iter().enumerate() {
            detect_profile(root, profile, index, profiles.len() > 1, out);
        }
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
        targets(root, &build, &dir, &prefix, None, out);
    }
}

fn arguments(value: &str) -> Vec<String> {
    shlex::split(value).unwrap_or_else(|| vec![value.to_owned()])
}

fn detect_profile(root: &Path, profile: &CMakeProfile, index: usize, multiple: bool, out: &mut Vec<RunConfig>) {
    let dir = if profile.build_dir.trim().is_empty() {
        format!("cmake-build-{}", profile.build_type.to_lowercase())
    } else {
        profile.build_dir.clone()
    };
    let build = root.join(&dir);
    let prefix = format!("cmake:profile:{index}");
    let configure_id = format!("{prefix}:configure");
    let build_id = format!("{prefix}:build");
    let start = out.len();
    let mut configure =
        config(&configure_id, format!("CMake Configure ({dir})"), "cmake", "cmake", &["-S", ".", "-B", &dir]);
    if !profile.generator.trim().is_empty() {
        configure.args.extend(["-G".into(), profile.generator.clone()]);
    }
    configure.args.push(format!("-DCMAKE_BUILD_TYPE={}", profile.build_type));
    configure.args.push("-DCMAKE_EXPORT_COMPILE_COMMANDS=ON".into());
    configure.args.extend(arguments(&profile.cmake_args));
    configure.extras.params.insert("buildDir".into(), dir.clone());
    out.push(configure);
    let mut all = config(
        &build_id,
        format!("CMake Build ({dir})"),
        "cmake",
        "cmake",
        &["--build", &dir, "--config", &profile.build_type],
    );
    all.args.extend(arguments(&profile.build_args));
    before(&mut all, &configure_id);
    out.push(all);
    let mut test = config(
        format!("{prefix}:test"),
        format!("CTest ({dir})"),
        "cmake",
        "ctest",
        &["--test-dir", &dir, "-C", &profile.build_type, "--output-on-failure"],
    );
    before(&mut test, &build_id);
    out.push(test);
    targets(root, &build, &dir, &prefix, Some(profile), out);
    for config in &mut out[start..] {
        config.env = profile.env.clone();
        if multiple {
            config.name = format!("{} [{}]", config.name, profile.name);
        }
    }
}

fn targets(
    root: &Path,
    build: &Path,
    dir: &str,
    prefix: &str,
    profile: Option<&CMakeProfile>,
    out: &mut Vec<RunConfig>,
) {
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
        if profile.is_some_and(|p| !name.is_empty() && name != p.build_type) {
            continue;
        }
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
            let mut build_config =
                config(&target_build_id, format!("Build {target_name} ({dir} {name})"), "cmake", "cmake", &args);
            if let Some(profile) = profile {
                if name.is_empty() {
                    build_config.args.extend(["--config".into(), profile.build_type.clone()]);
                }
                build_config.args.extend(arguments(&profile.build_args));
                before(&mut build_config, &format!("{prefix}:configure"));
            }
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
        let build = cwd.join(dir);
        let generator = config.args.windows(2).find(|a| a[0] == "-G").map(|a| a[1].as_str());
        if let Some(generator) = generator
            && let Ok(cache) = fs::read_to_string(build.join("CMakeCache.txt"))
            && let Some(cached) = cache.lines().find_map(|l| l.strip_prefix("CMAKE_GENERATOR:INTERNAL="))
            && cached != generator
        {
            fs::remove_file(build.join("CMakeCache.txt"))?;
            let files = build.join("CMakeFiles");
            if files.is_dir() {
                fs::remove_dir_all(files)?;
            }
        }
        let query = build.join(".cmake/api/v1/query/client-openidea");
        fs::create_dir_all(&query)?;
        fs::write(query.join("codemodel-v2"), "")?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profiles_select_file_api_configuration_and_apply_target_options() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("CMakeLists.txt"), "project(app)").unwrap();
        let reply = root.path().join("output/.cmake/api/v1/reply");
        fs::create_dir_all(&reply).unwrap();
        let write = |name: &str, value: Value| fs::write(reply.join(name), value.to_string()).unwrap();
        write(
            "index-1.json",
            serde_json::json!({"objects":[{"kind":"codemodel","version":{"major":2},"jsonFile":"model.json"}]}),
        );
        write(
            "model.json",
            serde_json::json!({"paths":{"source":root.path()},"configurations":[
                {"name":"Debug","targets":[{"jsonFile":"debug.json"}]},
                {"name":"Release","targets":[{"jsonFile":"release.json"}]}
            ]}),
        );
        for name in ["debug", "release"] {
            write(
                &format!("{name}.json"),
                serde_json::json!({"name":"app","type":"EXECUTABLE","artifacts":[{"path":format!("{name}/app")}]}),
            );
        }
        let profile = CMakeProfile {
            name: "Production".into(),
            build_type: "Release".into(),
            build_dir: "output".into(),
            build_args: "-j 8 -- verbose=1".into(),
            env: [("FOO".into(), "bar".into())].into(),
            ..Default::default()
        };
        let mut configs = Vec::new();
        detect(root.path(), Some(std::slice::from_ref(&profile)), &mut configs);
        let run = configs.iter().find(|c| c.kind == "native").unwrap();
        assert!(run.command.ends_with("release/app"));
        assert_eq!(run.env, profile.env);
        assert_eq!(configs.iter().filter(|c| c.kind == "native").count(), 1);
        let build = configs.iter().find(|c| c.id == run.extras.before_launch[0].target).unwrap();
        assert_eq!(
            build.args,
            ["--build", "output", "--target", "app", "--config", "Release", "-j", "8", "--", "verbose=1"]
        );
        assert_eq!(build.env, profile.env);
        assert_eq!(build.extras.before_launch[0].target, "cmake:profile:0:configure");
    }

    #[test]
    fn generator_change_clears_only_cmake_state_at_launch() {
        let root = tempfile::tempdir().unwrap();
        let build = root.path().join("cmake-build-debug");
        fs::create_dir_all(build.join("CMakeFiles")).unwrap();
        fs::write(build.join("CMakeCache.txt"), "CMAKE_GENERATOR:INTERNAL=Unix Makefiles\n").unwrap();
        fs::write(build.join("keep.txt"), "artifact").unwrap();
        fs::write(root.path().join("CMakeLists.txt"), "project(app)").unwrap();
        let mut configs = Vec::new();
        detect(root.path(), Some(&[CMakeProfile { generator: "Ninja".into(), ..Default::default() }]), &mut configs);
        assert!(build.join("CMakeCache.txt").exists());
        prepare(&configs[0], root.path()).unwrap();
        assert!(!build.join("CMakeCache.txt").exists());
        assert!(!build.join("CMakeFiles").exists());
        assert!(build.join("keep.txt").exists());
        assert!(build.join(".cmake/api/v1/query/client-openidea/codemodel-v2").exists());
    }
}
