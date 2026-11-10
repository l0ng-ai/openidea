//! Run points inside a file (the editor's gutter ▶ icons) and the run configuration of
//! one: a port of the frontend's `features/run/targets.ts` and `context.ts` for Rust,
//! JavaScript/TypeScript, Python and Go. JVM files are not covered (the editor scans
//! them with a parser of its own).

use ide_run::RunConfig;
use regex_lite::Regex;
use std::path::Path;
use std::sync::LazyLock;

/// Above this size files are not scanned (generated / minified files).
const MAX_SCAN: usize = 400_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Main,
    Test,
    Suite,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Target {
    /// 0-based line of the declaration.
    pub line: usize,
    pub kind: Kind,
    /// Display name (`adds_numbers`, `math > adds`).
    pub name: String,
    /// Rust module path, describe chain, Python class chain…
    pub path: Vec<String>,
}

macro_rules! re {
    ($name:ident, $re:expr) => {
        static $name: LazyLock<Regex> = LazyLock::new(|| Regex::new($re).expect("valid regex"));
    };
}

fn indent_of(s: &str) -> usize {
    s.chars().take_while(|c| c.is_whitespace()).map(|c| if c == '\t' { 4 } else { 1 }).sum()
}

// ---------------------------------------------------------------- Rust

re!(LINE_COMMENT, r"//.*$");
re!(STRING, r#""(?:[^"\\]|\\.)*""#);
re!(CHAR, r"'(?:[^'\\]|\\.)'");

/// Strips string literals and line comments (rough) so braces inside them don't count.
fn code_only(line: &str) -> String {
    let line = LINE_COMMENT.replace(line, "");
    let line = STRING.replace_all(&line, "\"\"");
    CHAR.replace_all(&line, "''").into_owned()
}

re!(RUST_SRC, r"(?:^|/)src/(.+)\.rs$");

fn rust_module_prefix(rel: &str) -> Vec<String> {
    let Some(m) = RUST_SRC.captures(rel) else { return Vec::new() };
    let mut parts: Vec<String> = m[1].split('/').map(str::to_owned).collect();
    let last = parts.last().cloned().unwrap_or_default();
    if parts.len() == 1 && (last == "lib" || last == "main") || parts[0] == "bin" {
        return Vec::new();
    }
    if last == "mod" {
        parts.pop();
    }
    parts
}

re!(RUST_TEST_ATTR, r"^#\[(?:[\w:]+::)?test\b|^#\[(?:tokio|async_std|actix_rt|rstest|test_case)(?:::\w+)?\b");
re!(RUST_CFG_TEST, r"^#\[cfg\(test\)\]");
re!(RUST_FN, r"^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+(\w+)");
re!(RUST_MOD, r"^(?:pub(?:\([^)]*\))?\s+)?mod\s+(\w+)\s*\{");
re!(RUST_MAIN_FILE, r"(?:^|/)(?:src/main|src/bin/[^/]+|examples/[^/]+)\.rs$");

fn rust_targets(lines: &[&str], rel: &str) -> Vec<Target> {
    let mut out: Vec<Target> = Vec::new();
    let prefix = rust_module_prefix(rel);
    let mut mods: Vec<(String, i64)> = Vec::new();
    let mut depth: i64 = 0;
    let mut pending_test = false;
    let mut pending_cfg_test = false;
    for (i, raw) in lines.iter().enumerate() {
        let line = code_only(raw);
        let trimmed = line.trim();
        if RUST_TEST_ATTR.is_match(trimmed) {
            pending_test = true;
        }
        if RUST_CFG_TEST.is_match(trimmed) {
            pending_cfg_test = true;
        }
        let mod_path = || prefix.iter().cloned().chain(mods.iter().map(|m| m.0.clone())).collect::<Vec<_>>();
        if let Some(f) = RUST_FN.captures(trimmed) {
            let name = f[1].to_owned();
            if pending_test {
                let mut path = mod_path();
                path.push(name.clone());
                out.push(Target { line: i, kind: Kind::Test, name, path });
            } else if name == "main" && depth == 0 && RUST_MAIN_FILE.is_match(rel) {
                out.push(Target { line: i, kind: Kind::Main, name, path: Vec::new() });
            }
            pending_test = false;
            pending_cfg_test = false;
        } else if let Some(m) = RUST_MOD.captures(trimmed) {
            let name = m[1].to_owned();
            let mut path = mod_path();
            path.push(name.clone());
            if pending_cfg_test || name == "tests" {
                out.push(Target { line: i, kind: Kind::Suite, name: name.clone(), path });
            }
            mods.push((name, depth));
            pending_test = false;
            pending_cfg_test = false;
        } else if !trimmed.is_empty() && !trimmed.starts_with("#[") && !trimmed.starts_with("//") {
            pending_test = false;
            if !trimmed.starts_with('#') {
                pending_cfg_test = false;
            }
        }
        for ch in line.chars() {
            if ch == '{' {
                depth += 1;
            } else if ch == '}' {
                depth -= 1;
                while mods.last().is_some_and(|m| m.1 >= depth) {
                    mods.pop();
                }
            }
        }
    }
    // A suite that contains no tests is noise.
    let tests: Vec<Vec<String>> = out.iter().filter(|t| t.kind == Kind::Test).map(|t| t.path.clone()).collect();
    out.retain(|t| t.kind != Kind::Suite || tests.iter().any(|p| p.len() > t.path.len() && p.starts_with(&t.path)));
    out
}

// ---------------------------------------------------------------- JavaScript / TypeScript

re!(
    JS_CALL,
    r"^(\s*)(describe|suite|context|test|it)\b(?:\.(?:only|skip|todo|concurrent|failing|sequential))*(\.each\s*(?:\(.*?\)|`[^`]*`))?\s*\(\s*"
);

/// The string literal at the start of `s` (quote, then text up to the same unescaped quote).
fn js_string(s: &str) -> Option<(char, String)> {
    let mut chars = s.chars();
    let quote = chars.next().filter(|q| matches!(q, '\'' | '"' | '`'))?;
    let mut raw = String::new();
    while let Some(c) = chars.next() {
        if c == quote {
            return Some((quote, raw));
        }
        raw.push(c);
        if c == '\\' {
            raw.push(chars.next()?);
        }
    }
    None
}

re!(JS_ESCAPE, r"\\(.)");

fn js_targets(lines: &[&str]) -> Vec<Target> {
    let mut out = Vec::new();
    let mut stack: Vec<(usize, String)> = Vec::new();
    for (i, line) in lines.iter().enumerate() {
        let Some(m) = JS_CALL.captures(line) else { continue };
        let Some((_quote, raw)) = js_string(&line[m.get(0).map_or(0, |g| g.end())..]) else { continue };
        let indent = indent_of(&m[1]);
        while stack.last().is_some_and(|s| s.0 >= indent) {
            stack.pop();
        }
        let name = JS_ESCAPE.replace_all(&raw, "$1").into_owned();
        let mut path: Vec<String> = stack.iter().map(|s| s.1.clone()).collect();
        path.push(name.clone());
        let suite = matches!(&m[2], "describe" | "suite" | "context");
        out.push(Target { line: i, kind: if suite { Kind::Suite } else { Kind::Test }, name: path.join(" > "), path });
        if suite {
            stack.push((indent, name));
        }
    }
    out
}

fn escape_regexp(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if ".*+?^${}()|[]\\".contains(c) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

re!(JS_PATTERN_PLACEHOLDER, r"%[sdifjo#p]|\\\$\\\{[^}]*\\\}|\$\w+");

/// Jest / Vitest `-t` pattern for a test (full name = describe chain + name, space separated).
fn js_name_pattern(target: &Target) -> String {
    let pattern = escape_regexp(&target.path.join(" "));
    // `test.each` placeholders (%s, $name, ${…}) match anything.
    let pattern = JS_PATTERN_PLACEHOLDER.replace_all(&pattern, ".*");
    if target.kind == Kind::Suite { format!("^{pattern}") } else { format!("^{pattern}$") }
}

// ---------------------------------------------------------------- Python

re!(PY_COMMENT, r"^\s*#");
re!(PY_CLASS, r"^\s*class\s+(\w+)");
re!(PY_TEST_DEF, r"^\s*(?:async\s+)?def\s+(test\w*)\s*\(");
re!(PY_MAIN, r#"^if\s+__name__\s*==\s*['"]__main__['"]\s*:"#);

fn python_targets(lines: &[&str]) -> Vec<Target> {
    let mut out = Vec::new();
    let mut classes: Vec<(usize, String, bool)> = Vec::new();
    for (i, line) in lines.iter().enumerate() {
        if line.trim().is_empty() || PY_COMMENT.is_match(line) {
            continue;
        }
        let indent = indent_of(line);
        while classes.last().is_some_and(|c| c.0 >= indent) {
            classes.pop();
        }
        if let Some(c) = PY_CLASS.captures(line) {
            let test = c[1].starts_with("Test") && classes.iter().all(|c| c.2);
            classes.push((indent, c[1].to_owned(), test));
            if test {
                let path: Vec<String> = classes.iter().map(|c| c.1.clone()).collect();
                out.push(Target { line: i, kind: Kind::Suite, name: c[1].to_owned(), path });
            }
            continue;
        }
        if let Some(d) = PY_TEST_DEF.captures(line)
            && classes.iter().all(|c| c.2)
        {
            let mut path: Vec<String> = classes.iter().map(|c| c.1.clone()).collect();
            path.push(d[1].to_owned());
            out.push(Target { line: i, kind: Kind::Test, name: path.join("."), path });
            continue;
        }
        if indent == 0 && PY_MAIN.is_match(line) {
            out.push(Target { line: i, kind: Kind::Main, name: "main".into(), path: Vec::new() });
        }
    }
    out
}

// ---------------------------------------------------------------- Go

re!(GO_PACKAGE_MAIN, r"^package\s+main\b");
re!(GO_TEST, r"^func\s+(Test\w*|Benchmark\w*|Example\w*|Fuzz\w*)\s*\(\s*(?:\w+\s+\*testing\.[TFB])?\s*\)?");
re!(GO_TESTING_ARG, r"\*testing\.[TFB]");
re!(GO_TESTING_TB, r"\*testing\.[TB]\b");
re!(GO_MAIN, r"^func\s+main\s*\(\s*\)");
re!(GO_ONE_LINE, r"\}\s*(?://.*)?$");
re!(GO_RUN_LITERAL, r#"\b\w+\.Run\(\s*"((?:[^"\\]|\\.)*)"\s*,"#);
re!(GO_RUN_FIELD, r"\b\w+\.Run\(\s*\w+\.(\w+)\s*,");
re!(GO_RUN_KEY, r"\b\w+\.Run\(\s*(\w+)\s*,");
re!(GO_MAP_KEY, r#"^\s*"((?:[^"\\]|\\.)*)"\s*:\s*\{"#);
re!(WHITESPACE, r"\s");

fn go_targets(lines: &[&str]) -> Vec<Target> {
    let mut out = Vec::new();
    let is_main = lines.iter().any(|l| GO_PACKAGE_MAIN.is_match(l));
    for (i, line) in lines.iter().enumerate() {
        if let Some(t) = GO_TEST.captures(line) {
            let name = t[1].to_owned();
            if name.starts_with("Example") || GO_TESTING_ARG.is_match(line) {
                out.push(Target { line: i, kind: Kind::Test, name: name.clone(), path: vec![name.clone()] });
                if GO_TESTING_TB.is_match(line) {
                    out.extend(go_subtests(lines, i, &name));
                }
                continue;
            }
        }
        if is_main && GO_MAIN.is_match(line) {
            out.push(Target { line: i, kind: Kind::Main, name: "main".into(), path: Vec::new() });
        }
    }
    out
}

/// Subtests of the test function at `start`: `t.Run("name", …)`, and table entries run with
/// `t.Run(tt.name, …)` (`{name: "…", …}`) or keyed by name (`"…": {…}`).
fn go_subtests(lines: &[&str], start: usize, test: &str) -> Vec<Target> {
    if GO_ONE_LINE.is_match(lines[start]) {
        return Vec::new();
    }
    let mut end = start;
    while end + 1 < lines.len() && !lines[end].starts_with('}') {
        end += 1;
    }
    let body = &lines[start + 1..end.max(start + 1)];
    let mut out: Vec<Target> = Vec::new();
    let mut add = |offset: usize, name: &str| {
        let sub = WHITESPACE.replace_all(&JS_ESCAPE.replace_all(name, "$1"), "_").into_owned();
        if !out.iter().any(|t| t.path[1] == sub) {
            out.push(Target {
                line: start + 1 + offset,
                kind: Kind::Test,
                name: format!("{test}/{sub}"),
                path: vec![test.to_owned(), sub],
            });
        }
    };
    let mut fields: Vec<String> = Vec::new();
    let mut keys: Vec<String> = Vec::new();
    for (i, l) in body.iter().enumerate() {
        if let Some(m) = GO_RUN_LITERAL.captures(l) {
            add(i, &m[1]);
        }
        if let Some(m) = GO_RUN_FIELD.captures(l) {
            fields.push(m[1].to_owned());
        }
        if let Some(m) = GO_RUN_KEY.captures(l) {
            let range = Regex::new(&format!(r"\bfor\s+{}\s*,\s*\w+\s*:=\s*range\b", &m[1])).expect("valid regex");
            if body[..i].iter().any(|b| range.is_match(b)) {
                keys.push(m[1].to_owned());
            }
        }
    }
    if !fields.is_empty() || !keys.is_empty() {
        let field_res: Vec<Regex> = fields
            .iter()
            .map(|f| Regex::new(&format!(r#"\b{f}\s*:\s*"((?:[^"\\]|\\.)*)""#)).expect("valid regex"))
            .collect();
        for (i, l) in body.iter().enumerate() {
            for re in &field_res {
                if let Some(m) = re.captures(l) {
                    add(i, &m[1]);
                }
            }
            if !keys.is_empty()
                && let Some(m) = GO_MAP_KEY.captures(l)
            {
                add(i, &m[1]);
            }
        }
    }
    out.sort_by_key(|t| t.line);
    out
}

// ---------------------------------------------------------------- detection

re!(JS_FILE, r"\.[cm]?[jt]sx?$");
re!(JS_TEST_FILE, r"\.(test|spec)\.[cm]?[jt]sx?$|(^|/)__tests__/");
re!(PY_TEST_FILE, r"(^|/)(test_[^/]*|[^/]*_test)\.py$|(^|/)tests?/");

/// Run targets of a file (`rel`: project-relative with `/`, picks the language).
pub fn detect(text: &str, rel: &str) -> Vec<Target> {
    if text.len() > MAX_SCAN {
        return Vec::new();
    }
    let lines: Vec<&str> = text.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l)).collect();
    if rel.ends_with(".rs") {
        rust_targets(&lines, rel)
    } else if JS_FILE.is_match(rel) {
        if JS_TEST_FILE.is_match(rel) { js_targets(&lines) } else { Vec::new() }
    } else if rel.ends_with(".py") {
        let test_file = PY_TEST_FILE.is_match(rel);
        python_targets(&lines).into_iter().filter(|t| t.kind == Kind::Main || test_file).collect()
    } else if rel.ends_with(".go") {
        let test_file = rel.ends_with("_test.go");
        go_targets(&lines).into_iter().filter(|t| t.kind == Kind::Main || test_file).collect()
    } else {
        Vec::new()
    }
}

/// The last line (0-based) of the block declared at `start`: by indentation in Python, else
/// where the braces opened on (or, for a Rust signature, after) the declaration close again.
fn block_end(lines: &[&str], start: usize, rel: &str) -> usize {
    if rel.ends_with(".py") {
        let indent = indent_of(lines[start]);
        let mut end = start;
        for (i, line) in lines.iter().enumerate().skip(start + 1) {
            if line.trim().is_empty() || PY_COMMENT.is_match(line) {
                continue;
            }
            if indent_of(line) <= indent {
                break;
            }
            end = i;
        }
        return end;
    }
    let rust = rel.ends_with(".rs");
    let mut depth: i64 = 0;
    let mut opened = false;
    for (i, raw) in lines.iter().enumerate().skip(start) {
        let line = code_only(raw);
        for ch in line.chars() {
            match ch {
                '{' => {
                    depth += 1;
                    opened = true;
                }
                '}' => depth -= 1,
                // A Rust declaration without a body (`fn f();`).
                ';' if rust && !opened => return i,
                _ => {}
            }
            if opened && depth <= 0 {
                return i;
            }
        }
        // Only a Rust signature continues on the next lines; a call without a block ends here.
        if !opened && !rust {
            return i;
        }
    }
    lines.len().saturating_sub(1)
}

/// The run targets whose declaration or body contains `line` (0-based), innermost first.
pub fn enclosing(text: &str, rel: &str, line: usize) -> Vec<Target> {
    let lines: Vec<&str> = text.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l)).collect();
    let mut out: Vec<Target> =
        detect(text, rel).into_iter().filter(|t| t.line <= line && line <= block_end(&lines, t.line, rel)).collect();
    out.sort_by_key(|t| std::cmp::Reverse(t.line));
    out
}

// ---------------------------------------------------------------- configurations

/// A configuration's working directory relative to the project root, with `/` (Go: its module).
fn cwd_of(root: &Path, c: &RunConfig) -> String {
    let module = (c.kind == "go").then(|| c.extras.params.get("module").cloned()).flatten();
    let cwd = module
        .or_else(|| c.cwd.as_deref().map(|p| p.strip_prefix(root).unwrap_or(p).to_string_lossy().replace('\\', "/")));
    let cwd = cwd.unwrap_or_default();
    let cwd = cwd.strip_prefix("./").or_else(|| cwd.strip_prefix('.')).unwrap_or(&cwd);
    cwd.trim_end_matches('/').to_owned()
}

/// Configs whose working directory most specifically contains `rel` (ties in their original order).
fn all_closest<'a>(root: &Path, configs: &[&'a RunConfig], rel: &str) -> Vec<&'a RunConfig> {
    let score = |c: &RunConfig| -> Option<usize> {
        let cwd = cwd_of(root, c);
        if cwd.is_empty() { Some(0) } else { (rel == cwd || rel.starts_with(&format!("{cwd}/"))).then_some(cwd.len()) }
    };
    let scored: Vec<(&RunConfig, usize)> = configs.iter().filter_map(|c| score(c).map(|s| (*c, s))).collect();
    let best = scored.iter().map(|s| s.1).max();
    scored.into_iter().filter(|s| Some(s.1) == best).map(|s| s.0).collect()
}

fn closest<'a>(root: &Path, configs: &[&'a RunConfig], rel: &str) -> Option<&'a RunConfig> {
    all_closest(root, configs, rel).into_iter().next()
}

fn rel_to_cwd(root: &Path, rel: &str, c: &RunConfig) -> String {
    let cwd = cwd_of(root, c);
    match rel.strip_prefix(&format!("{cwd}/")) {
        Some(inner) if !cwd.is_empty() => inner.to_owned(),
        _ => rel.to_owned(),
    }
}

fn file_name(rel: &str) -> &str {
    rel.rsplit('/').next().unwrap_or(rel)
}

fn dir_of(p: &str) -> &str {
    p.rfind('/').map_or("", |i| &p[..i])
}

fn derived(base: &RunConfig, rel: &str, args: Vec<String>) -> RunConfig {
    RunConfig {
        id: format!("context:{}:{rel}", base.id),
        name: file_name(rel).to_owned(),
        args,
        detected: true,
        ..base.clone()
    }
}

/// Kinds whose test configs can run a file of this extension.
fn test_kinds(rel: &str) -> &'static [&'static str] {
    if JS_FILE.is_match(rel) {
        &["npm", "deno", "bun"]
    } else if rel.ends_with(".py") {
        &["pytest", "python"]
    } else if rel.ends_with(".go") {
        &["go"]
    } else if rel.ends_with(".rs") {
        &["cargo"]
    } else {
        &[]
    }
}

/// The project's Python interpreter as `(command, leading args)`, from detected configs.
fn project_python(configs: &[RunConfig]) -> Option<(String, Vec<String>)> {
    if let Some(py) = configs.iter().find(|c| c.kind == "python") {
        let prefix = match py.args.iter().position(|a| a == "-m") {
            Some(m) => py.args[..m].to_vec(),
            None => py.args.iter().filter(|a| !a.ends_with(".py")).cloned().collect(),
        };
        return Some((py.command.clone(), prefix));
    }
    let pytest = configs.iter().find(|c| c.kind == "pytest")?;
    static VENV: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"^(.*[/\\](?:bin|Scripts)[/\\])pytest(\.exe)?$").expect("valid regex"));
    if let Some(m) = VENV.captures(&pytest.command) {
        return Some((format!("{}python{}", &m[1], m.get(2).map_or("", |g| g.as_str())), Vec::new()));
    }
    if let Some(m) = pytest.args.iter().position(|a| a == "-m")
        && pytest.args.get(m + 1).is_some_and(|a| a == "pytest")
    {
        return Some((pytest.command.clone(), pytest.args[..m].to_vec()));
    }
    if pytest.args.first().is_some_and(|a| a == "run") && pytest.args.get(1).is_some_and(|a| a == "pytest") {
        return Some((pytest.command.clone(), vec!["run".into(), "python".into()]));
    }
    None
}

fn blank(id: String, name: &str, kind: &str, command: String, args: Vec<String>) -> RunConfig {
    RunConfig {
        id,
        name: name.to_owned(),
        kind: kind.to_owned(),
        command,
        args,
        cwd: None,
        env: Default::default(),
        detected: true,
        is_test: false,
        debug_adapter: None,
        allow_parallel: false,
        extras: Default::default(),
    }
}

/// PyCharm runs pytest for a test file even when the project declares no test setup.
fn implicit_pytest(rel: &str, configs: &[RunConfig]) -> Option<RunConfig> {
    if !rel.ends_with(".py") {
        return None;
    }
    let (command, mut args) = project_python(configs).unwrap_or_else(|| ("python3".into(), Vec::new()));
    args.extend(["-m".to_owned(), "pytest".to_owned()]);
    let mut c = blank("pytest:implicit".into(), "pytest", "pytest", command, args);
    c.is_test = true;
    c.debug_adapter = Some("debugpy".into());
    Some(c)
}

fn test_base_for(root: &Path, rel: &str, configs: &[RunConfig]) -> Option<RunConfig> {
    let kinds = test_kinds(rel);
    // Configurations produced from a test or file are results of narrowing, never bases for it.
    let candidates: Vec<&RunConfig> = configs
        .iter()
        .filter(|c| c.is_test && kinds.contains(&c.kind.as_str()) && !c.id.starts_with("context:"))
        .collect();
    closest(root, &candidates, rel).or(candidates.first().copied()).cloned().or_else(|| implicit_pytest(rel, configs))
}

/// Go test flags may come before or after package targets; binary arguments start at `-args`.
fn go_test_parts(args: &[String]) -> (Vec<String>, Vec<String>, Vec<String>) {
    const BOOLEAN_FLAGS: &[&str] = &[
        "-a",
        "-n",
        "-race",
        "-msan",
        "-asan",
        "-cover",
        "-linkshared",
        "-modcacherw",
        "-trimpath",
        "-v",
        "-work",
        "-x",
        "-json",
        "-c",
        "-i",
        "-short",
        "-failfast",
        "-benchmem",
        "-fullpath",
        "-buildvcs",
    ];
    let (mut flags, mut targets, mut program) = (Vec::new(), Vec::new(), Vec::new());
    let mut i = 1;
    while i < args.len() {
        let arg = &args[i];
        if arg == "-args" || arg == "--" {
            program = args[i..].to_vec();
            break;
        }
        if arg.starts_with('-') {
            flags.push(arg.clone());
            if !arg.contains('=') && !BOOLEAN_FLAGS.contains(&arg.as_str()) && i + 1 < args.len() {
                i += 1;
                flags.push(args[i].clone());
            }
        } else {
            targets.push(arg.clone());
        }
        i += 1;
    }
    (flags, targets, program)
}

fn without_go_selection(flags: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < flags.len() {
        let f = flags[i].as_str();
        if matches!(f, "-run" | "-skip" | "-bench" | "-fuzz") {
            i += 2;
            continue;
        }
        if ["-run=", "-skip=", "-bench=", "-fuzz="].iter().any(|p| f.starts_with(p)) {
            i += 1;
            continue;
        }
        out.push(flags[i].clone());
        i += 1;
    }
    out
}

/// File-level test configuration for `rel` (the closest matching test config narrowed to the file).
fn test_config_for(root: &Path, rel: &str, configs: &[RunConfig]) -> Option<RunConfig> {
    let base = test_base_for(root, rel, configs)?;
    let file = rel_to_cwd(root, rel, &base);
    let with = |extra: &[String]| [base.args.clone(), extra.to_vec()].concat();
    Some(match base.kind.as_str() {
        // `npm run test -- file` works for npm, pnpm, yarn and bun.
        "npm" | "bun" if base.args.iter().any(|a| a == "--") => derived(&base, rel, with(&[file])),
        "npm" | "bun" => derived(&base, rel, with(&["--".into(), file])),
        "deno" | "pytest" | "python" => derived(&base, rel, with(&[file])),
        "go" => {
            let dir = dir_of(&file);
            let target = if dir.is_empty() { ".".to_owned() } else { format!("./{dir}") };
            let (flags, _, program) = go_test_parts(&base.args);
            let args = [vec!["test".to_owned()], flags, vec![target.clone()], program].concat();
            let mut c = derived(&base, rel, args);
            c.name = format!("go test {target}");
            if c.extras.params.contains_key("goKind") {
                c.extras.params.insert("scope".into(), "directory".into());
                c.extras.params.insert("target".into(), target);
            }
            c
        }
        "cargo" => {
            static TESTS: LazyLock<Regex> =
                LazyLock::new(|| Regex::new(r"(?:^|/)tests/([^/]+)\.rs$").expect("valid regex"));
            match TESTS.captures(rel) {
                Some(m) => {
                    // Cargo's own options go before the test binary's `--`.
                    let at = base.args.iter().position(|a| a == "--").unwrap_or(base.args.len());
                    let mut args = base.args.clone();
                    args.splice(at..at, ["--test".to_owned(), m[1].to_owned()]);
                    derived(&base, rel, args)
                }
                None => base,
            }
        }
        _ => base,
    })
}

fn main_config_for(root: &Path, rel: &str, configs: &[RunConfig]) -> Option<RunConfig> {
    if rel.ends_with(".rs") {
        static BIN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"src/bin/([^/]+)\.rs$").expect("valid regex"));
        let bin = BIN.captures(rel).map(|m| m[1].to_owned());
        let runs: Vec<&RunConfig> =
            configs.iter().filter(|c| c.kind == "cargo" && c.id.starts_with("cargo:run")).collect();
        let by_bin =
            bin.and_then(|b| runs.iter().find(|c| c.id == format!("cargo:run:{b}") || c.args.contains(&b)).copied());
        return by_bin.or_else(|| closest(root, &runs, rel)).or(runs.first().copied()).cloned();
    }
    if rel.ends_with(".go") {
        let gos: Vec<&RunConfig> = configs.iter().filter(|c| c.kind == "go").collect();
        let runs: Vec<&RunConfig> =
            gos.iter().filter(|c| c.args.first().is_some_and(|a| a == "run")).copied().collect();
        // The module containing the file (nested modules run from their own directory).
        let base = closest(root, &runs, rel)
            .or_else(|| closest(root, &gos, rel))
            .or(runs.first().copied())
            .or(gos.first().copied())?;
        let dir = rel_to_cwd(root, rel, base);
        let dir = dir_of(&dir);
        let target = if dir.is_empty() { ".".to_owned() } else { format!("./{dir}") };
        if let Some(hit) = runs.iter().find(|c| c.cwd == base.cwd && c.args.get(1) == Some(&target)) {
            return Some((*hit).clone());
        }
        let mut c = derived(base, rel, vec!["run".into(), target.clone()]);
        c.name = format!("go run {target}");
        c.is_test = false;
        return Some(c);
    }
    None
}

fn script_config_for(rel: &str, configs: &[RunConfig]) -> Option<RunConfig> {
    let id = format!("context:file:{rel}");
    let name = file_name(rel);
    let script = |command: &str, args: Vec<String>| blank(id.clone(), name, "shell", command.to_owned(), args);
    if rel.ends_with(".py") {
        // Reuse the project's interpreter (venv / uv / poetry) when detected.
        let (command, mut args) = project_python(configs).unwrap_or_else(|| ("python3".into(), Vec::new()));
        args.push(rel.to_owned());
        let mut c = blank(id, name, "python", command, args);
        c.debug_adapter = Some("debugpy".into());
        return Some(c);
    }
    static JS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\.[cm]?js$").expect("valid regex"));
    if JS.is_match(rel) {
        return Some(script("node", vec![rel.to_owned()]));
    }
    if rel.ends_with(".ts") {
        return Some(script("npx", vec!["tsx".into(), rel.to_owned()]));
    }
    for (ext, shell) in [(".zsh", "zsh"), (".bash", "bash"), (".sh", "sh")] {
        if rel.ends_with(ext) {
            return Some(script(shell, vec![rel.to_owned()]));
        }
    }
    None
}

re!(TEST_FILE, r"\.(test|spec)\.[cm]?[jt]sx?$|(^|/)__tests__/|(^|/)(test_[^/]*\.py|[^/]*_test\.py|[^/]*_test\.go)$");
re!(RUST_TESTS_FILE, r"(^|/)tests/[^/]+\.rs$");
re!(RUST_MAIN_ROLE, r"(^|/)src/main\.rs$|(^|/)src/bin/[^/]+\.rs$");
re!(GO_PACKAGE_MAIN_MULTILINE, r"(?m)^\s*package\s+main\b");
re!(SCRIPT_FILE, r"\.(py|sh|bash|zsh|[cm]?js|ts)$");

/// "Run Context Configuration" for the whole file: its tests, its main target or the script.
pub fn context_config(root: &Path, rel: &str, configs: &[RunConfig], content: &str) -> Option<RunConfig> {
    let name = file_name(rel);
    if TEST_FILE.is_match(rel) || (RUST_TESTS_FILE.is_match(rel) && name != "mod.rs") {
        return test_config_for(root, rel, configs);
    }
    if RUST_MAIN_ROLE.is_match(rel) || (rel.ends_with(".go") && GO_PACKAGE_MAIN_MULTILINE.is_match(content)) {
        return main_config_for(root, rel, configs).or_else(|| script_config_for(rel, configs));
    }
    if SCRIPT_FILE.is_match(name) {
        return script_config_for(rel, configs);
    }
    None
}

fn replace_last(mut args: Vec<String>, f: impl FnOnce(&str) -> String) -> Vec<String> {
    if let Some(last) = args.last_mut() {
        *last = f(last);
    }
    args
}

/// The run configuration of one target, or `None` when the project has no matching runner.
pub fn target_config(
    root: &Path,
    target: &Target,
    rel: &str,
    configs: &[RunConfig],
    content: &str,
) -> Option<RunConfig> {
    if target.kind == Kind::Main {
        return context_config(root, rel, configs, content);
    }
    let file = test_config_for(root, rel, configs)?;
    let short =
        if target.kind == Kind::Suite { target.path.last().cloned().unwrap_or_default() } else { target.name.clone() };
    let named = |args: Vec<String>| RunConfig {
        id: format!("context:target:{}:{rel}:{}", file.id, target.path.join("/")),
        name: short.clone(),
        args,
        detected: true,
        ..file.clone()
    };
    let with = |extra: Vec<String>| [file.args.clone(), extra].concat();
    match file.kind.as_str() {
        "npm" | "bun" | "deno" => Some(named(with(vec!["-t".into(), js_name_pattern(target)]))),
        "pytest" | "python" => {
            Some(named(replace_last(file.args.clone(), |f| format!("{f}::{}", target.path.join("::")))))
        }
        "go" => {
            let pattern = format!("^{}$", target.path.iter().map(|p| escape_regexp(p)).collect::<Vec<_>>().join("$/^"));
            let benchmark = target.path.first().is_some_and(|p| p.starts_with("Benchmark"));
            let (flags, targets, program) = go_test_parts(&file.args);
            let selection: Vec<String> = if benchmark {
                vec!["-run".into(), "^$".into(), "-bench".into(), pattern.clone()]
            } else {
                vec!["-run".into(), pattern.clone()]
            };
            let flags = without_go_selection(&flags);
            let mut c = named([vec!["test".to_owned()], flags.clone(), targets, selection, program].concat());
            if c.extras.params.contains_key("goKind") {
                let mut tool_args: Vec<String> = flags;
                if benchmark {
                    tool_args.extend(["-bench".to_owned(), pattern.clone()]);
                }
                c.extras.params.insert("pattern".into(), if benchmark { "^$".into() } else { pattern });
                c.extras.params.insert(
                    "toolArgs".into(),
                    tool_args.iter().map(|a| super::process::quote(a)).collect::<Vec<_>>().join(" "),
                );
            }
            Some(c)
        }
        "cargo" => {
            let path = target.path.join("::");
            // Test-binary arguments follow the one `--` (`cargo test -- --nocapture` has it already).
            let separator: Vec<String> =
                if file.args.iter().any(|a| a == "--") { Vec::new() } else { vec!["--".into()] };
            Some(named(if target.kind == Kind::Suite {
                with([separator, vec![format!("{path}::")]].concat())
            } else {
                with([separator, vec![path, "--exact".into()]].concat())
            }))
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pick(ts: &[Target]) -> Vec<(usize, Kind, String)> {
        ts.iter().map(|t| (t.line, t.kind, t.path.join("/"))).collect()
    }

    #[test]
    fn rust_main_tests_and_test_modules() {
        let src = [
            "fn main() {}",
            "#[cfg(test)]",
            "mod tests {",
            "    use super::*;",
            "    #[test]",
            "    fn adds() { let s = \"}\"; }",
            "    #[tokio::test]",
            "    #[ignore]",
            "    async fn async_one() {}",
            "    fn helper() {}",
            "}",
            "fn after() {}",
        ]
        .join("\n");
        assert_eq!(
            pick(&detect(&src, "src/main.rs")),
            [
                (0, Kind::Main, String::new()),
                (2, Kind::Suite, "tests".into()),
                (5, Kind::Test, "tests/adds".into()),
                (8, Kind::Test, "tests/async_one".into()),
            ]
        );
        assert_eq!(
            pick(&detect("#[test]\nfn x() {}", "crates/a/src/foo/bar.rs")),
            [(1, Kind::Test, "foo/bar/x".into())]
        );
        assert!(detect("fn main() {}", "src/lib.rs").is_empty());
    }

    #[test]
    fn js_describe_chains() {
        let src = [
            "describe('math', () => {",
            "  it('adds', () => {});",
            "  describe(\"nested\", () => {",
            "    test.each([[1]])('n=%i', () => {});",
            "  });",
            "  test.skip(`subs`, () => {});",
            "});",
            "const item = items.find((x) => x);",
            "test('top', () => {});",
        ]
        .join("\n");
        let ts = detect(&src, "src/math.test.ts");
        assert_eq!(
            pick(&ts),
            [
                (0, Kind::Suite, "math".into()),
                (1, Kind::Test, "math/adds".into()),
                (2, Kind::Suite, "math/nested".into()),
                (3, Kind::Test, "math/nested/n=%i".into()),
                (5, Kind::Test, "math/subs".into()),
                (8, Kind::Test, "top".into()),
            ]
        );
        assert_eq!(js_name_pattern(&ts[1]), "^math adds$");
        assert_eq!(js_name_pattern(&ts[3]), "^math nested n=.*$");
        assert_eq!(js_name_pattern(&ts[0]), "^math");
        assert!(detect("test('x', () => {})", "src/math.ts").is_empty());
    }

    #[test]
    fn python_and_go() {
        let src = "class TestCalc:\n    def test_add(self):\n        pass\ndef test_top():\n    pass\nclass Helper:\n    def test_no(self):\n        pass\nif __name__ == '__main__':\n    main()\n";
        assert_eq!(
            pick(&detect(src, "tests/test_calc.py")),
            [
                (0, Kind::Suite, "TestCalc".into()),
                (1, Kind::Test, "TestCalc/test_add".into()),
                (3, Kind::Test, "test_top".into()),
                (8, Kind::Main, String::new()),
            ]
        );
        let go = "package calc\n\nfunc TestAdd(t *testing.T) {\n\tt.Run(\"zero case\", func(t *testing.T) {})\n}\n";
        assert_eq!(
            pick(&detect(go, "calc_test.go")),
            [(2, Kind::Test, "TestAdd".into()), (3, Kind::Test, "TestAdd/zero_case".into())]
        );
    }

    #[test]
    fn narrows_cargo_test_configs() {
        let root = Path::new("/p");
        let mut test = blank("cargo:test".into(), "test", "cargo", "cargo".into(), vec!["test".into()]);
        test.is_test = true;
        let configs = vec![test];
        let src = "#[cfg(test)]\nmod tests {\n    #[test]\n    fn adds() {}\n}\n";
        let ts = detect(src, "src/math.rs");
        let c = target_config(root, &ts[1], "src/math.rs", &configs, src).unwrap();
        assert_eq!(c.args, ["test", "--", "math::tests::adds", "--exact"]);
        let c = target_config(root, &ts[0], "src/math.rs", &configs, src).unwrap();
        assert_eq!(c.args, ["test", "--", "math::tests::"]);
    }

    #[test]
    fn cargo_test_args_get_one_separator() {
        let root = Path::new("/p");
        let mut test =
            blank("cargo:test".into(), "test", "cargo", "cargo".into(), vec!["test".into(), "--".into(), "-q".into()]);
        test.is_test = true;
        let configs = vec![test];
        let src = "#[test]\nfn adds() {}\n";
        let ts = detect(src, "tests/math.rs");
        let c = target_config(root, &ts[0], "tests/math.rs", &configs, src).unwrap();
        assert_eq!(c.args, ["test", "--test", "math", "--", "-q", "adds", "--exact"]);
    }

    #[test]
    fn a_line_in_a_body_picks_the_enclosing_target() {
        let names = |src: &str, rel: &str, line: usize| -> Vec<String> {
            enclosing(src, rel, line).iter().map(|t| t.path.join("/")).collect()
        };
        let rust = [
            "#[cfg(test)]",
            "mod tests {",
            "    #[test]",
            "    fn adds(",
            "        x: u8,",
            "    ) {",
            "        let s = \"}\";",
            "        assert!(true);",
            "    }",
            "",
            "    fn helper() {}",
            "}",
        ]
        .join("\n");
        assert_eq!(names(&rust, "src/math.rs", 7), ["math/tests/adds", "math/tests"]);
        assert_eq!(names(&rust, "src/math.rs", 4), ["math/tests/adds", "math/tests"]);
        assert_eq!(names(&rust, "src/math.rs", 10), ["math/tests"]);

        let js = "describe('math', () => {\n  it('adds', () => {\n    expect(1).toBe(1);\n  });\n  it('one', fn);\n  const x = 1;\n});\n";
        assert_eq!(names(js, "src/math.test.ts", 2), ["math/adds", "math"]);
        assert_eq!(names(js, "src/math.test.ts", 5), ["math"]);

        let py = "class TestCalc:\n    def test_add(self):\n        x = 1\n\n        assert x\n    def helper(self):\n        pass\n";
        assert_eq!(names(py, "tests/test_calc.py", 4), ["TestCalc/test_add", "TestCalc"]);
        assert_eq!(names(py, "tests/test_calc.py", 6), ["TestCalc"]);

        let go = "package calc\n\nfunc TestAdd(t *testing.T) {\n\tt.Run(\"zero\", func(t *testing.T) {\n\t\tx := 0\n\t})\n\ty := 1\n}\n";
        assert_eq!(names(go, "calc_test.go", 4), ["TestAdd/zero", "TestAdd"]);
        assert_eq!(names(go, "calc_test.go", 6), ["TestAdd"]);
        assert!(names(go, "calc_test.go", 0).is_empty());
    }
}
