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

pub fn apply_to_debug(
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
        extra["buildFlags"] = json!(args);
    }
    if let Some(output) = extra.get("output").and_then(Value::as_str).and_then(|p| std::path::Path::new(p).parent()) {
        std::fs::create_dir_all(output)?;
    }
    if let Some(map) = extra.as_object_mut() {
        map.remove("__goUseTags");
        map.remove("__goToolArgs");
        map.remove("__goFiles");
    }
    *extra_json = Some(extra.to_string());
    Ok(())
}

#[cfg(test)]
mod command_tests {
    use super::*;
    use std::collections::BTreeMap;

    #[test]
    fn merges_custom_tags_without_touching_program_arguments() {
        let mut flags = vec!["-tags".into(), "explicit".into(), ".".into(), "-args".into(), "-tags=program".into()];
        merge_flags(&mut flags, &["-tags=project,debug".into()]);
        assert_eq!(flags, ["-tags=project,debug,explicit", ".", "-args", "-tags=program"]);
    }

    #[test]
    fn debug_env_and_flags_use_the_same_constraints_and_preserve_overrides() {
        let tags = GoBuildTags { custom: "project".into(), os: "linux".into(), ..Default::default() };
        let mut env = BTreeMap::from([("GOOS".into(), "darwin".into())]);
        let mut extra =
            Some(json!({"mode":"test", "__goUseTags":true, "__goToolArgs":["-tags", "explicit"]}).to_string());
        apply_to_debug(&mut env, &mut extra, &tags).unwrap();
        let extra: Value = serde_json::from_str(extra.as_deref().unwrap()).unwrap();
        assert_eq!(extra["buildFlags"], json!(["-tags=project,explicit"]));
        assert!(extra.get("__goUseTags").is_none());
        assert_eq!(env["GOOS"], "darwin");
        assert!(apply_to_debug(&mut env, &mut Some("{".into()), &tags).is_err());
    }
}

pub fn debug_environment(
    root: &std::path::Path,
    settings: &ide_core::settings::Settings,
    env: &mut std::collections::BTreeMap<String, String>,
) {
    if let Some(goroot) = crate::apply::goroot(root, settings) {
        env.entry("GOROOT".into()).or_insert_with(|| goroot.to_string_lossy().into_owned());
        env.entry("PATH".into()).or_insert_with(|| crate::exec::path_with(&[&goroot.join("bin")]));
    }
    if let Some(gopath) = crate::apply::setting_path(root, &settings.languages.go.gopath) {
        env.entry("GOPATH".into()).or_insert_with(|| gopath.to_string_lossy().into_owned());
    }
}
