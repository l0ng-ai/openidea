//! Docker Compose content detection and `yaml-language-server` schema association
//! for open YAML documents whose filename does not already match `*compose*.y(a)ml`.

use ide_language::{COMPOSE_SCHEMA_URL, LanguageServerConfig};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

pub const SERVER: &str = "yaml-language-server";

const TOP_SECTIONS: &[&str] = &["version", "name", "networks", "volumes", "configs", "secrets", "include"];

const SERVICE_KEYS: &[&str] = &[
    "image",
    "build",
    "container_name",
    "hostname",
    "domainname",
    "ports",
    "expose",
    "environment",
    "env_file",
    "volumes",
    "volumes_from",
    "networks",
    "network_mode",
    "depends_on",
    "command",
    "entrypoint",
    "restart",
    "pull_policy",
    "healthcheck",
    "deploy",
    "develop",
    "labels",
    "annotations",
    "platform",
    "profiles",
    "user",
    "working_dir",
    "privileged",
    "read_only",
    "stdin_open",
    "tty",
    "init",
    "cap_add",
    "cap_drop",
    "cgroup",
    "cgroup_parent",
    "configs",
    "secrets",
    "cpus",
    "cpu_count",
    "cpu_percent",
    "cpu_shares",
    "cpu_period",
    "cpu_quota",
    "cpuset",
    "devices",
    "dns",
    "dns_opt",
    "dns_search",
    "extends",
    "external_links",
    "extra_hosts",
    "group_add",
    "ipc",
    "isolation",
    "links",
    "logging",
    "mac_address",
    "mem_limit",
    "mem_reservation",
    "oom_kill_disable",
    "oom_score_adj",
    "pid",
    "pids_limit",
    "post_start",
    "pre_stop",
    "runtime",
    "scale",
    "security_opt",
    "shm_size",
    "stop_grace_period",
    "stop_signal",
    "storage_opt",
    "sysctls",
    "tmpfs",
    "ulimits",
    "userns_mode",
    "uts",
];

fn parse_key(trimmed: &str) -> Option<&str> {
    let colon = trimmed.find(':')?;
    let after = &trimmed[colon + 1..];
    if !after.is_empty() && !after.starts_with(char::is_whitespace) {
        return None;
    }
    let key = trimmed[..colon].trim_end();
    let key = key
        .strip_prefix('"')
        .and_then(|s| s.strip_suffix('"'))
        .or_else(|| key.strip_prefix('\'').and_then(|s| s.strip_suffix('\'')))
        .unwrap_or(key);
    (!key.is_empty() && key.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-')))
        .then_some(key)
}

/// Whether `path`'s filename already matches the Compose schema globs in `languages/yaml.toml`.
pub fn is_named_compose_file(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|n| n.to_str()) else { return false };
    let Some(stem) = name.strip_suffix(".yaml").or_else(|| name.strip_suffix(".yml")) else {
        return false;
    };
    // `<head>` or `<head>.*`, where `<head>` is `compose`, `docker-compose`, `*-compose` or `*.compose`.
    let is_head = |head: &str| {
        head == "compose"
            || head == "docker-compose"
            || head.strip_suffix("-compose").is_some_and(|p| !p.is_empty())
            || head.strip_suffix(".compose").is_some_and(|p| !p.is_empty())
    };
    is_head(stem) || stem.match_indices('.').any(|(i, _)| i + 1 < stem.len() && is_head(&stem[..i]))
}

/// Whether `path` is a YAML file whose name does not match a Compose glob, but whose content is Compose.
pub fn is_content_detected_compose_file(path: &Path, text: &str) -> bool {
    !is_named_compose_file(path) && is_compose_content(text)
}

/// Whether `text` looks like a Docker Compose YAML configuration.
pub fn is_compose_content(text: &str) -> bool {
    let mut has_services = false;
    let mut has_compose_top = false;
    let mut has_api_version = false;
    let mut has_kind = false;
    let mut has_on = false;
    let mut has_jobs = false;
    let mut in_services = false;
    let mut service_indent = None;
    let mut prop_indent = None;
    let mut has_service_prop = false;

    for raw in text.lines().take(600) {
        let line = raw.trim_end_matches('\r');
        let trimmed = line.trim_start();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let lead = line.len() - trimmed.len();
        if lead == 0 {
            in_services = false;
            if let Some(key) = parse_key(trimmed) {
                if matches!(key, "openapi" | "swagger" | "AWSTemplateFormatVersion") {
                    return false;
                }
                has_api_version |= key == "apiVersion";
                has_kind |= key == "kind";
                has_on |= key == "on";
                has_jobs |= key == "jobs";
                if (has_api_version && has_kind) || (has_on && has_jobs) {
                    return false;
                }
                if key == "services" {
                    has_services = true;
                    in_services = true;
                    service_indent = None;
                    prop_indent = None;
                } else if TOP_SECTIONS.contains(&key) || key.starts_with("x-") {
                    has_compose_top = true;
                }
            }
            continue;
        }
        if in_services && !has_service_prop {
            let svc_indent = *service_indent.get_or_insert(lead);
            if lead == svc_indent {
                prop_indent = None;
            } else if lead > svc_indent {
                let p_indent = *prop_indent.get_or_insert(lead);
                if lead == p_indent
                    && let Some(prop) = parse_key(trimmed)
                    && (SERVICE_KEYS.contains(&prop) || prop.starts_with("x-"))
                {
                    has_service_prop = true;
                }
            }
        }
    }
    has_services && (has_compose_top || has_service_prop)
}

/// Appends open content-detected Compose files to `yaml-language-server`'s
/// `yaml.schemas[COMPOSE_SCHEMA_URL]` unless excluded by user settings.
pub fn configure_yaml_compose_schemas(cfg: &mut LanguageServerConfig, compose_files: &[PathBuf]) {
    if cfg.name != SERVER || compose_files.is_empty() {
        return;
    }
    let mut settings = cfg.settings.take().filter(Value::is_object).unwrap_or_else(|| json!({}));
    let schemas = settings
        .as_object_mut()
        .expect("object")
        .entry("yaml")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .and_then(|yaml| yaml.entry("schemas").or_insert_with(|| json!({})).as_object_mut());
    if let Some(schemas) = schemas {
        let entry = schemas.entry(COMPOSE_SCHEMA_URL).or_insert_with(|| json!([]));
        if let Value::String(single) = entry {
            *entry = json!([single.clone()]);
        }
        if let Some(list) = entry.as_array_mut() {
            for path in compose_files {
                let p = path.to_string_lossy().replace('\\', "/");
                let negated = format!("!{p}");
                if list.iter().any(|v| v.as_str() == Some(&p) || v.as_str() == Some(&negated)) {
                    continue;
                }
                list.push(Value::String(p));
            }
        }
    }
    cfg.settings = Some(settings);
}

#[cfg(test)]
mod tests {
    use super::*;
    use ide_language::LanguageRegistry;

    #[test]
    fn detects_compose_content_and_ignores_other_manifests() {
        assert!(is_compose_content("services:\n  db:\n    image: postgres:16\n"));
        assert!(is_compose_content("version: \"3.9\"\nservices:\n  app:\n    foo: bar\n"));
        assert!(!is_compose_content("apiVersion: v1\nkind: Service\nservices:\n  db:\n    image: x\n"));
        assert!(!is_compose_content("on: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n"));
        assert!(is_named_compose_file(Path::new("/work/docker-compose.yml")));
        assert!(is_named_compose_file(Path::new("/work/playground-compose.yaml")));
        assert!(!is_named_compose_file(Path::new("/work/custom-stack.yml")));
        for named in
            ["compose.yaml", "compose.override.yml", "docker-compose.prod.yaml", "a.compose.yml", "x-compose.ci.yml"]
        {
            assert!(is_named_compose_file(Path::new(named)), "{named}");
        }
        for unnamed in ["docker-compose-dev.yml", "compose-prod.yaml", "composer.yml", "decompose.yaml", "-compose.yml"]
        {
            assert!(!is_named_compose_file(Path::new(unnamed)), "{unnamed}");
        }
        assert!(is_content_detected_compose_file(
            Path::new("/work/docker-compose-dev.yml"),
            "services:\n  db:\n    image: postgres:16\n"
        ));
        assert!(!is_content_detected_compose_file(
            Path::new("/work/docker-compose.yml"),
            "services:\n  db:\n    image: postgres:16\n"
        ));
        assert!(is_content_detected_compose_file(
            Path::new("/work/custom-stack.yml"),
            "services:\n  db:\n    image: postgres:16\n"
        ));
    }

    #[test]
    fn merges_content_detected_files_into_yaml_schemas_unless_excluded() {
        let reg = LanguageRegistry::load(None).unwrap();
        let yaml = reg.get(&ide_core::LanguageId::new("yaml")).unwrap();
        let mut cfg = yaml.language_servers[0].clone();
        let a = PathBuf::from("/work/custom-stack.yml");
        let b = PathBuf::from("/work/excluded.yml");
        cfg.settings.as_mut().unwrap()["yaml"]["schemas"][COMPOSE_SCHEMA_URL]
            .as_array_mut()
            .unwrap()
            .push(json!("!/work/excluded.yml"));

        configure_yaml_compose_schemas(&mut cfg, &[a, b]);
        let list = cfg.settings.as_ref().unwrap()["yaml"]["schemas"][COMPOSE_SCHEMA_URL]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>();
        assert!(list.contains(&"compose.yml"));
        assert!(list.contains(&"*-compose.yml"));
        assert!(list.contains(&"/work/custom-stack.yml"));
        assert!(!list.contains(&"/work/excluded.yml"));
        assert!(list.contains(&"!/work/excluded.yml"));
    }
}
