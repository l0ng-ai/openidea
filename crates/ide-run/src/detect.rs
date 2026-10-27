//! Run configuration detection from build files found at the project root.
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

/// Strips `//` and `/* */` comments and trailing commas so JSONC parses as JSON.
pub(crate) fn strip_jsonc(src: &str) -> String {
    let mut out = String::with_capacity(src.len());
    let mut chars = src.chars().peekable();
    let mut in_str = false;
    while let Some(c) = chars.next() {
        if in_str {
            out.push(c);
            if c == '\\' {
                if let Some(n) = chars.next() {
                    out.push(n);
                }
            } else if c == '"' {
                in_str = false;
            }
            continue;
        }
        match c {
            '"' => {
                in_str = true;
                out.push(c);
            }
            '/' if chars.peek() == Some(&'/') => {
                for n in chars.by_ref() {
                    if n == '\n' {
                        out.push('\n');
                        break;
                    }
                }
            }
            '/' if chars.peek() == Some(&'*') => {
                chars.next();
                let mut prev = '\0';
                for n in chars.by_ref() {
                    if prev == '*' && n == '/' {
                        break;
                    }
                    prev = n;
                }
            }
            _ => out.push(c),
        }
    }
    // Remove trailing commas before `}` / `]` (outside strings).
    let mut cleaned = String::with_capacity(out.len());
    let bytes: Vec<char> = out.chars().collect();
    let mut in_str = false;
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i];
        if in_str {
            cleaned.push(c);
            if c == '\\' && i + 1 < bytes.len() {
                cleaned.push(bytes[i + 1]);
                i += 1;
            } else if c == '"' {
                in_str = false;
            }
        } else if c == '"' {
            in_str = true;
            cleaned.push(c);
        } else if c == ',' {
            let next = bytes[i + 1..].iter().find(|ch| !ch.is_whitespace());
            if !matches!(next, Some('}') | Some(']')) {
                cleaned.push(c);
            }
        } else {
            cleaned.push(c);
        }
        i += 1;
    }
    cleaned
}

fn detect_deno(root: &Path, out: &mut Vec<RunConfig>) {
    let Some(path) = first_existing(root, &["deno.json", "deno.jsonc"]) else { return };
    let Some(json) = read(&path).and_then(|s| serde_json::from_str::<Json>(&strip_jsonc(&s)).ok()) else { return };
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

fn detect_gradle(root: &Path, out: &mut Vec<RunConfig>) {
    let names = ["build.gradle.kts", "build.gradle"];
    let has_settings = first_existing(root, &["settings.gradle.kts", "settings.gradle"]).is_some();
    let text = match collect_texts(root, &names) {
        Some(t) => t,
        None if has_settings => collect_texts_from_subdirs(root, &names),
        None => return,
    };
    let cmd = wrapper(root, "gradlew", "gradlew.bat", "gradle");
    out.push(config("gradle:build", "gradle build", "gradle", &cmd, &["build"]));
    out.push(config("gradle:test", "gradle test", "gradle", &cmd, &["test"]).test());
    if applies_application_plugin(&text) {
        out.push(config("gradle:run", "gradle run", "gradle", &cmd, &["run"]));
    }
    if text.contains("org.springframework.boot") {
        out.push(config("gradle:bootRun", "gradle bootRun", "gradle", &cmd, &["bootRun"]));
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
    let Some(text) = collect_texts(root, &["pom.xml"]) else { return };
    let cmd = wrapper(root, "mvnw", "mvnw.cmd", "mvn");
    out.push(config("maven:package", "mvn package", "maven", &cmd, &["package"]));
    out.push(config("maven:test", "mvn test", "maven", &cmd, &["test"]).test());
    if text.contains("spring-boot-maven-plugin") {
        out.push(config("maven:spring-boot:run", "mvn spring-boot:run", "maven", &cmd, &["spring-boot:run"]));
    }
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
