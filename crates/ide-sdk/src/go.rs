//! Go build constraints shared by language services and command execution.
use ide_core::settings::GoBuildTags;
use serde_json::{Value, json};

pub fn custom_tags(tags: &str) -> Vec<&str> {
    tags.split(|c: char| c.is_whitespace() || c == ',').filter(|s| !s.is_empty()).collect()
}

/// The build category of gopls settings uses flat protocol keys (`buildFlags`, `env`).
/// Keep these in protocol settings so changes do not restart the server process.
pub fn build_settings(tags: &GoBuildTags) -> Value {
    let mut out = json!({});
    let mut flags = Vec::new();
    let mut selected = custom_tags(&tags.custom);
    if !tags.version.trim().is_empty() {
        selected.push(tags.version.trim());
    }
    if !selected.is_empty() {
        flags.push(format!("-tags={}", selected.join(",")));
    }
    if !tags.compiler.trim().is_empty() {
        flags.push(format!("-compiler={}", tags.compiler.trim()));
    }
    if !flags.is_empty() {
        out["buildFlags"] = json!(flags);
    }
    for (key, value) in [("GOOS", &tags.os), ("GOARCH", &tags.arch), ("CGO_ENABLED", &tags.cgo)] {
        if !value.trim().is_empty() {
            out["env"][key] = json!(value.trim());
        }
    }
    let experiments = tags.experiments.split(',').map(str::trim).filter(|s| !s.is_empty()).collect::<Vec<_>>();
    if !experiments.is_empty() {
        out["env"]["GOEXPERIMENT"] = json!(experiments.join(","));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_do_not_override_toolchain_or_existing_server_settings() {
        assert_eq!(build_settings(&GoBuildTags::default()), json!({}));
        assert!(custom_tags(" , \n ").is_empty());
    }

    #[test]
    fn constraints_map_to_protocol_build_settings() {
        let tags = GoBuildTags {
            os: "linux".into(),
            arch: "arm64".into(),
            version: "go1.22".into(),
            compiler: "gc".into(),
            cgo: "0".into(),
            custom: "integration debug,feature".into(),
            experiments: "loopvar, rangefunc ".into(),
        };
        assert_eq!(
            build_settings(&tags),
            json!({
                "buildFlags": ["-tags=integration,debug,feature,go1.22", "-compiler=gc"],
                "env": {"GOOS":"linux", "GOARCH":"arm64", "CGO_ENABLED":"0", "GOEXPERIMENT":"loopvar,rangefunc"}
            })
        );
    }
}

/// Project build constraints for Go command launches. Explicit run environment wins.
pub fn apply_to_run(config: &mut ide_run::RunConfig, tags: &GoBuildTags) {
    let settings = build_settings(tags);
    if let Some(env) = settings["env"].as_object() {
        for (key, value) in env {
            if let Some(value) = value.as_str() {
                config.env.entry(key.clone()).or_insert_with(|| value.into());
            }
        }
    }
    if config.extras.params.get("useTags").is_some_and(|v| v == "true") {
        let extra = settings["buildFlags"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|v| v.as_str())
            .map(str::to_owned)
            .collect::<Vec<_>>();
        let mut args = config.args.split_off(usize::from(!config.args.is_empty()));
        merge_flags(&mut args, &extra);
        config.args.extend(args);
    }
}

fn merge_flags(args: &mut Vec<String>, extra: &[String]) {
    let boundary = args.iter().position(|a| a == "-args" || a == "--").unwrap_or(args.len());
    let tail = args.split_off(boundary);
    let mut tags = Vec::new();
    let mut merged = Vec::new();
    let mut all = extra.iter().chain(args.iter());
    while let Some(arg) = all.next() {
        if arg == "-tags" {
            if let Some(value) = all.next() {
                tags.push(value.as_str());
            }
        } else if let Some(value) = arg.strip_prefix("-tags=") {
            tags.push(value);
        } else {
            merged.push(arg.clone());
        }
    }
    if !tags.is_empty() {
        merged.insert(0, format!("-tags={}", tags.join(",")));
    }
    merged.extend(tail);
    *args = merged;
}

fn delve_build_flags(args: &[String], files: bool) -> Value {
    if !files {
        return json!(args);
    }
    json!(
        args.iter()
            .map(|arg| format!("'{}'", arg.replace('\\', "\\\\").replace('\'', "\\'")))
            .collect::<Vec<_>>()
            .join(" ")
    )
}

/// An explicitly selected Go executable must also be the compiler Delve finds on PATH.
pub fn prepare_debug_compiler(
    env: &mut std::collections::BTreeMap<String, String>,
    extra_json: &Option<String>,
) -> ide_core::IdeResult<()> {
    #[cfg(windows)]
    for key in ["PATH", "GOROOT"] {
        if let Some(previous) = env.keys().find(|name| name.eq_ignore_ascii_case(key) && name.as_str() != key).cloned()
        {
            let value = env.remove(&previous).unwrap();
            env.entry(key.into()).or_insert(value);
        }
    }
    let extra: Value = extra_json.as_deref().and_then(|value| serde_json::from_str(value).ok()).unwrap_or_default();
    let Some(executable) = extra["__goExecutable"].as_str().filter(|value| *value != "go" && *value != "go.exe") else {
        return Ok(());
    };
    let path = env.get("PATH").map(std::ffi::OsString::from).unwrap_or_else(crate::exec::search_path);
    let executable = ide_core::process::find_executable(executable, &path)
        .ok_or_else(|| ide_core::IdeError::unavailable(format!("Go executable not found: {executable}")))?;
    if !executable.file_name().is_some_and(|name| {
        if cfg!(windows) {
            let name = name.to_string_lossy();
            name.eq_ignore_ascii_case("go") || name.eq_ignore_ascii_case("go.exe")
        } else {
            name == "go"
        }
    }) {
        return Err(ide_core::IdeError::invalid("Delve requires a Go SDK executable named go or go.exe"));
    }
    if !env.contains_key("GOROOT") {
        let mut command = std::process::Command::new(&executable);
        command.args(["env", "GOROOT"]).envs(env.iter());
        let goroot = crate::exec::query_command(command, std::time::Duration::from_secs(10))
            .ok_or_else(|| ide_core::IdeError::unavailable("Cannot query the selected Go SDK"))?;
        env.insert("GOROOT".into(), goroot);
    }
    let mut paths = vec![executable.parent().unwrap().to_path_buf()];
    paths.extend(std::env::split_paths(&path));
    let path = std::env::join_paths(paths).map_err(|error| ide_core::IdeError::invalid(error.to_string()))?;
    env.insert("PATH".into(), path.to_string_lossy().into_owned());
    Ok(())
}

fn resolve_debug_target(
    program: &mut Option<String>,
    env: &std::collections::BTreeMap<String, String>,
    extra: &mut Value,
    flags: &mut Vec<String>,
) -> ide_core::IdeResult<()> {
    let Some(targets) = extra.get("__goTargets") else { return Ok(()) };
    let targets: Vec<String> =
        serde_json::from_value(targets.clone()).map_err(|error| ide_core::IdeError::invalid(error.to_string()))?;
    let dir = extra["__goBuildDir"]
        .as_str()
        .map(std::path::Path::new)
        .ok_or_else(|| ide_core::IdeError::invalid("Go debug build directory is missing"))?;
    if targets.iter().any(|target| target.ends_with(".go")) {
        if !targets.iter().all(|target| target.ends_with(".go")) {
            return Err(ide_core::IdeError::invalid("Select Go source files or one package for debugging"));
        }
        let files: Vec<_> =
            targets.iter().map(|target| dunce::canonicalize(dir.join(target))).collect::<Result<_, _>>()?;
        let first = files.first().ok_or_else(|| ide_core::IdeError::invalid("Go debug target is missing"))?;
        if files.iter().any(|file| file.parent() != first.parent()) {
            return Err(ide_core::IdeError::invalid("Go source files must be in the same directory"));
        }
        *program = Some(first.to_string_lossy().into_owned());
        flags.extend(files.iter().skip(1).map(|file| file.to_string_lossy().into_owned()));
        extra["__goSourceArgs"] = json!(true);
        return Ok(());
    }
    let path = env.get("PATH").map(std::ffi::OsString::from).unwrap_or_else(crate::exec::search_path);
    let go = ide_core::process::find_executable("go", &path)
        .ok_or_else(|| ide_core::IdeError::unavailable("Go executable not found"))?;
    let mut command = std::process::Command::new(go);
    command.args(["list", "-find", "-f", "{{.Dir}}"]).current_dir(dir).envs(env.iter());
    let mut args = flags.iter();
    while let Some(flag) = args.next() {
        let name = flag.split('=').next().unwrap_or(flag);
        if ["-tags", "-mod", "-modfile", "-overlay", "-compiler"].contains(&name) {
            command.arg(flag);
            if name == flag
                && let Some(value) = args.next()
            {
                command.arg(value);
            }
        } else if ["-race", "-msan", "-asan"].contains(&name) {
            command.arg(flag);
        }
    }
    command.args(&targets);
    let output = crate::exec::query_command(command, std::time::Duration::from_secs(10)).ok_or_else(|| {
        ide_core::IdeError::invalid(format!(
            "Cannot resolve Go debug target: {}. Check its module path and build flags.",
            targets.join(" ")
        ))
    })?;
    let mut dirs: Vec<_> = output.lines().filter(|line| !line.trim().is_empty()).collect();
    dirs.sort();
    dirs.dedup();
    if dirs.len() != 1 {
        return Err(ide_core::IdeError::invalid(format!(
            "Go debugging requires one package; this target selects {}. Select a package or test instead.",
            dirs.len()
        )));
    }
    *program = Some(dirs[0].to_owned());
    Ok(())
}

pub fn apply_to_debug(
    program: &mut Option<String>,
    env: &mut std::collections::BTreeMap<String, String>,
    extra_json: &mut Option<String>,
    tags: &GoBuildTags,
) -> ide_core::IdeResult<()> {
    let mut extra: Value = extra_json
        .as_deref()
        .map(serde_json::from_str)
        .transpose()
        .map_err(|e| ide_core::IdeError::invalid(e.to_string()))?
        .unwrap_or_else(|| json!({}));
    let settings = build_settings(tags);
    if let Some(values) = settings["env"].as_object() {
        for (key, value) in values {
            if let Some(value) = value.as_str() {
                env.entry(key.clone()).or_insert_with(|| value.into());
            }
        }
    }
    if extra.get("__goToolArgs").is_some() {
        let mut args: Vec<String> = extra
            .get("__goToolArgs")
            .cloned()
            .map(serde_json::from_value)
            .transpose()
            .map_err(|e| ide_core::IdeError::invalid(e.to_string()))?
            .unwrap_or_default();
        if extra.get("__goUseTags").and_then(Value::as_bool) == Some(true) {
            let flags = settings["buildFlags"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect::<Vec<_>>();
            merge_flags(&mut args, &flags);
        }
        resolve_debug_target(program, env, &mut extra, &mut args)?;
        if let Some(files) = extra.get("__goFiles").and_then(Value::as_array) {
            if extra["mode"] == "test" {
                if let Some(dir) = files.first().and_then(Value::as_str).and_then(|f| std::path::Path::new(f).parent())
                {
                    let mut command = std::process::Command::new("go");
                    ide_core::process::host_env(&mut command);
                    command.envs(env.iter());
                    let sources = ide_run::go::package_sources(command, dir, &args)?;
                    args.extend(sources.iter().map(|p| p.to_string_lossy().into_owned()));
                }
            } else {
                args.extend(files.iter().skip(1).filter_map(Value::as_str).map(str::to_owned));
            }
        }
        // Delve appends its -o after array build flags; positional source files
        // require the string form so all compiler flags precede the file list.
        extra["buildFlags"] =
            delve_build_flags(&args, extra.get("__goFiles").is_some() || extra["__goSourceArgs"] == true);
    }
    if let Some(output) = extra.get("output").and_then(Value::as_str).and_then(|p| std::path::Path::new(p).parent()) {
        std::fs::create_dir_all(output)?;
    }
    if let Some(map) = extra.as_object_mut() {
        map.remove("__goUseTags");
        map.remove("__goToolArgs");
        map.remove("__goFiles");
        map.remove("__goExecutable");
        map.remove("__goTargets");
        map.remove("__goBuildDir");
        map.remove("__goSourceArgs");
    }
    *extra_json = Some(extra.to_string());
    Ok(())
}

#[cfg(test)]
mod command_tests {
    use super::*;
    use std::collections::BTreeMap;

    #[test]
    fn debug_targets_resolve_imports_and_reject_multiple_packages() {
        if crate::exec::which("go").is_none() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(tmp.path()).unwrap();
        std::fs::write(root.join("go.mod"), "module example.com/debugtargets\ngo 1.22\n").unwrap();
        for name in ["a", "b"] {
            std::fs::create_dir(root.join(name)).unwrap();
            std::fs::write(root.join(name).join("lib.go"), "package p\nfunc Value() {}\n").unwrap();
        }
        let mut env = BTreeMap::from([("GOWORK".into(), "off".into())]);
        let launch = |target: &str| {
            Some(json!({"mode":"test", "__goToolArgs":[], "__goTargets":[target], "__goBuildDir":root}).to_string())
        };
        let mut program = None;
        let mut extra = launch("example.com/debugtargets/a");
        apply_to_debug(&mut program, &mut env, &mut extra, &GoBuildTags::default()).unwrap();
        assert_eq!(program.as_deref(), root.join("a").to_str());
        let value: Value = serde_json::from_str(extra.as_deref().unwrap()).unwrap();
        assert!(value.get("__goTargets").is_none());
        let error = apply_to_debug(&mut program, &mut env, &mut launch("./..."), &GoBuildTags::default()).unwrap_err();
        assert!(error.to_string().contains("requires one package"), "{error}");
        std::fs::write(root.join("main.go"), "package main\nfunc main(){helper()}\n").unwrap();
        std::fs::write(root.join("helper.go"), "package main\nfunc helper(){}\n").unwrap();
        let mut extra = Some(
            json!({"mode":"debug","__goBuildDir":root,"__goTargets":["main.go","helper.go"],"__goToolArgs":[]})
                .to_string(),
        );
        apply_to_debug(&mut program, &mut env, &mut extra, &GoBuildTags::default()).unwrap();
        assert_eq!(program.as_deref(), root.join("main.go").to_str());
        let value: Value = serde_json::from_str(extra.as_deref().unwrap()).unwrap();
        assert_eq!(value["buildFlags"], format!("'{}'", root.join("helper.go").to_string_lossy()));
    }

    #[cfg(windows)]
    #[test]
    fn compiler_selection_preserves_case_insensitive_windows_environment_keys() {
        let mut env =
            BTreeMap::from([("Path".into(), "explicit path".into()), ("GoRoot".into(), "explicit root".into())]);
        prepare_debug_compiler(&mut env, &None).unwrap();
        assert_eq!(env["PATH"], "explicit path");
        assert_eq!(env["GOROOT"], "explicit root");
        assert!(!env.contains_key("Path"));
        assert!(!env.contains_key("GoRoot"));
    }

    #[test]
    fn the_selected_go_compiler_precedes_the_existing_path() {
        let Some(go) = crate::exec::which("go") else {
            return;
        };
        let mut env = BTreeMap::from([("PATH".into(), "/unrelated".into())]);
        let extra = Some(json!({"__goExecutable":go}).to_string());
        prepare_debug_compiler(&mut env, &extra).unwrap();
        assert_eq!(std::env::split_paths(&env["PATH"]).next().as_deref(), go.parent());
        assert!(!env["GOROOT"].is_empty());
        env.insert("GOROOT".into(), "explicit".into());
        prepare_debug_compiler(&mut env, &extra).unwrap();
        assert_eq!(env["GOROOT"], "explicit");
    }

    #[test]
    fn merges_custom_tags_without_touching_program_arguments() {
        let mut flags = vec!["-tags".into(), "explicit".into(), ".".into(), "-args".into(), "-tags=program".into()];
        merge_flags(&mut flags, &["-tags=project,debug".into()]);
        assert_eq!(flags, ["-tags=project,debug,explicit", ".", "-args", "-tags=program"]);
    }

    #[test]
    fn file_debug_flags_keep_delves_output_flags_before_source_files() {
        let flags = vec!["-tags=demo".into(), "C:\\a b\\main.go".into(), "quote'file.go".into()];
        assert_eq!(delve_build_flags(&flags, false), json!(flags));
        assert_eq!(delve_build_flags(&flags, true), json!("'-tags=demo' 'C:\\\\a b\\\\main.go' 'quote\\'file.go'"));
    }

    #[test]
    fn debug_env_and_flags_use_the_same_constraints_and_preserve_overrides() {
        let tags = GoBuildTags { custom: "project".into(), os: "linux".into(), ..Default::default() };
        let mut env = BTreeMap::from([("GOOS".into(), "darwin".into())]);
        let mut extra =
            Some(json!({"mode":"test", "__goUseTags":true, "__goToolArgs":["-tags", "explicit"]}).to_string());
        apply_to_debug(&mut None, &mut env, &mut extra, &tags).unwrap();
        let extra: Value = serde_json::from_str(extra.as_deref().unwrap()).unwrap();
        assert_eq!(extra["buildFlags"], json!(["-tags=project,explicit"]));
        assert!(extra.get("__goUseTags").is_none());
        assert_eq!(env["GOOS"], "darwin");
        assert!(apply_to_debug(&mut None, &mut env, &mut Some("{".into()), &tags).is_err());
    }
}

pub fn debug_environment(
    root: &std::path::Path,
    settings: &ide_core::settings::Settings,
    env: &mut std::collections::BTreeMap<String, String>,
) {
    for (key, value) in module_environment(root, &settings.languages.go.modules) {
        env.entry(key).or_insert(value);
    }
    if let Some(goroot) = crate::apply::goroot(root, settings) {
        env.entry("GOROOT".into()).or_insert_with(|| goroot.to_string_lossy().into_owned());
        env.entry("PATH".into()).or_insert_with(|| crate::exec::path_with(&[&goroot.join("bin")]));
    }
    if let Some(gopath) = crate::apply::setting_path(root, &settings.languages.go.gopath) {
        env.entry("GOPATH".into()).or_insert_with(|| gopath.to_string_lossy().into_owned());
    }
}

pub fn module_environment(
    root: &std::path::Path,
    modules: &ide_core::settings::GoModules,
) -> std::collections::BTreeMap<String, String> {
    let mut env: std::collections::BTreeMap<String, String> = modules
        .env
        .iter()
        .filter(|(key, value)| {
            !key.is_empty()
                && !key.contains(['=', '\0'])
                && !key.contains(char::is_whitespace)
                && !value.trim().is_empty()
                && !value.contains('\0')
        })
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect();
    for key in ["GOWORK", "GOMODCACHE"] {
        if let Some(value) = env.get_mut(key)
            && value != "off"
            && value != "auto"
        {
            *value = root.join(value.as_str()).to_string_lossy().into_owned();
        }
    }
    if !modules.auto_vendor {
        let flags = env
            .get("GOFLAGS")
            .cloned()
            .or_else(|| ide_core::process::host_var_os("GOFLAGS").map(|v| v.to_string_lossy().into_owned()))
            .unwrap_or_default();
        if !flags.split_whitespace().any(|flag| flag.starts_with("-mod=")) {
            let workspace = match env.get("GOWORK").map(String::as_str) {
                Some("off") => false,
                Some(path) if path != "auto" => !path.is_empty(),
                _ => root.ancestors().any(|dir| dir.join("go.work").is_file()),
            };
            env.insert(
                "GOFLAGS".into(),
                format!("{} -mod={}", flags.trim(), if workspace { "readonly" } else { "mod" }).trim().into(),
            );
        }
    }
    env
}

#[cfg(test)]
mod module_tests {
    use super::*;
    use ide_core::settings::GoModules;
    use std::collections::BTreeMap;

    #[test]
    fn defaults_and_invalid_entries_leave_the_environment_unchanged() {
        let dir = tempfile::tempdir().unwrap();
        assert!(module_environment(dir.path(), &GoModules::default()).is_empty());
        let modules = GoModules {
            env: BTreeMap::from([
                ("BAD KEY".into(), "x".into()),
                ("GOPROXY".into(), "".into()),
                ("GOPRIVATE".into(), "example.com/private".into()),
            ]),
            ..Default::default()
        };
        assert_eq!(
            module_environment(dir.path(), &modules),
            BTreeMap::from([("GOPRIVATE".into(), "example.com/private".into())])
        );
    }

    #[test]
    fn disabling_automatic_vendor_uses_workspace_legal_flags_and_keeps_explicit_flags() {
        let dir = tempfile::tempdir().unwrap();
        let mut modules = GoModules { auto_vendor: false, env: BTreeMap::from([("GOFLAGS".into(), "-race".into())]) };
        assert_eq!(module_environment(dir.path(), &modules)["GOFLAGS"], "-race -mod=mod");
        std::fs::write(dir.path().join("go.work"), "go 1.22\n").unwrap();
        assert_eq!(module_environment(dir.path(), &modules)["GOFLAGS"], "-race -mod=readonly");
        modules.env.insert("GOWORK".into(), "off".into());
        assert_eq!(module_environment(dir.path(), &modules)["GOFLAGS"], "-race -mod=mod");
        modules.env.insert("GOFLAGS".into(), "-mod=vendor".into());
        assert_eq!(module_environment(dir.path(), &modules)["GOFLAGS"], "-mod=vendor");
    }
}
