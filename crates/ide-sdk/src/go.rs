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
