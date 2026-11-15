//! Zig build tools: the project's `build.zig` steps and executables and its
//! `build.zig.zon` dependencies, in a tool window. Activating a step runs
//! `zig build <step>` in a dedicated terminal; an executable opens its root
//! source file, and a dependency opens its entry in `build.zig.zon`.
//!
//! The build script is read, never run, to find the outline: `zig build`'s
//! own `--help` would execute the project's build code.

use openidea_plugin::views::{Body, Button, TreeItem, View, ViewEvent, Viewport, Views};
use openidea_plugin::{Context, Error, Event, EventKind, Invocation, Plugin, Project, host, register_plugin};
use std::collections::HashSet;

const TERMINAL_TITLE: &str = "Zig Build";

#[derive(Default)]
pub struct ZigBuild {
    /// Groups the user collapsed, by tree key: a refresh keeps them closed.
    collapsed: HashSet<String>,
}

impl Plugin for ZigBuild {
    fn activate(&mut self, _ctx: &Context) -> Result<(), Error> {
        // Only saves of a build script wake the plugin, at any depth for workspace members.
        host::subscribe_paths(
            EventKind::FileSaved.name(),
            &["build.zig", "build.zig.zon", "**/build.zig", "**/build.zig.zon"],
        )
    }

    fn handle_events(&mut self, events: &[Event], _ctx: &Invocation) {
        if events.iter().any(|event| matches!(event, Event::FileSaved(path) if is_build_file(path))) {
            host::refresh_view("build");
        }
    }

    fn run_command(&mut self, id: &str, _ctx: &Invocation, _arg: Option<&str>) -> Result<Option<String>, Error> {
        match id {
            "show" => {
                host::reveal_view("build")?;
                Ok(None)
            }
            "refresh" => {
                host::refresh_view("build");
                Ok(None)
            }
            _ => Err(Error::NotFound(format!("command {id}"))),
        }
    }
}

fn is_build_file(path: &str) -> bool {
    matches!(path.rsplit(['/', '\\']).next(), Some("build.zig" | "build.zig.zon"))
}

impl Views for ZigBuild {
    fn render(&mut self, _view: &str, _viewport: Option<Viewport>, ctx: &Invocation) -> Result<View, Error> {
        let Some((project, root)) = build_root(ctx)? else {
            return Ok(View {
                toolbar: vec![refresh_button()],
                body: Body::Message("No build.zig in this project or its workspace members.".into()),
                status: None,
            });
        };
        let build = match project.read_file(&join(&root, "build.zig")) {
            Ok(text) => text,
            Err(e) => {
                return Ok(View {
                    toolbar: vec![refresh_button()],
                    body: Body::Message(format!("Cannot read build.zig: {e}")),
                    status: None,
                });
            }
        };
        let info = parse_build(&build);
        // A missing or unreadable manifest leaves only the build outline.
        let dependencies =
            project.read_file(&join(&root, "build.zig.zon")).map(|zon| parse_dependencies(&zon)).unwrap_or_default();

        let steps: Vec<&BuildStep> =
            info.steps.iter().filter(|s| s.name != "install" && s.name != "uninstall").collect();
        let open = |key: &str| !self.collapsed.contains(key);
        let mut items = vec![TreeItem::new("build:default", "Build").icon("run").detail("zig build")];
        if !steps.is_empty() {
            items.push(
                TreeItem::new("steps", "Build steps")
                    .icon("list")
                    .detail(&steps.len().to_string())
                    .expandable(open("steps")),
            );
            for step in &steps {
                let detail = if step.description.is_empty() {
                    format!("zig build {}", step.name)
                } else {
                    step.description.clone()
                };
                items.push(
                    TreeItem::new(&format!("step:{}", step.name), &step.name)
                        .parent("steps")
                        .icon("run")
                        .detail(&detail),
                );
            }
        }
        if !info.executables.is_empty() {
            items.push(
                TreeItem::new("executables", "Executables")
                    .icon("package")
                    .detail(&info.executables.len().to_string())
                    .expandable(open("executables")),
            );
            for exe in &info.executables {
                let detail = exe.source.clone().unwrap_or_else(|| format!("zig-out/bin/{}", exe.name));
                items.push(
                    TreeItem::new(&format!("exe:{}", exe.name), &exe.name)
                        .parent("executables")
                        .icon("file")
                        .detail(&detail),
                );
            }
        }
        if !dependencies.is_empty() {
            items.push(
                TreeItem::new("dependencies", "Dependencies")
                    .icon("package")
                    .detail(&dependencies.len().to_string())
                    .expandable(open("dependencies")),
            );
            for dep in &dependencies {
                items.push(
                    TreeItem::new(&format!("dep:{}", dep.name), &dep.name)
                        .parent("dependencies")
                        .icon("package")
                        .detail(&dep.detail()),
                );
            }
        }
        let status = format!(
            "{} build steps · {} executables · {} dependencies",
            steps.len(),
            info.executables.len(),
            dependencies.len()
        );
        Ok(View { toolbar: vec![refresh_button()], body: Body::Tree(items), status: Some(status) })
    }

    fn handle(&mut self, _view: &str, event: ViewEvent, ctx: &Invocation) -> Result<(), Error> {
        match event {
            ViewEvent::Button(id) if id == "refresh" => {
                host::refresh_view("build");
                Ok(())
            }
            ViewEvent::Expand(key) => {
                self.collapsed.remove(&key);
                host::refresh_view("build");
                Ok(())
            }
            ViewEvent::Collapse(key) => {
                self.collapsed.insert(key);
                host::refresh_view("build");
                Ok(())
            }
            ViewEvent::Activate(key) => activate(&key, ctx),
            _ => Ok(()),
        }
    }
}

fn refresh_button() -> Button {
    Button::new("refresh", "Refresh").icon("refresh")
}

/// The project root holding `build.zig`: the invoking project's own, else the
/// first workspace member with a build script.
fn build_root(ctx: &Invocation) -> Result<Option<(Project, String)>, Error> {
    let mut projects = Vec::new();
    if let Some(project) = ctx.project() {
        projects.push(project);
    }
    projects.extend(host::projects()?);
    let mut seen = HashSet::new();
    for project in projects {
        let root = project.root()?;
        if !seen.insert(root.clone()) {
            continue;
        }
        if project.read_file(&join(&root, "build.zig")).is_ok() {
            return Ok(Some((project, root)));
        }
    }
    Ok(None)
}

fn activate(key: &str, ctx: &Invocation) -> Result<(), Error> {
    let Some((project, root)) = build_root(ctx)? else {
        return Err(Error::NotFound("build.zig".into()));
    };
    let build_path = join(&root, "build.zig");
    if key == "build:default" {
        return run_step(&root, None);
    }
    if let Some(step) = key.strip_prefix("step:") {
        // A stale row (the script changed since the last render) runs nothing.
        if !parse_build(&project.read_file(&build_path)?).steps.iter().any(|s| s.name == step) {
            host::refresh_view("build");
            return Ok(());
        }
        return run_step(&root, Some(step));
    }
    if let Some(name) = key.strip_prefix("exe:") {
        let info = parse_build(&project.read_file(&build_path)?);
        let Some(exe) = info.executables.iter().find(|e| e.name == name) else { return Ok(()) };
        let (path, line) = match &exe.source {
            Some(source) => (join(&root, source), 0),
            None => (build_path, exe.line),
        };
        return host::open_location(&path, line, 0);
    }
    if let Some(name) = key.strip_prefix("dep:") {
        let zon_path = join(&root, "build.zig.zon");
        let dependencies = parse_dependencies(&project.read_file(&zon_path)?);
        let Some(dep) = dependencies.iter().find(|d| d.name == name) else { return Ok(()) };
        return host::open_location(&zon_path, dep.line, 0);
    }
    Ok(())
}

/// Runs the default build, or one step, in a terminal of its own: a running step is
/// focused, and another step starts beside it instead of being ignored.
fn run_step(root: &str, step: Option<&str>) -> Result<(), Error> {
    // The terminal starts in the window's project root; `--build-file` moves the
    // build root to the member that owns the script.
    let build_file = join(root, "build.zig");
    let mut command = host::Command::new("zig").arg("build").arg("--build-file").arg(&build_file);
    if let Some(step) = step {
        command = command.arg(step);
    }
    host::open_terminal_session(&terminal_key(step), TERMINAL_TITLE, &command)?;
    Ok(())
}

/// Keys are limited to 128 bytes; a hash keeps even long step names usable.
fn terminal_key(step: Option<&str>) -> String {
    let Some(step) = step else { return "zig-build:default".into() };
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in step.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("zig-build:{hash:016x}")
}

fn join(root: &str, relative: &str) -> String {
    format!("{}/{}", root.trim_end_matches(['/', '\\']), relative.trim_start_matches(['/', '\\']).replace('\\', "/"))
}

// --- build.zig ---------------------------------------------------------------

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct BuildStep {
    pub name: String,
    pub description: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct BuildExecutable {
    pub name: String,
    /// Root source file, relative to the build script's folder.
    pub source: Option<String>,
    /// 0-based line of the `addExecutable(` call.
    pub line: u32,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct BuildInfo {
    pub steps: Vec<BuildStep>,
    pub executables: Vec<BuildExecutable>,
}

pub fn parse_build(src: &str) -> BuildInfo {
    let mask = code_mask(src);
    BuildInfo { steps: steps(&mask, src), executables: executables(&mask, src) }
}

/// `src` with comments and the contents of strings (quoted and multiline)
/// replaced by spaces: byte offsets and line numbers stay those of the original,
/// and matching against it never sees a `.step(` written in a string.
fn code_mask(src: &str) -> String {
    let bytes = src.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        if b == b'"' {
            // A quoted string: runtime and compile-time strings cannot contain braces
            // or field names that matter to the outline.
            out.push(b' ');
            i += 1;
            let mut escaped = false;
            while i < bytes.len() {
                let b = bytes[i];
                out.push(b' ');
                i += 1;
                if escaped {
                    escaped = false;
                } else if b == b'\\' {
                    escaped = true;
                } else if b == b'"' {
                    break;
                }
            }
        } else if b == b'\\' && bytes.get(i + 1) == Some(&b'\\') {
            // A multiline string line (`\\…`): the rest of this line is content.
            while i < bytes.len() && bytes[i] != b'\n' {
                out.push(b' ');
                i += 1;
            }
        } else if b == b'/' && bytes.get(i + 1) == Some(&b'/') {
            while i < bytes.len() && bytes[i] != b'\n' {
                out.push(b' ');
                i += 1;
            }
        } else {
            out.push(b);
            i += 1;
        }
    }
    String::from_utf8(out).unwrap_or_else(|_| src.to_owned())
}

/// `b.step("name", "description")` in code (not in strings or comments), in
/// source order and without duplicates.
fn steps(mask: &str, src: &str) -> Vec<BuildStep> {
    let mut out: Vec<BuildStep> = Vec::new();
    for (i, _) in mask.match_indices(".step(") {
        let mut at = skip_trivia(src, i + ".step(".len());
        let Some((name, after)) = string_at(src, at) else { continue };
        at = skip_trivia(src, after);
        let mut description = String::new();
        if src.as_bytes().get(at) == Some(&b',') {
            at = skip_trivia(src, at + 1);
            if let Some((text, _)) = string_at(src, at) {
                description = text;
            }
        }
        if name.is_empty() || out.iter().any(|s| s.name == name) {
            continue;
        }
        out.push(BuildStep { name, description });
    }
    out
}

/// `addExecutable(.{ .name = "…", … .root_source_file = <b>.path("…") … })`:
/// the name at the options' top level (an `imports` entry has its own `.name`)
/// and the executable's own root source file.
fn executables(mask: &str, src: &str) -> Vec<BuildExecutable> {
    let mut out: Vec<BuildExecutable> = Vec::new();
    for (start, _) in mask.match_indices("addExecutable(") {
        let body = &mask[start + "addExecutable(".len()..];
        let (mut depth, mut name, mut source) = (1usize, None, None);
        for (i, c) in body.char_indices() {
            match c {
                '(' | '{' | '[' => depth += 1,
                ')' | '}' | ']' => {
                    depth -= 1;
                    if depth == 0 {
                        break;
                    }
                }
                '.' => {
                    if depth == 2
                        && name.is_none()
                        && let Some(at) = field_value_start(mask, src, start + "addExecutable(".len() + i, "name")
                    {
                        name = string_at(src, at).map(|(text, _)| text);
                    }
                    // The executable's root module nests it two levels deeper
                    // (`b.createModule(.{ … })`); an `imports` entry nests further.
                    if source.is_none()
                        && matches!(depth, 2 | 4)
                        && let Some(at) =
                            field_value_start(mask, src, start + "addExecutable(".len() + i, "root_source_file")
                        && let Some(call) = src[at..].find(".path(")
                        && src[at..at + call].chars().all(|c| c.is_alphanumeric() || c == '_')
                    {
                        let quote = skip_ws(src.as_bytes(), at + call + ".path(".len());
                        source = string_at(src, quote).map(|(text, _)| text);
                    }
                }
                _ => {}
            }
        }
        if let Some(name) = name.filter(|n| !n.is_empty())
            && !out.iter().any(|e| e.name == name)
        {
            out.push(BuildExecutable { name, source, line: line_of(src, start) });
        }
    }
    out
}

/// The offset of the value after `<key> =` at the `.` at `dot`: the key is checked
/// in `mask`, while the value is located in `src` (its string is blanked in the
/// mask, so whitespace there cannot be skipped by position alone).
fn field_value_start(mask: &str, src: &str, dot: usize, key: &str) -> Option<usize> {
    let end = dot + 1 + key.len();
    if mask.get(dot + 1..end)? != key {
        return None;
    }
    let at = skip_trivia(src, end);
    if src.as_bytes().get(at) != Some(&b'=') {
        return None;
    }
    Some(skip_trivia(src, at + 1))
}

fn skip_ws(bytes: &[u8], mut i: usize) -> usize {
    while i < bytes.len() && bytes[i].is_ascii_whitespace() {
        i += 1;
    }
    i
}

/// The next code offset: whitespace and `//` comments are skipped.
fn skip_trivia(src: &str, mut i: usize) -> usize {
    let bytes = src.as_bytes();
    loop {
        i = skip_ws(bytes, i);
        if bytes.get(i) == Some(&b'/') && bytes.get(i + 1) == Some(&b'/') {
            while i < bytes.len() && bytes[i] != b'\n' {
                i += 1;
            }
            continue;
        }
        return i;
    }
}

/// The Zig string literal at `i` and the index after it. Escapes are decoded;
/// malformed ones are kept as text instead of failing or slicing mid-character.
fn string_at(src: &str, i: usize) -> Option<(String, usize)> {
    let bytes = src.as_bytes();
    if bytes.get(i) != Some(&b'"') {
        return None;
    }
    let mut value = String::new();
    let mut j = i + 1;
    while j < bytes.len() {
        match bytes[j] {
            b'"' => return Some((value, j + 1)),
            b'\\' => {
                j += 1;
                let c = src[j..].chars().next()?;
                match c {
                    'n' => {
                        value.push('\n');
                        j += 1;
                    }
                    'r' => {
                        value.push('\r');
                        j += 1;
                    }
                    't' => {
                        value.push('\t');
                        j += 1;
                    }
                    '\\' | '"' | '\'' => {
                        value.push(c);
                        j += 1;
                    }
                    'x' => match src.get(j + 1..j + 3).and_then(|hex| u8::from_str_radix(hex, 16).ok()) {
                        Some(byte) => {
                            value.push(char::from(byte));
                            j += 3;
                        }
                        None => {
                            value.push('x');
                            j += 1;
                        }
                    },
                    'u' if bytes.get(j + 1) == Some(&b'{') => {
                        let rest = src.get(j + 2..)?;
                        let Some(end) = rest.find('}') else {
                            value.push('u');
                            j += 1;
                            continue;
                        };
                        if let Some(ch) = u32::from_str_radix(&rest[..end], 16).ok().and_then(char::from_u32) {
                            value.push(ch);
                        }
                        j += 2 + end + 1;
                    }
                    other => {
                        value.push(other);
                        j += other.len_utf8();
                    }
                }
            }
            _ => {
                let c = src[j..].chars().next()?;
                value.push(c);
                j += c.len_utf8();
            }
        }
    }
    None
}

fn line_of(src: &str, index: usize) -> u32 {
    src.as_bytes()[..index.min(src.len())].iter().filter(|b| **b == b'\n').count() as u32
}

// --- build.zig.zon -----------------------------------------------------------

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Dependency {
    pub name: String,
    pub url: Option<String>,
    pub hash: Option<String>,
    pub path: Option<String>,
    /// 0-based line of the dependency's entry.
    pub line: u32,
}

impl Dependency {
    fn detail(&self) -> String {
        if let Some(url) = &self.url {
            return url.clone();
        }
        if let Some(path) = &self.path {
            return path.clone();
        }
        match &self.hash {
            // The hash is long; its prefix tells versions apart.
            Some(hash) => hash.chars().take(16).collect(),
            None => "build.zig.zon".into(),
        }
    }
}

/// `.dependencies = .{ … }`: each entry's name and its `url` / `hash` / `path`,
/// with the line its entry starts on.
pub fn parse_dependencies(src: &str) -> Vec<Dependency> {
    let mask = code_mask(src);
    let bytes = mask.as_bytes();
    let Some(start) = mask.find(".dependencies") else { return Vec::new() };
    let mut at = skip_ws(bytes, start + ".dependencies".len());
    if bytes.get(at) != Some(&b'=') {
        return Vec::new();
    }
    at = skip_ws(bytes, at + 1);
    if bytes.get(at) != Some(&b'.') {
        return Vec::new();
    }
    at = skip_ws(bytes, at + 1);
    if bytes.get(at) != Some(&b'{') {
        return Vec::new();
    }
    let (start, end) = braces(&mask, at);
    let mut out: Vec<Dependency> = Vec::new();
    let mut i = start;
    while i < end {
        i = skip_ws(bytes, i);
        match bytes.get(i) {
            None => break,
            Some(&b',') => {
                i += 1;
                continue;
            }
            Some(&b'.') => {}
            Some(_) => {
                i += 1;
                continue;
            }
        }
        let mut j = i + 1;
        let name = if bytes.get(j) == Some(&b'@') {
            // The quoted name is blanked in the mask; parse it from the source.
            let Some((name, after)) = string_at(src, j + 1) else {
                i += 1;
                continue;
            };
            j = after;
            name
        } else {
            let (name, after) = ident_at(&mask, j);
            if name.is_empty() {
                i += 1;
                continue;
            }
            j = after;
            name.to_owned()
        };
        j = skip_ws(bytes, j);
        if bytes.get(j) != Some(&b'=') {
            i += 1;
            continue;
        }
        j = skip_ws(bytes, j + 1);
        if bytes.get(j) != Some(&b'.') {
            i += 1;
            continue;
        }
        j = skip_ws(bytes, j + 1);
        if bytes.get(j) != Some(&b'{') {
            i += 1;
            continue;
        }
        let (fields, after) = braces(&mask, j);
        let mut dep = Dependency { name, line: line_of(src, i), ..Default::default() };
        dependency_fields(&mask, src, fields, after, &mut dep);
        if !dep.name.is_empty() && !out.iter().any(|d| d.name == dep.name) {
            out.push(dep);
        }
        i = after + 1;
    }
    out
}

/// The content range of the `{ … }` block opening at `open`, and the index of
/// its closing brace (the end of `mask` when it is unterminated). Strings and
/// comments are already blanked in `mask`.
fn braces(mask: &str, open: usize) -> (usize, usize) {
    let bytes = mask.as_bytes();
    let mut depth = 1usize;
    let mut i = open + 1;
    while i < bytes.len() {
        match bytes[i] {
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return (open + 1, i);
                }
            }
            _ => {}
        }
        i += 1;
    }
    (open + 1, bytes.len())
}

fn dependency_fields(mask: &str, src: &str, start: usize, end: usize, dep: &mut Dependency) {
    let bytes = mask.as_bytes();
    let mut depth = 0usize;
    let mut i = start;
    while i < end {
        match bytes[i] {
            b'{' | b'(' | b'[' => {
                depth += 1;
                i += 1;
            }
            b'}' | b')' | b']' => {
                depth = depth.saturating_sub(1);
                i += 1;
            }
            b'.' if depth == 0 => {
                let (field, after) = ident_at(mask, i + 1);
                if !field.is_empty()
                    && let Some(at) = field_value_start(mask, src, i, field)
                    && let Some((value, _)) = string_at(src, at)
                {
                    match field {
                        "url" => dep.url = Some(value),
                        "hash" => dep.hash = Some(value),
                        "path" => dep.path = Some(value),
                        _ => {}
                    }
                }
                i = after.max(i + 1);
            }
            _ => i += 1,
        }
    }
}

fn ident_at(src: &str, i: usize) -> (&str, usize) {
    let bytes = src.as_bytes();
    let mut j = i;
    while j < bytes.len() && (bytes[j].is_ascii_alphanumeric() || bytes[j] == b'_') {
        j += 1;
    }
    (&src[i..j], j)
}

register_plugin!(ZigBuild, views);

#[cfg(test)]
mod tests {
    use super::*;
    use openidea_plugin::mock::MockHost;

    const BUILD: &str = r#"
const std = @import("std");
pub fn build(b: *std.Build) void {
    const run_step = b.step("run", "Run the app");
    const test_step = b.step("test", "Run the tests");
    const again = b.step("run", "Duplicate");
    _ = .{ run_step, test_step, again };
}
"#;

    #[test]
    fn steps_keep_their_descriptions_and_drop_duplicates() {
        let info = parse_build(BUILD);
        assert_eq!(
            info.steps,
            [
                BuildStep { name: "run".into(), description: "Run the app".into() },
                BuildStep { name: "test".into(), description: "Run the tests".into() },
            ]
        );
    }

    #[test]
    fn comments_do_not_produce_steps() {
        let info = parse_build("// b.step(\"fake\", \"not a step\")\n");
        assert!(info.steps.is_empty());
    }

    #[test]
    fn executables_carry_their_root_source() {
        let src = r#"
    const exe = b.addExecutable(.{
        .name = "app",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/main.zig"),
            .imports = &.{.{ .name = "tally", .module = tally }},
        }),
    });
"#;
        let info = parse_build(src);
        assert_eq!(
            info.executables,
            [BuildExecutable { name: "app".into(), source: Some("src/main.zig".into()), line: 1 }]
        );
    }

    #[test]
    fn dependencies_record_their_fields_and_line() {
        let zon = r#".{
    .name = .app,
    .dependencies = .{
        .foo = .{
            .url = "https://example.com/foo.tar.gz",
            .hash = "foo-0.1.0-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        },
        .@"bar-baz" = .{
            .path = "vendor/bar",
        },
        // .gone = .{ .url = "https://example.com/gone.tar.gz" },
    },
}
"#;
        let deps = parse_dependencies(zon);
        assert_eq!(deps.len(), 2);
        assert_eq!(deps[0].name, "foo");
        assert_eq!(deps[0].url.as_deref(), Some("https://example.com/foo.tar.gz"));
        assert_eq!(deps[0].line, 3);
        assert_eq!(deps[1].name, "bar-baz");
        assert_eq!(deps[1].path.as_deref(), Some("vendor/bar"));
    }

    #[test]
    fn view_lists_the_build_and_opens_a_dependency() {
        let mock = MockHost::install();
        mock.set_project_root(Some("/project"));
        mock.add_file("build.zig", BUILD);
        mock.add_file(
            "build.zig.zon",
            ".{\n    .dependencies = .{\n        .foo = .{ .path = \"vendor/foo\" },\n    },\n}\n",
        );
        let mut plugin = ZigBuild::default();
        let view = plugin.render("build", None, &mock.invocation()).unwrap();
        let Body::Tree(items) = view.body else { panic!("expected a tree") };
        let labels: Vec<&str> = items.iter().map(|i| i.label.as_str()).collect();
        assert_eq!(labels, ["Build", "Build steps", "run", "test", "Dependencies", "foo"]);
        assert!(view.status.unwrap().contains("2 build steps"));

        plugin.handle("build", ViewEvent::Activate("dep:foo".into()), &mock.invocation()).unwrap();
        assert_eq!(mock.opened_locations(), [("/project/build.zig.zon".to_string(), 2, 0)]);
    }

    #[test]
    fn activating_a_step_runs_it_in_its_own_terminal() {
        let mock = MockHost::install().with_capabilities(&["project.read", "process:zig"]);
        mock.set_project_root(Some("/project"));
        mock.add_file("build.zig", BUILD);
        let mut plugin = ZigBuild::default();
        plugin.handle("build", ViewEvent::Activate("step:test".into()), &mock.invocation()).unwrap();
        let key = terminal_key(Some("test"));
        assert!(mock.finish_terminal(&key).is_some(), "no terminal session was opened for {key}");
        // Another step does not land in the first one's terminal.
        assert_ne!(terminal_key(Some("run")), key);
        assert_eq!(terminal_key(None), "zig-build:default");
    }

    #[test]
    fn a_collapsed_group_stays_collapsed() {
        let mock = MockHost::install();
        mock.set_project_root(Some("/project"));
        mock.add_file("build.zig", BUILD);
        let mut plugin = ZigBuild::default();
        plugin.handle("build", ViewEvent::Collapse("steps".into()), &mock.invocation()).unwrap();
        let view = plugin.render("build", None, &mock.invocation()).unwrap();
        let Body::Tree(items) = view.body else { panic!("expected a tree") };
        let steps = items.iter().find(|i| i.key == "steps").unwrap();
        assert!(steps.expandable && !steps.expanded);
        plugin.handle("build", ViewEvent::Expand("steps".into()), &mock.invocation()).unwrap();
        let view = plugin.render("build", None, &mock.invocation()).unwrap();
        let Body::Tree(items) = view.body else { panic!("expected a tree") };
        assert!(items.iter().find(|i| i.key == "steps").unwrap().expanded);
    }

    #[test]
    fn multiline_strings_and_string_literals_do_not_produce_rows() {
        let src = r#"
const text =
    \\ b.step("fake", "not a step")
    \\ b.addExecutable(.{ .name = "fake" });
;
const real = b.step("run", "Run");
"#;
        let info = parse_build(src);
        assert_eq!(info.steps, [BuildStep { name: "run".into(), description: "Run".into() }]);
        assert!(info.executables.is_empty(), "{:?}", info.executables);
    }

    #[test]
    fn escaped_and_unicode_step_names_are_decoded_without_panicking() {
        let info = parse_build(r#"b.step("a\x41\u{1F600}\é", "desc");"#);
        assert_eq!(info.steps[0].name, "aA😀é");
        // An escape at the very end leaves the string unterminated: no panic, no step.
        assert!(parse_build(r#"b.step("abc\"#).steps.is_empty());
    }

    #[test]
    fn a_method_chain_on_the_next_line_is_still_a_step() {
        let info = parse_build("const s = b\n    .step(\"run\", \"Run\");\n");
        assert_eq!(info.steps[0].name, "run");
    }

    #[test]
    fn an_imports_root_source_is_not_the_executables_root_source() {
        let src = r#"
const exe = b.addExecutable(.{
    .name = "app",
    .imports = &.{ .{ .name = "dep", .module = b.createModule(.{
        .root_source_file = b.path("dep.zig"),
    }) } },
    .root_module = b.createModule(.{
        .root_source_file = b.path("main.zig"),
    }),
});
"#;
        let info = parse_build(src);
        assert_eq!(info.executables.len(), 1);
        assert_eq!(info.executables[0].source.as_deref(), Some("main.zig"));
    }

    #[test]
    fn dependency_braces_inside_strings_do_not_end_the_block() {
        let zon = r#".{
    .dependencies = .{
        .a = .{ .url = "https://example.com/a{b}", .hash = "h" },
    },
    .paths = .{ "a{", "b}" },
}
"#;
        let deps = parse_dependencies(zon);
        assert_eq!(deps.len(), 1);
        assert_eq!(deps[0].url.as_deref(), Some("https://example.com/a{b}"));
        assert_eq!(
            parse_dependencies(".{ .dependencies = .{ .a = .{ .path = \"x\" }, .a = .{ .path = \"y\" } } }").len(),
            1
        );
    }

    #[test]
    fn only_build_scripts_trigger_the_refresh() {
        assert!(is_build_file("/project/build.zig"));
        assert!(is_build_file("C:\\project\\build.zig.zon"));
        assert!(!is_build_file("/project/src/build.zig.txt"));
        assert!(!is_build_file("/project/build.zig.zon.bak"));
    }

    #[test]
    fn no_build_script_says_so() {
        let mock = MockHost::install();
        mock.set_project_root(Some("/project"));
        let view = ZigBuild::default().render("build", None, &mock.invocation()).unwrap();
        assert!(matches!(view.body, Body::Message(text) if text.contains("build.zig")));
    }
}
