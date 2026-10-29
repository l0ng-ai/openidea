//! Run configuration detection from build files at the project root, or from the
//! builds nested in a folder that holds several repositories.
//!
//! Detection never fails: unreadable or malformed files simply contribute nothing.

use crate::RunConfig;
use serde_json::Value as Json;
use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

pub(crate) fn detect(root: &Path) -> Vec<RunConfig> {
    let mut out = Vec::new();
    detect_node(root, &mut out);
    detect_deno(root, &mut out);
    detect_cargo(root, &mut out);
    detect_gradle(root, &mut out);
    detect_maven(root, &mut out);
    detect_go(root, &mut out);
    detect_python(root, &mut out);
    detect_make(root, &mut out);
    detect_just(root, &mut out);
    detect_godot(root, &mut out);

    let mut seen = HashSet::new();
    out.retain(|c| seen.insert(c.id.clone()));
    out
}

fn config(id: impl Into<String>, name: impl Into<String>, kind: &str, command: &str, args: &[&str]) -> RunConfig {
    RunConfig {
        id: id.into(),
        name: name.into(),
        kind: kind.to_owned(),
        command: command.to_owned(),
        args: args.iter().map(|a| (*a).to_owned()).collect(),
        cwd: None,
        env: BTreeMap::new(),
        detected: true,
        is_test: false,
        debug_adapter: None,
        allow_parallel: false,
        extras: Default::default(),
    }
}

trait ConfigExt {
    fn test(self) -> Self;
    fn debug(self, adapter: &str) -> Self;
    fn in_dir(self, dir: Option<PathBuf>) -> Self;
}

impl ConfigExt for RunConfig {
    fn test(mut self) -> Self {
        self.is_test = true;
        self
    }
    fn debug(mut self, adapter: &str) -> Self {
        self.debug_adapter = Some(adapter.to_owned());
        self
    }
    fn in_dir(mut self, dir: Option<PathBuf>) -> Self {
        self.cwd = dir.map(Into::into);
        self
    }
}

fn read(path: &Path) -> Option<String> {
    fs::read_to_string(path).ok()
}

fn read_json(path: &Path) -> Option<Json> {
    serde_json::from_str(&read(path)?).ok()
}

fn read_toml(path: &Path) -> Option<toml::Table> {
    read(path)?.parse::<toml::Table>().ok()
}

fn first_existing(root: &Path, names: &[&str]) -> Option<PathBuf> {
    names.iter().map(|n| root.join(n)).find(|p| p.is_file())
}

/// Sorted immediate subdirectories, skipping hidden and vendored ones.
fn subdirs(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(dir) else { return Vec::new() };
    let mut dirs: Vec<PathBuf> = entries
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .filter(|e| {
            let name = e.file_name();
            let name = name.to_string_lossy();
            !name.starts_with('.') && !matches!(name.as_ref(), "node_modules" | "target" | "build" | "dist" | "vendor")
        })
        .map(|e| e.path())
        .collect();
    dirs.sort();
    dirs
}

/// Expands workspace member patterns one level deep: `dir`, `dir/*`, `dir/**`.
fn expand_members(root: &Path, patterns: &[String], marker: &str) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    for pattern in patterns {
        let pattern = pattern.trim().trim_start_matches("./").trim_end_matches('/');
        if pattern.is_empty() || pattern.starts_with('!') {
            continue;
        }
        let base = pattern.strip_suffix("/**").or_else(|| pattern.strip_suffix("/*"));
        match base {
            Some(base) if !base.contains('*') => {
                dirs.extend(subdirs(&root.join(base)).into_iter().filter(|d| d.join(marker).is_file()))
            }
            None if !pattern.contains('*') => {
                let dir = root.join(pattern);
                if dir.join(marker).is_file() {
                    dirs.push(dir);
                }
            }
            _ => {}
        }
    }
    let mut seen = HashSet::new();
    dirs.retain(|d| seen.insert(d.clone()));
    dirs
}

fn relative(root: &Path, dir: &Path) -> PathBuf {
    dir.strip_prefix(root).map(Path::to_path_buf).unwrap_or_else(|_| dir.to_path_buf())
}

// ---------------------------------------------------------------- node

fn package_manager(root: &Path, pkg: &Json) -> &'static str {
    if let Some(pm) = pkg.get("packageManager").and_then(Json::as_str) {
        match pm.split('@').next().unwrap_or_default() {
            "pnpm" => return "pnpm",
            "yarn" => return "yarn",
            "bun" => return "bun",
            "npm" => return "npm",
            _ => {}
        }
    }
    if root.join("pnpm-lock.yaml").is_file() {
        "pnpm"
    } else if root.join("yarn.lock").is_file() {
        "yarn"
    } else if root.join("bun.lock").is_file() || root.join("bun.lockb").is_file() {
        "bun"
    } else {
        "npm"
    }
}

fn is_test_script(name: &str) -> bool {
    matches!(name, "test" | "vitest" | "jest") || name.starts_with("test:")
}

fn push_scripts(pkg: &Json, pm: &str, prefix: Option<&str>, cwd: Option<PathBuf>, out: &mut Vec<RunConfig>) {
    let Some(scripts) = pkg.get("scripts").and_then(Json::as_object) else { return };
    let mut names: Vec<&String> = scripts.keys().collect();
    names.sort();
    for script in names {
        let (id, name) = match prefix {
            Some(p) => (format!("npm:{p}:{script}"), format!("{p}: {pm} run {script}")),
            None => (format!("npm:{script}"), format!("{pm} run {script}")),
        };
        let mut c = config(id, name, "npm", pm, &["run", script]).in_dir(cwd.clone()).debug("js-debug");
        if is_test_script(script) {
            c = c.test();
        }
        out.push(c);
    }
}

fn node_workspace_patterns(root: &Path, pkg: &Json) -> Vec<String> {
    let mut patterns: Vec<String> = Vec::new();
    let ws = pkg.get("workspaces");
    let list = ws.and_then(Json::as_array).or_else(|| ws.and_then(|w| w.get("packages")).and_then(Json::as_array));
    if let Some(list) = list {
        patterns.extend(list.iter().filter_map(Json::as_str).map(str::to_owned));
    }
    if let Some(yaml) = read(&root.join("pnpm-workspace.yaml")) {
        let mut in_packages = false;
        for line in yaml.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() || trimmed.starts_with('#') {
                continue;
            }
            if !line.starts_with([' ', '\t', '-']) {
                in_packages = trimmed.starts_with("packages:");
                continue;
            }
            if in_packages && let Some(item) = trimmed.strip_prefix('-') {
                let item = item.split(" #").next().unwrap_or_default().trim().trim_matches(['"', '\'']);
                patterns.push(item.to_owned());
            }
        }
    }
    patterns
}

fn detect_node(root: &Path, out: &mut Vec<RunConfig>) {
    let Some(pkg) = read_json(&root.join("package.json")) else {
        // A polyglot repository: front-end packages one level down (`web/`, `frontend/`).
        for dir in subdirs(root) {
            let Some(member) = read_json(&dir.join("package.json")) else { continue };
            let rel = relative(root, &dir);
            let label = rel.to_string_lossy().replace('\\', "/");
            push_scripts(&member, package_manager(&dir, &member), Some(&label), Some(rel), out);
        }
        return;
    };
    let pm = package_manager(root, &pkg);
    push_scripts(&pkg, pm, None, None, out);
    for dir in expand_members(root, &node_workspace_patterns(root, &pkg), "package.json") {
        let Some(member) = read_json(&dir.join("package.json")) else { continue };
        let rel = relative(root, &dir);
        let label = member
            .get("name")
            .and_then(Json::as_str)
            .map(str::to_owned)
            .unwrap_or_else(|| rel.to_string_lossy().replace('\\', "/"));
        push_scripts(&member, pm, Some(&label), Some(rel), out);
    }
}

// ---------------------------------------------------------------- deno

fn detect_deno(root: &Path, out: &mut Vec<RunConfig>) {
    let Some(path) = first_existing(root, &["deno.json", "deno.jsonc"]) else { return };
    let Some(json) = read(&path).and_then(|s| serde_json::from_str::<Json>(&ide_core::jsonc::strip(&s)).ok()) else {
        return;
    };
    let Some(tasks) = json.get("tasks").and_then(Json::as_object) else { return };
    let mut names: Vec<&String> = tasks.keys().collect();
    names.sort();
    for task in names {
        let mut c = config(format!("deno:{task}"), format!("deno task {task}"), "deno", "deno", &["task", task]);
        if is_test_script(task) {
            c = c.test();
        }
        out.push(c);
    }
}

// ---------------------------------------------------------------- cargo

fn string_list(v: Option<&toml::Value>) -> Vec<String> {
    v.and_then(toml::Value::as_array)
        .map(|a| a.iter().filter_map(toml::Value::as_str).map(str::to_owned).collect())
        .unwrap_or_default()
}

fn cargo_bins(dir: &Path, manifest: &toml::Table) -> Vec<String> {
    let package = manifest.get("package").and_then(toml::Value::as_table);
    let pkg_name = package.and_then(|p| p.get("name")).and_then(toml::Value::as_str).unwrap_or_default();
    let autobins = package.and_then(|p| p.get("autobins")).and_then(toml::Value::as_bool).unwrap_or(true);
    let mut bins = Vec::new();
    let mut explicit_paths = HashSet::new();
    if let Some(list) = manifest.get("bin").and_then(toml::Value::as_array) {
        for bin in list.iter().filter_map(toml::Value::as_table) {
            if let Some(name) = bin.get("name").and_then(toml::Value::as_str) {
                bins.push(name.to_owned());
            }
            if let Some(path) = bin.get("path").and_then(toml::Value::as_str) {
                explicit_paths.insert(path.trim_start_matches("./").replace('\\', "/"));
            }
        }
    }
    if autobins {
        if dir.join("src/main.rs").is_file() && !explicit_paths.contains("src/main.rs") && !pkg_name.is_empty() {
            bins.push(pkg_name.to_owned());
        }
        if let Ok(entries) = fs::read_dir(dir.join("src/bin")) {
            let mut extra: Vec<String> = entries
                .filter_map(Result::ok)
                .filter_map(|e| {
                    let path = e.path();
                    let name = e.file_name().to_string_lossy().into_owned();
                    if path.is_file() {
                        name.strip_suffix(".rs").map(str::to_owned)
                    } else if path.join("main.rs").is_file() {
                        Some(name)
                    } else {
                        None
                    }
                })
                .collect();
            extra.sort();
            bins.extend(extra);
        }
    }
    let mut seen = HashSet::new();
    bins.retain(|b| seen.insert(b.clone()));
    bins
}

fn detect_cargo(root: &Path, out: &mut Vec<RunConfig>) {
    let Some(manifest) = read_toml(&root.join("Cargo.toml")) else { return };
    let workspace = manifest.get("workspace").and_then(toml::Value::as_table);
    let is_workspace = workspace.is_some();

    let mut packages: Vec<(String, PathBuf, toml::Table)> = Vec::new();
    if let Some(name) = manifest.get("package").and_then(|p| p.get("name")).and_then(toml::Value::as_str) {
        packages.push((name.to_owned(), root.to_path_buf(), manifest.clone()));
    }
    if let Some(ws) = workspace {
        let exclude: HashSet<PathBuf> =
            string_list(ws.get("exclude")).iter().map(|e| root.join(e.trim_end_matches('/'))).collect();
        for dir in expand_members(root, &string_list(ws.get("members")), "Cargo.toml") {
            if exclude.contains(&dir) || dir == root {
                continue;
            }
            let Some(m) = read_toml(&dir.join("Cargo.toml")) else { continue };
            if let Some(name) = m.get("package").and_then(|p| p.get("name")).and_then(toml::Value::as_str) {
                packages.push((name.to_owned(), dir, m));
            }
        }
    }

    let mut used = HashSet::new();
    for (pkg, dir, m) in &packages {
        let bins = cargo_bins(dir, m);
        for bin in &bins {
            let mut args = vec!["run"];
            if is_workspace {
                args.extend(["-p", pkg.as_str()]);
            }
            if is_workspace || bins.len() > 1 {
                args.extend(["--bin", bin.as_str()]);
            }
            let id = if used.insert(format!("cargo:run:{bin}")) {
                format!("cargo:run:{bin}")
            } else {
                format!("cargo:run:{pkg}:{bin}")
            };
            out.push(config(id, format!("cargo run {bin}"), "cargo", "cargo", &args).debug("codelldb"));
        }
    }
    if packages.is_empty() && !is_workspace {
        return;
    }
    let ws_flag: &[&str] = if is_workspace { &["--workspace"] } else { &[] };
    let test_args: Vec<&str> = ["test"].iter().chain(ws_flag).copied().collect();
    let build_args: Vec<&str> = ["build"].iter().chain(ws_flag).copied().collect();
    out.push(config("cargo:test", "cargo test", "cargo", "cargo", &test_args).test().debug("codelldb"));
    out.push(config("cargo:build", "cargo build", "cargo", "cargo", &build_args));
}

// ---------------------------------------------------------------- gradle / maven

fn wrapper(root: &Path, unix: &str, windows: &str, fallback: &str) -> String {
    if cfg!(windows) {
        if root.join(windows).is_file() {
            return windows.to_owned();
        }
    } else if root.join(unix).is_file() {
        return format!("./{unix}");
    }
    fallback.to_owned()
}

/// Root build file plus one level of subproject build files.
fn collect_texts(root: &Path, names: &[&str]) -> Option<String> {
    let mut text = names.iter().find_map(|n| read(&root.join(n)))?;
    for dir in subdirs(root) {
        for name in names {
            if let Some(t) = read(&dir.join(name)) {
                text.push('\n');
                text.push_str(&t);
            }
        }
    }
    Some(text)
}

fn applies_application_plugin(text: &str) -> bool {
    text.lines().any(|line| {
        let compact: String =
            line.split("//").next().unwrap_or_default().chars().filter(|c| !c.is_whitespace()).collect();
        compact == "application"
            || compact.starts_with("application{")
            || ["id'application'", "id\"application\"", "id(\"application\")", "id('application')"]
                .iter()
                .any(|p| compact.contains(p))
            || ["plugin:'application'", "plugin:\"application\"", "plugin=\"application\""]
                .iter()
                .any(|p| compact.contains(p))
    })
}

/// How deep a build is looked for when the project root has none (a folder holding
/// several repositories: `backend/pom.xml`, `apps/server/settings.gradle`).
const NESTED_BUILD_DEPTH: usize = 3;

/// The builds marked by any of `markers`: the root itself, else the shallowest marked
/// folder of each branch, up to [`NESTED_BUILD_DEPTH`] levels down.
fn build_dirs(root: &Path, markers: &[&str]) -> Vec<PathBuf> {
    let marked = |d: &Path| markers.iter().any(|m| d.join(m).is_file());
    if marked(root) {
        return vec![root.to_path_buf()];
    }
    let mut out = Vec::new();
    let mut level = vec![root.to_path_buf()];
    for _ in 0..NESTED_BUILD_DEPTH {
        let mut next = Vec::new();
        for sub in level.iter().flat_map(|d| subdirs(d)).filter(|d| !d.ends_with("src") && !d.ends_with("out")) {
            if marked(&sub) {
                out.push(sub);
            } else {
                next.push(sub);
            }
        }
        level = next;
    }
    out.sort();
    out
}

/// Ids, names and working directory of the configurations of a build nested in
/// `rel` (`None`: the build at the project root).
struct Scope(Option<String>);

impl Scope {
    fn new(root: &Path, dir: &Path) -> Self {
        Self((dir != root).then(|| relative(root, dir).to_string_lossy().replace('\\', "/")))
    }
    fn id(&self, base: &str) -> String {
        match &self.0 {
            Some(l) => format!("{base}:{l}"),
            None => base.to_owned(),
        }
    }
    fn name(&self, base: &str) -> String {
        match &self.0 {
            Some(l) => format!("{l}: {base}"),
            None => base.to_owned(),
        }
    }
    fn cwd(&self) -> Option<PathBuf> {
        self.0.as_ref().map(PathBuf::from)
    }
}

const GRADLE_SETTINGS: &[&str] = &["settings.gradle.kts", "settings.gradle"];
const GRADLE_BUILDS: &[&str] = &["build.gradle.kts", "build.gradle"];

fn detect_gradle(root: &Path, out: &mut Vec<RunConfig>) {
    let markers: Vec<&str> = GRADLE_SETTINGS.iter().chain(GRADLE_BUILDS).copied().collect();
    for dir in build_dirs(root, &markers) {
        detect_gradle_build(root, &dir, out);
    }
}

fn detect_gradle_build(root: &Path, dir: &Path, out: &mut Vec<RunConfig>) {
    let has_settings = first_existing(dir, GRADLE_SETTINGS).is_some();
    let text = match collect_texts(dir, GRADLE_BUILDS) {
        Some(t) => t,
        None if has_settings => collect_texts_from_subdirs(dir, GRADLE_BUILDS),
        None => return,
    };
    let scope = Scope::new(root, dir);
    let cmd = wrapper(dir, "gradlew", "gradlew.bat", "gradle");
    let gradle = |id: &str, task: &str| {
        config(scope.id(id), scope.name(&format!("gradle {task}")), "gradle", &cmd, &[task]).in_dir(scope.cwd())
    };
    spring_boot_apps(root, dir, out);
    out.push(gradle("gradle:build", "build"));
    out.push(gradle("gradle:test", "test").test());
    if applies_application_plugin(&text) {
        out.push(gradle("gradle:run", "run"));
    }
    if text.contains("org.springframework.boot") {
        out.push(gradle("gradle:bootRun", "bootRun"));
    }
}

fn collect_texts_from_subdirs(root: &Path, names: &[&str]) -> String {
    let mut text = String::new();
    for dir in subdirs(root) {
        for name in names {
            if let Some(t) = read(&dir.join(name)) {
                text.push_str(&t);
                text.push('\n');
            }
        }
    }
    text
}

fn detect_maven(root: &Path, out: &mut Vec<RunConfig>) {
    for dir in build_dirs(root, &["pom.xml"]) {
        detect_maven_build(root, &dir, out);
    }
}

fn detect_maven_build(root: &Path, dir: &Path, out: &mut Vec<RunConfig>) {
    let Some(text) = collect_texts(dir, &["pom.xml"]) else { return };
    let scope = Scope::new(root, dir);
    let cmd = wrapper(dir, "mvnw", "mvnw.cmd", "mvn");
    let maven = |id: &str, goal: &str| {
        config(scope.id(id), scope.name(&format!("mvn {goal}")), "maven", &cmd, &[goal]).in_dir(scope.cwd())
    };
    spring_boot_apps(root, dir, out);
    out.push(maven("maven:package", "package"));
    out.push(maven("maven:test", "test").test());
    if text.contains("spring-boot-maven-plugin") {
        out.push(maven("maven:spring-boot:run", "spring-boot:run"));
    }
}

// ---------------------------------------------------------------- spring boot

/// Source files read per build when looking for `@SpringBootApplication` classes.
const SPRING_SCAN_FILES: usize = 400;

/// "Spring Boot" configurations for the `@SpringBootApplication` main classes of the
/// modules of the build in `build` that apply the Spring Boot plugin:
/// `java -cp ${classpath} <class>` in the module, the classpath resolved at launch.
fn spring_boot_apps(root: &Path, build: &Path, out: &mut Vec<RunConfig>) {
    let mut budget = SPRING_SCAN_FILES;
    let mut modules = vec![build.to_path_buf()];
    let mut level = vec![build.to_path_buf()];
    for _ in 0..NESTED_BUILD_DEPTH {
        level = level.iter().flat_map(|d| subdirs(d)).filter(|d| !d.ends_with("src")).collect();
        modules.extend(level.iter().cloned());
    }
    for module in modules {
        if budget == 0 {
            break;
        }
        if !applies_spring_boot(&module) {
            continue;
        }
        let module_rel = (module != root).then(|| relative(root, &module).to_string_lossy().replace('\\', "/"));
        for class in spring_boot_classes(&module, &mut budget) {
            let simple = class.rsplit(['.', '$']).next().unwrap_or(&class).to_owned();
            let id = match &module_rel {
                Some(m) => format!("application:{m}:{class}"),
                None => format!("application:{class}"),
            };
            out.push(
                config(id, simple, "spring-boot", "java", &["-cp", "${classpath}", &class])
                    .in_dir(module_rel.as_ref().map(PathBuf::from))
                    .debug("java-debug"),
            );
        }
    }
}

/// The module's own build applies the Spring Boot plugin, and it has main sources.
fn applies_spring_boot(module: &Path) -> bool {
    if !["java", "kotlin"].iter().any(|l| module.join("src/main").join(l).is_dir()) {
        return false;
    }
    if let Some(pom) = read(&module.join("pom.xml")) {
        return pom.contains("spring-boot-maven-plugin") && !pom.contains("<packaging>pom</packaging>");
    }
    GRADLE_BUILDS.iter().filter_map(|n| read(&module.join(n))).any(|text| {
        text.lines().any(|l| {
            let l = l.split("//").next().unwrap_or_default();
            // The plugin id (`id("org.springframework.boot")`), not a dependency (`org.springframework.boot:…`).
            ["org.springframework.boot\"", "org.springframework.boot'"].iter().any(|p| l.contains(p))
                && !l.contains("apply false")
        })
    })
}

/// Binary names of the `@SpringBootApplication` classes with a `main` under
/// `src/main/{java,kotlin}`, from the shallowest packages that declare one (the
/// application class sits in the root package of the code it scans).
fn spring_boot_classes(module: &Path, budget: &mut usize) -> Vec<String> {
    let mut found = Vec::new();
    let mut level: Vec<PathBuf> =
        ["java", "kotlin"].iter().map(|l| module.join("src/main").join(l)).filter(|d| d.is_dir()).collect();
    while !level.is_empty() && found.is_empty() && *budget > 0 {
        let mut next = Vec::new();
        for dir in &level {
            let Ok(entries) = fs::read_dir(dir) else { continue };
            let mut files = Vec::new();
            for e in entries.filter_map(Result::ok) {
                let path = e.path();
                match e.file_type() {
                    Ok(t) if t.is_dir() => next.push(path),
                    Ok(t) if t.is_file() && path.extension().is_some_and(|x| x == "java" || x == "kt") => {
                        files.push(path)
                    }
                    _ => {}
                }
            }
            files.sort();
            for file in files {
                if *budget == 0 {
                    break;
                }
                *budget -= 1;
                if fs::metadata(&file).is_ok_and(|m| m.len() > 256 * 1024) {
                    continue;
                }
                if let Some(class) = read(&file).and_then(|src| spring_boot_class(&src, &file)) {
                    found.push(class);
                }
            }
        }
        next.sort();
        level = next;
    }
    found
}

/// The class to launch for a source file declaring a `@SpringBootApplication` with a `main`.
pub(crate) fn spring_boot_class(src: &str, file: &Path) -> Option<String> {
    let code: Vec<&str> = src.lines().map(|l| l.split("//").next().unwrap_or_default()).collect();
    let code = code.join("\n");
    let at = code.find("@SpringBootApplication")?;
    let package = code
        .lines()
        .map(str::trim)
        .find_map(|l| l.strip_prefix("package "))
        .map(|p| p.trim_end_matches(';').trim().to_owned())
        .filter(|p| !p.is_empty());
    let qualify = |name: &str| match &package {
        Some(p) => format!("{p}.{name}"),
        None => name.to_owned(),
    };
    if file.extension().is_some_and(|x| x == "kt") {
        // A top-level `fun main` compiles into the file facade (`AppKt`, or `@file:JvmName`).
        if code.lines().any(|l| l.starts_with("fun main(")) {
            let jvm_name = code
                .lines()
                .find_map(|l| l.trim().strip_prefix("@file:JvmName(")?.split('"').nth(1).map(str::to_owned));
            let facade = jvm_name.unwrap_or_else(|| {
                let stem = file.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
                let mut chars = stem.chars();
                let upper: String = chars.next().map(|c| c.to_uppercase().chain(chars).collect()).unwrap_or_default();
                format!("{upper}Kt")
            });
            return Some(qualify(&facade));
        }
        if !code.contains("fun main(") {
            return None;
        }
    } else if !code.contains("void main(") {
        return None;
    }
    let name: String = code[at..]
        .split_whitespace()
        .skip_while(|t| *t != "class")
        .nth(1)?
        .chars()
        .take_while(|c| c.is_alphanumeric() || *c == '_' || *c == '$')
        .collect();
    (!name.is_empty()).then(|| qualify(&name))
}

// ---------------------------------------------------------------- go

fn is_go_main_package(dir: &Path) -> bool {
    let Ok(entries) = fs::read_dir(dir) else { return false };
    entries.filter_map(Result::ok).any(|e| {
        let name = e.file_name().to_string_lossy().into_owned();
        name.ends_with(".go")
            && !name.ends_with("_test.go")
            && read(&e.path()).is_some_and(|src| {
                src.lines()
                    .map(str::trim)
                    .find(|l| l.starts_with("package "))
                    .is_some_and(|l| l.trim_start_matches("package ").split_whitespace().next() == Some("main"))
            })
    })
}

fn detect_go(root: &Path, out: &mut Vec<RunConfig>) {
    if root.join("go.mod").is_file() {
        detect_go_module(root, None, out);
        return;
    }
    // A polyglot repository: Go modules one level down (`api/go.mod`).
    for dir in subdirs(root) {
        if dir.join("go.mod").is_file() {
            let rel = relative(root, &dir);
            detect_go_module(&dir, Some(rel), out);
        }
    }
}

/// Configs for the module in `dir`; `rel` is its path from the project root when nested.
fn detect_go_module(dir: &Path, rel: Option<PathBuf>, out: &mut Vec<RunConfig>) {
    let label = rel.as_ref().map(|r| r.to_string_lossy().replace('\\', "/"));
    let id = |base: &str| match &label {
        Some(l) => format!("{base}:{l}"),
        None => base.to_owned(),
    };
    let name = |base: &str| match &label {
        Some(l) => format!("{l}: {base}"),
        None => base.to_owned(),
    };
    if is_go_main_package(dir) {
        out.push(config(id("go:run"), name("go run ."), "go", "go", &["run", "."]).in_dir(rel.clone()).debug("delve"));
    }
    for sub in subdirs(&dir.join("cmd")) {
        if is_go_main_package(&sub) {
            let cmd = sub.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            let target = format!("./cmd/{cmd}");
            out.push(
                config(id(&format!("go:run:{cmd}")), name(&format!("go run {target}")), "go", "go", &["run", &target])
                    .in_dir(rel.clone())
                    .debug("delve"),
            );
        }
    }
    out.push(
        config(id("go:test"), name("go test ./..."), "go", "go", &["test", "./..."]).in_dir(rel).test().debug("delve"),
    );
}

// ---------------------------------------------------------------- python

/// How to invoke tools inside the project's Python environment.
enum PyEnv {
    /// `uv run …`, `poetry run …`, `pdm run …`
    Runner(&'static str),
    /// A project-local virtualenv directory (relative to root).
    Venv(String),
    System,
}

impl PyEnv {
    fn detect(root: &Path) -> Self {
        if root.join("uv.lock").is_file() {
            return Self::Runner("uv");
        }
        if root.join("poetry.lock").is_file() {
            return Self::Runner("poetry");
        }
        if root.join("pdm.lock").is_file() {
            return Self::Runner("pdm");
        }
        for venv in [".venv", "venv"] {
            if root.join(venv).join(Self::bin_dir()).join(Self::python_exe()).is_file() {
                return Self::Venv(venv.to_owned());
            }
        }
        Self::System
    }

    fn bin_dir() -> &'static str {
        if cfg!(windows) { "Scripts" } else { "bin" }
    }

    fn python_exe() -> &'static str {
        if cfg!(windows) { "python.exe" } else { "python" }
    }

    /// `(command, leading args)` to run `tool`, e.g. `("uv", ["run", "pytest"])`.
    fn tool(&self, root: &Path, tool: &str) -> (String, Vec<String>) {
        match self {
            Self::Runner(r) => ((*r).to_owned(), vec!["run".into(), tool.into()]),
            Self::Venv(v) => {
                let exe = if cfg!(windows) { format!("{tool}.exe") } else { tool.to_owned() };
                let rel = format!("{v}/{}/{exe}", Self::bin_dir());
                if root.join(&rel).is_file() {
                    (rel, Vec::new())
                } else {
                    let py = format!("{v}/{}/{}", Self::bin_dir(), Self::python_exe());
                    (py, vec!["-m".into(), tool.into()])
                }
            }
            Self::System => (tool.to_owned(), Vec::new()),
        }
    }

    /// Whether a project virtualenv has `tool` installed.
    fn has_tool(&self, root: &Path, tool: &str) -> bool {
        let Self::Venv(v) = self else { return false };
        let exe = if cfg!(windows) { format!("{tool}.exe") } else { tool.to_owned() };
        root.join(v).join(Self::bin_dir()).join(exe).is_file()
    }

    fn python(&self) -> (String, Vec<String>) {
        match self {
            Self::Runner(r) => ((*r).to_owned(), vec!["run".into(), "python".into()]),
            Self::Venv(v) => (format!("{v}/{}/{}", Self::bin_dir(), Self::python_exe()), Vec::new()),
            Self::System => ((if cfg!(windows) { "python" } else { "python3" }).to_owned(), Vec::new()),
        }
    }
}

fn py_config(
    id: String,
    name: String,
    kind: &str,
    (command, mut args): (String, Vec<String>),
    extra: &[&str],
) -> RunConfig {
    args.extend(extra.iter().map(|a| (*a).to_owned()));
    let mut c = config(id, name, kind, &command, &[]);
    c.args = args;
    c.debug("debugpy")
}

fn uses_pytest(root: &Path) -> bool {
    if ["pytest.ini", "tox.ini", "conftest.py"].iter().any(|f| root.join(f).is_file()) {
        return true;
    }
    if read(&root.join("setup.cfg")).is_some_and(|s| s.contains("[tool:pytest]")) {
        return true;
    }
    if read(&root.join("pyproject.toml")).is_some_and(|py| py.contains("pytest") || root.join("tests").is_dir()) {
        return true;
    }
    ["requirements.txt", "requirements-dev.txt", "requirements_dev.txt", "dev-requirements.txt"]
        .iter()
        .any(|f| read(&root.join(f)).is_some_and(|s| s.contains("pytest")))
}

fn detect_python(root: &Path, out: &mut Vec<RunConfig>) {
    let markers = ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "pytest.ini", "tox.ini", "manage.py"];
    let env = PyEnv::detect(root);
    // A project virtualenv marks a Python project too (scripts + tests without packaging files).
    let venv = matches!(env, PyEnv::Venv(_));
    if !venv && !markers.iter().any(|m| root.join(m).is_file()) {
        return;
    }
    if root.join("manage.py").is_file() {
        out.push(py_config(
            "django:runserver".into(),
            "manage.py runserver".into(),
            "python",
            env.python(),
            &["manage.py", "runserver"],
        ));
    }
    let mut modules = Vec::new();
    for base in [root.to_path_buf(), root.join("src")] {
        for dir in subdirs(&base) {
            let name = dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            let ident = !name.is_empty() && name.chars().all(|c| c.is_alphanumeric() || c == '_');
            if ident && !matches!(name.as_str(), "venv" | "tests" | "test") && dir.join("__main__.py").is_file() {
                modules.push(name);
            }
        }
    }
    modules.sort();
    modules.dedup();
    for m in modules {
        out.push(py_config(
            format!("python:module:{m}"),
            format!("python -m {m}"),
            "python",
            env.python(),
            &["-m", &m],
        ));
    }
    if uses_pytest(root) || env.has_tool(root, "pytest") {
        out.push(py_config("pytest".into(), "pytest".into(), "pytest", env.tool(root, "pytest"), &[]).test());
    }
}

// ---------------------------------------------------------------- make / just

pub(crate) fn make_targets(src: &str) -> Vec<String> {
    let mut targets = Vec::new();
    let mut in_define = false;
    for line in src.lines() {
        let trimmed = line.trim();
        if in_define {
            if trimmed.starts_with("endef") {
                in_define = false;
            }
            continue;
        }
        if trimmed.starts_with("define ") || trimmed == "define" {
            in_define = true;
            continue;
        }
        if line.starts_with('\t') || line.starts_with(' ') || trimmed.starts_with('#') {
            continue;
        }
        let Some(colon) = line.find(':') else { continue };
        let head = &line[..colon];
        let after = &line[colon + 1..];
        // Variable assignments: `A := b`, `A ::= b`, `A = b:c`, `A ?= b`.
        if after.starts_with('=') || after.starts_with(":=") || head.contains('=') {
            continue;
        }
        if head.starts_with("export ") || head.starts_with("override ") || head.starts_with("include ") {
            continue;
        }
        for target in head.split_whitespace() {
            let special = target.starts_with('.') || target.contains(['%', '$', '/', '\\', '(', ')']);
            if !special && !targets.iter().any(|t| t == target) {
                targets.push(target.to_owned());
            }
        }
    }
    targets
}

fn detect_make(root: &Path, out: &mut Vec<RunConfig>) {
    let Some(path) = first_existing(root, &["GNUmakefile", "Makefile", "makefile"]) else { return };
    let Some(src) = read(&path) else { return };
    for target in make_targets(&src) {
        let mut c = config(format!("make:{target}"), format!("make {target}"), "make", "make", &[&target]);
        if matches!(target.as_str(), "test" | "check") {
            c = c.test();
        }
        out.push(c);
    }
}

pub(crate) fn just_recipes(src: &str) -> Vec<String> {
    let mut recipes = Vec::new();
    let mut private_attr = false;
    for line in src.lines() {
        if line.starts_with([' ', '\t']) {
            continue;
        }
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if trimmed.starts_with('[') {
            private_attr |= trimmed.contains("private");
            continue;
        }
        let is_private = std::mem::take(&mut private_attr);
        let keyword = trimmed.split_whitespace().next().unwrap_or_default();
        if matches!(keyword, "set" | "alias" | "export" | "import" | "mod" | "import?" | "mod?") {
            continue;
        }
        let body = trimmed.trim_start_matches('@');
        let name_len = body.find(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == '-')).unwrap_or(body.len());
        let name = &body[..name_len];
        if name.is_empty() || !name.starts_with(|c: char| c.is_ascii_alphabetic() || c == '_') {
            continue;
        }
        let rest = &body[name_len..];
        let Some(colon) = rest.find(':') else { continue };
        if rest[colon + 1..].starts_with('=')
            || rest[..colon].contains(":=")
            || rest[..colon].trim_start().starts_with('=')
        {
            continue;
        }
        if !is_private && !name.starts_with('_') && !recipes.iter().any(|r| r == name) {
            recipes.push(name.to_owned());
        }
    }
    recipes
}

// ---------------------------------------------------------------- godot

/// Godot projects (`project.godot`) at the root or one level down: "Godot Project"
/// runs the main scene (`godot --path .`), debuggable through the editor's adapter.
fn detect_godot(root: &Path, out: &mut Vec<RunConfig>) {
    let dirs = std::iter::once(root.to_path_buf()).chain(subdirs(root));
    for dir in dirs.filter(|d| d.join("project.godot").is_file()) {
        let rel = relative(root, &dir);
        let (id, name, cwd) = if rel.as_os_str().is_empty() {
            ("godot:project".to_owned(), "Godot Project".to_owned(), None)
        } else {
            let r = rel.to_string_lossy();
            (format!("godot:project:{r}"), format!("Godot Project ({r})"), Some(rel.clone()))
        };
        out.push(config(id, name, "godot", "godot", &["--path", "."]).debug("godot").in_dir(cwd));
    }
}

fn detect_just(root: &Path, out: &mut Vec<RunConfig>) {
    let Some(path) = first_existing(root, &["justfile", "Justfile", ".justfile"]) else { return };
    let Some(src) = read(&path) else { return };
    for recipe in just_recipes(&src) {
        let mut c = config(format!("just:{recipe}"), format!("just {recipe}"), "just", "just", &[&recipe]);
        if recipe == "test" {
            c = c.test();
        }
        out.push(c);
    }
}
