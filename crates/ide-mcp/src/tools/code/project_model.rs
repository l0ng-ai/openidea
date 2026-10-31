// Ported from JetBrains intellij-community plugins/mcp-server (mcpserver.toolsets/src/general/AnalysisToolset.kt), Apache-2.0.
//! `get_project_modules` and `get_project_dependencies`.
//!
//! IntelliJ lists its module model and asks `McpProjectDependenciesProvider`s; OpenIDEA has
//! no module model, so modules come from the Maven / Gradle build model and the build files
//! below the root, and dependencies from what those files declare. Both keep JetBrains'
//! fields (`name`, `type` / `name`, `version`, `dependencyType`, `source`) and add their own.

use crate::tool::{Call, Output, Tool};
use ide_core::IdeResult;
use ide_core::mcp::McpToolKind;
use serde::Serialize;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::time::Duration;

const MANIFESTS: &[&str] = &["Cargo.toml", "package.json", "go.mod", "pyproject.toml"];
const SCAN_DEPTH: usize = 4;
const SCAN_MAX_DIRS: usize = 3000;
const LIBRARY_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_LIBRARY_ENTRIES: usize = 300;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SourceFolderOut {
    path: String,
    /// `source`, `test`, `resources`, `testResources` or `excluded`.
    kind: Value,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Module {
    name: String,
    #[serde(rename = "type")]
    kind: String,
    /// Project-relative directory (`.` = root), absolute outside the project.
    path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    manifest: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    source_folders: Vec<SourceFolderOut>,
}

/// Build files below the project (ignored and excluded folders skipped), shallow first,
/// with their text; unreadable ones are left out. Runs off the async runtime.
async fn read_manifests(call: &Call) -> IdeResult<Vec<(PathBuf, String)>> {
    let host = call.host();
    let (window, root) = (call.window().to_owned(), call.root().to_path_buf());
    host.clone()
        .blocking(move || {
            Ok(scan_manifests(&host, &window, root)
                .into_iter()
                .filter_map(|m| std::fs::read_to_string(&m).ok().map(|text| (m, text)))
                .collect())
        })
        .await
}

fn scan_manifests(host: &ide_host::Host, window: &str, root: PathBuf) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut dirs = std::collections::VecDeque::from([(root, 0usize)]);
    let mut visited = 0;
    while let Some((dir, depth)) = dirs.pop_front() {
        visited += 1;
        if visited > SCAN_MAX_DIRS {
            break;
        }
        let Ok(entries) = ide_host::ops::fs::read_dir(host, window, dir) else { continue };
        for e in entries {
            if e.ignored || e.excluded {
                continue;
            }
            if e.kind == ide_vfs::EntryKind::Dir {
                if depth < SCAN_DEPTH
                    && !e.name.starts_with('.')
                    && !matches!(e.name.as_str(), "node_modules" | "target" | "vendor")
                {
                    dirs.push_back((e.path.into_path_buf(), depth + 1));
                }
            } else if MANIFESTS.contains(&e.name.as_str()) {
                out.push(e.path.into_path_buf());
            }
        }
    }
    out
}

fn rel_dir(call: &Call, manifest: &Path) -> String {
    manifest.parent().map(|d| call.display(d)).unwrap_or_else(|| ".".into())
}

fn dir_name(path: &Path) -> String {
    path.parent().and_then(Path::file_name).map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

/// A module described by a manifest: (name, type).
fn manifest_module(path: &Path, text: &str) -> Option<(String, String)> {
    let file = path.file_name()?.to_str()?;
    let fallback = dir_name(path);
    match file {
        "Cargo.toml" => {
            let t: toml::Table = text.parse().ok()?;
            match t.get("package").and_then(|p| p.get("name")).and_then(toml::Value::as_str) {
                Some(n) => Some((n.to_owned(), "cargo".into())),
                None if t.contains_key("workspace") => Some((fallback, "cargo-workspace".into())),
                None => None,
            }
        }
        "package.json" => {
            let v: Value = serde_json::from_str(text).ok()?;
            let name = v.get("name").and_then(Value::as_str).map(str::to_owned).unwrap_or(fallback);
            Some((name, "npm".into()))
        }
        "go.mod" => {
            let name = text
                .lines()
                .find_map(|l| l.trim().strip_prefix("module "))
                .map(|m| m.trim().trim_matches('"').to_owned());
            Some((name.unwrap_or(fallback), "go".into()))
        }
        "pyproject.toml" => {
            let t: toml::Table = text.parse().ok()?;
            let name = t
                .get("project")
                .and_then(|p| p.get("name"))
                .or_else(|| t.get("tool").and_then(|p| p.get("poetry")).and_then(|p| p.get("name")))
                .and_then(toml::Value::as_str)
                .map(str::to_owned);
            Some((name.unwrap_or(fallback), "python".into()))
        }
        _ => None,
    }
}

pub(super) fn get_project_modules() -> Tool {
    Tool::new(
        "get_project_modules",
        McpToolKind::Read,
        "Get a list of all modules in the project with their types.
Returns structured information about each module including name and type.
Modules are the Maven / Gradle projects of the build model and the packages / crates / Go modules / Python projects \
of the build files below the root (`type` is maven, gradle, npm, cargo, cargo-workspace, go, python, or directory for \
the project root without one); each also has its directory (`path`), build file (`manifest`) and the source / test / \
resource / excluded folders inside it. Folders attached from outside the project are listed with type `contentRoot`.",
        |call| async move {
            let model = ide_host::ops::build::build_model(&call.host(), call.window()).await?;
            let project = call.project().clone();
            let mut modules: Vec<Module> = Vec::new();
            let dir_of = |dir: &str| if dir.is_empty() { ".".to_owned() } else { dir.to_owned() };
            if let Some(m) = &model.maven {
                for p in &m.projects {
                    let name = if p.display_name.is_empty() { p.artifact_id.clone() } else { p.display_name.clone() };
                    modules.push(Module {
                        name,
                        kind: "maven".into(),
                        path: dir_of(&p.dir),
                        manifest: Some(p.pom.clone()),
                        source_folders: Vec::new(),
                    });
                }
            }
            if let Some(g) = &model.gradle {
                for p in &g.projects {
                    modules.push(Module {
                        name: p.name.clone(),
                        kind: "gradle".into(),
                        path: dir_of(&p.dir),
                        manifest: p.build_file.clone(),
                        source_folders: Vec::new(),
                    });
                }
            }
            for (m, text) in read_manifests(&call).await? {
                let Some((name, kind)) = manifest_module(&m, &text) else { continue };
                let path = rel_dir(&call, &m);
                if !modules.iter().any(|x| x.path == path && x.kind == kind) {
                    modules.push(Module {
                        name,
                        kind,
                        path,
                        manifest: Some(call.display(&m)),
                        source_folders: Vec::new(),
                    });
                }
            }
            if !modules.iter().any(|m| m.path == ".") {
                let name = ide_host::ops::project::info(&project).name;
                modules.insert(
                    0,
                    Module {
                        name,
                        kind: "directory".into(),
                        path: ".".into(),
                        manifest: None,
                        source_folders: Vec::new(),
                    },
                );
            }
            // Each source folder goes to the innermost module containing it.
            let roots = ide_host::ops::project::roots(&call.host(), call.window())?;
            for r in roots.roots {
                let inside =
                    |m: &Module| m.path == "." || r.path == m.path || r.path.starts_with(&format!("{}/", m.path));
                if let Some(m) = modules
                    .iter_mut()
                    .filter(|m| inside(m))
                    .max_by_key(|m| if m.path == "." { 0 } else { m.path.len() })
                {
                    let folder = SourceFolderOut {
                        path: if r.path.is_empty() { ".".into() } else { r.path.clone() },
                        kind: serde_json::to_value(r.kind).unwrap_or_default(),
                    };
                    m.source_folders.push(folder);
                }
            }
            for root in project.content_roots() {
                let name = root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                modules.push(Module {
                    name,
                    kind: "contentRoot".into(),
                    path: root.display().to_string(),
                    manifest: None,
                    source_folders: Vec::new(),
                });
            }
            Output::json(json!({ "modules": modules }))
        },
    )
    .output(json!({
        "type": "object",
        "properties": {
            "modules": { "type": "array", "items": {
                "type": "object",
                "properties": {
                    "name": { "type": "string" },
                    "type": { "type": "string" },
                    "path": { "type": "string" },
                    "manifest": { "type": "string" },
                    "sourceFolders": { "type": "array", "items": {
                        "type": "object",
                        "properties": { "path": { "type": "string" }, "kind": { "type": "string" } },
                        "required": ["path", "kind"],
                    } },
                },
                "required": ["name"],
            } },
        },
        "required": ["modules"],
    }))
}

#[derive(Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Dependency {
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    dependency_type: Option<String>,
    /// The manifest that declares it.
    source: String,
}

fn dep(name: &str, version: Option<String>, kind: &str, source: &str) -> Dependency {
    Dependency {
        name: name.to_owned(),
        version: version.filter(|v| !v.is_empty()),
        dependency_type: Some(kind.to_owned()),
        source: source.to_owned(),
    }
}

/// Direct dependencies a manifest declares.
fn manifest_dependencies(path: &Path, text: &str, source: &str) -> Vec<Dependency> {
    let mut out = Vec::new();
    match path.file_name().and_then(|n| n.to_str()) {
        Some("package.json") => {
            let Ok(v) = serde_json::from_str::<Value>(text) else { return out };
            for kind in ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] {
                for (name, spec) in v.get(kind).and_then(Value::as_object).into_iter().flatten() {
                    out.push(dep(name, spec.as_str().map(str::to_owned), kind, source));
                }
            }
        }
        Some("Cargo.toml") => {
            let Ok(t) = text.parse::<toml::Table>() else { return out };
            let cargo_version = |v: &toml::Value| -> Option<String> {
                match v {
                    toml::Value::String(s) => Some(s.clone()),
                    toml::Value::Table(t) => t
                        .get("version")
                        .and_then(toml::Value::as_str)
                        .map(str::to_owned)
                        .or_else(|| {
                            t.get("workspace").and_then(toml::Value::as_bool).filter(|w| *w).map(|_| "workspace".into())
                        })
                        .or_else(|| t.get("path").and_then(toml::Value::as_str).map(|p| format!("path: {p}")))
                        .or_else(|| t.get("git").and_then(toml::Value::as_str).map(|g| format!("git: {g}"))),
                    _ => None,
                }
            };
            let mut tables: Vec<(String, &toml::Table)> = Vec::new();
            for kind in ["dependencies", "dev-dependencies", "build-dependencies"] {
                if let Some(d) = t.get(kind).and_then(toml::Value::as_table) {
                    tables.push((kind.to_owned(), d));
                }
                for (cfg, target) in t.get("target").and_then(toml::Value::as_table).into_iter().flatten() {
                    if let Some(d) = target.get(kind).and_then(toml::Value::as_table) {
                        tables.push((format!("{kind} ({cfg})"), d));
                    }
                }
            }
            if let Some(d) = t.get("workspace").and_then(|w| w.get("dependencies")).and_then(toml::Value::as_table) {
                tables.push(("workspace.dependencies".into(), d));
            }
            for (kind, table) in tables {
                for (name, v) in table {
                    let name = v.get("package").and_then(toml::Value::as_str).unwrap_or(name);
                    out.push(dep(name, cargo_version(v), &kind, source));
                }
            }
        }
        Some("go.mod") => {
            let mut block = false;
            for line in text.lines() {
                let line = line.trim();
                let entry = if block {
                    if line.starts_with(')') {
                        block = false;
                        continue;
                    }
                    line
                } else if let Some(rest) = line.strip_prefix("require") {
                    let rest = rest.trim();
                    if rest.starts_with('(') {
                        block = true;
                        continue;
                    }
                    rest
                } else {
                    continue;
                };
                let (spec, comment) = entry.split_once("//").map_or((entry, ""), |(s, c)| (s, c));
                let mut parts = spec.split_whitespace();
                if let Some(name) = parts.next() {
                    let kind = if comment.contains("indirect") { "indirect" } else { "require" };
                    out.push(dep(name, parts.next().map(str::to_owned), kind, source));
                }
            }
        }
        Some("pyproject.toml") => {
            let Ok(t) = text.parse::<toml::Table>() else { return out };
            let pep508 = |s: &str| -> (String, Option<String>) {
                let s = s.split(';').next().unwrap_or("").trim();
                let cut = s.find(|c: char| "<>=!~[ (@".contains(c)).unwrap_or(s.len());
                let rest = s[cut..].trim();
                (s[..cut].to_owned(), (!rest.is_empty()).then(|| rest.to_owned()))
            };
            let project = t.get("project");
            for spec in
                project.and_then(|p| p.get("dependencies")).and_then(toml::Value::as_array).into_iter().flatten()
            {
                if let Some(s) = spec.as_str() {
                    let (name, version) = pep508(s);
                    out.push(dep(&name, version, "dependencies", source));
                }
            }
            for (group, specs) in project
                .and_then(|p| p.get("optional-dependencies"))
                .and_then(toml::Value::as_table)
                .into_iter()
                .flatten()
            {
                for s in specs.as_array().into_iter().flatten().filter_map(toml::Value::as_str) {
                    let (name, version) = pep508(s);
                    out.push(dep(&name, version, &format!("optional ({group})"), source));
                }
            }
            let poetry = t.get("tool").and_then(|p| p.get("poetry"));
            for kind in ["dependencies", "dev-dependencies"] {
                for (name, v) in poetry.and_then(|p| p.get(kind)).and_then(toml::Value::as_table).into_iter().flatten()
                {
                    if name == "python" {
                        continue;
                    }
                    let version = v
                        .as_str()
                        .map(str::to_owned)
                        .or_else(|| v.get("version").and_then(toml::Value::as_str).map(str::to_owned));
                    out.push(dep(name, version, kind, source));
                }
            }
        }
        _ => {}
    }
    out
}

pub(super) fn get_project_dependencies() -> Tool {
    Tool::new(
        "get_project_dependencies",
        McpToolKind::Read,
        "Get a list of all dependencies defined in the project.
Includes the dependencies its build files declare (package.json, Cargo.toml, go.mod, pyproject.toml, Maven POMs).
Each entry has a name and, when known, a version, a dependencyType (e.g. devDependencies),
and a source (the declaring build file, e.g. package.json).
Returns structured information about project library names.
`libraries` adds the resolved libraries the IDE shows under External Libraries (SDKs, node_modules, Cargo / Go / \
Maven / Gradle packages), grouped.",
        |call| async move {
            let host = call.host();
            let model = ide_host::ops::build::build_model(&host, call.window()).await?;
            let mut deps: Vec<Dependency> = Vec::new();
            for (m, text) in read_manifests(&call).await? {
                deps.extend(manifest_dependencies(&m, &text, &call.display(&m)));
            }
            if let Some(m) = &model.maven {
                for p in &m.projects {
                    for d in &p.dependencies {
                        let name = format!("{}:{}", d.group_id, d.artifact_id);
                        deps.push(dep(&name, d.version.clone(), &d.scope, &p.pom));
                    }
                }
            }
            let mut unique: Vec<Dependency> = Vec::with_capacity(deps.len());
            for d in deps {
                if !unique.contains(&d) {
                    unique.push(d);
                }
            }
            let deps = unique;
            let libraries =
                tokio::time::timeout(LIBRARY_TIMEOUT, ide_host::ops::sdk::sdk_project_libraries(&host, call.window()))
                    .await;
            let mut out = json!({ "dependencies": deps });
            match libraries {
                Ok(Ok(groups)) => {
                    let groups: Vec<Value> = groups
                        .into_iter()
                        .map(|g| {
                            let total = g.roots.len();
                            let names: Vec<String> =
                                g.roots.into_iter().take(MAX_LIBRARY_ENTRIES).map(|r| r.name).collect();
                            let mut v = json!({ "name": g.name, "kind": g.kind, "entries": names });
                            if total > MAX_LIBRARY_ENTRIES {
                                v["more"] = (total - MAX_LIBRARY_ENTRIES).into();
                            }
                            v
                        })
                        .collect();
                    out["libraries"] = groups.into();
                }
                Ok(Err(e)) => out["librariesError"] = e.message.into(),
                Err(_) => out["librariesTimedOut"] = true.into(),
            }
            Output::json(out)
        },
    )
    .output(json!({
        "type": "object",
        "properties": {
            "dependencies": { "type": "array", "items": {
                "type": "object",
                "properties": {
                    "name": { "type": "string" },
                    "version": { "type": "string" },
                    "dependencyType": { "type": "string" },
                    "source": { "type": "string" },
                },
                "required": ["name"],
            } },
            "libraries": { "type": "array", "items": {
                "type": "object",
                "properties": {
                    "name": { "type": "string" },
                    "kind": { "type": "string" },
                    "entries": { "type": "array", "items": { "type": "string" } },
                    "more": { "type": "integer" },
                },
            } },
            "librariesError": { "type": "string" },
            "librariesTimedOut": { "type": "boolean" },
        },
        "required": ["dependencies"],
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_manifests() {
        let cargo = r#"
[package]
name = "demo"
[dependencies]
serde = { version = "1", features = ["derive"] }
local = { path = "../local" }
[dev-dependencies]
tempfile = "3"
"#;
        let deps = manifest_dependencies(Path::new("Cargo.toml"), cargo, "Cargo.toml");
        let names: Vec<_> = deps.iter().map(|d| (d.name.as_str(), d.version.as_deref())).collect();
        assert_eq!(names, [("local", Some("path: ../local")), ("serde", Some("1")), ("tempfile", Some("3"))]);
        let gomod = "module x\nrequire (\n\tgithub.com/a/b v1.2.3\n\tgolang.org/x/y v0.1.0 // indirect\n)\nrequire c.io/d v2.0.0\n";
        let deps = manifest_dependencies(Path::new("go.mod"), gomod, "go.mod");
        assert_eq!(deps.len(), 3);
        assert_eq!(deps[1].dependency_type.as_deref(), Some("indirect"));
        let py = "[project]\nname = \"p\"\ndependencies = [\"requests>=2.0\", \"rich\"]\n";
        let deps = manifest_dependencies(Path::new("pyproject.toml"), py, "pyproject.toml");
        assert_eq!(deps[0].name, "requests");
        assert_eq!(deps[0].version.as_deref(), Some(">=2.0"));
        assert_eq!(manifest_module(Path::new("/p/go.mod"), gomod), Some(("x".into(), "go".into())));
    }
}
