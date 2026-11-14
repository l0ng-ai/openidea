//! Zig projects (`build.zig`): the build's steps (`zig build <step>`) and, for each executable it
//! declares, the installed binary (`zig-out/bin/<name>`), built first and debuggable with CodeLLDB.
//! Read from the build script's source: detecting configurations never runs the project's build code.

use super::{ConfigExt, config, read};
use crate::{BeforeLaunchTask, RunConfig};
use std::path::Path;

pub(super) const BUILD_ID: &str = "zig:build";

pub(super) fn detect(dir: &Path, out: &mut Vec<RunConfig>) {
    let Some(src) = read(&dir.join("build.zig")) else { return };
    let src = code_only(&src);
    out.push(config(BUILD_ID, "zig build", "zig", "zig", &["build"]));
    for step in steps(&src) {
        // `install` is what plain `zig build` runs.
        if step == "install" || step == "uninstall" {
            continue;
        }
        let mut c = config(format!("zig:{step}"), format!("zig build {step}"), "zig", "zig", &["build", &step]);
        if step == "test" || step.starts_with("test-") || step.starts_with("test_") {
            c = c.test();
        }
        out.push(c);
    }
    for exe in executables(&src) {
        let binary = if cfg!(windows) {
            format!("zig-out\\bin\\{}.exe", exe.name)
        } else {
            format!("./zig-out/bin/{}", exe.name)
        };
        let mut c = config(format!("zig:exe:{}", exe.name), exe.name.clone(), "zig-application", &binary, &[])
            .debug("codelldb");
        c.extras.before_launch.push(BeforeLaunchTask { kind: "run".into(), target: BUILD_ID.into() });
        if let Some(source) = exe.source {
            c.extras.params.insert("source".into(), source);
        }
        out.push(c);
    }
}

/// `src` with comments blanked out (Zig has only `//` comments) and string contents kept.
fn code_only(src: &str) -> String {
    let mut out = String::with_capacity(src.len());
    for line in src.lines() {
        let mut in_string = false;
        let mut escaped = false;
        let mut end = line.len();
        let bytes = line.as_bytes();
        for (i, &b) in bytes.iter().enumerate() {
            if in_string {
                match b {
                    _ if escaped => escaped = false,
                    b'\\' => escaped = true,
                    b'"' => in_string = false,
                    _ => {}
                }
            } else if b == b'"' {
                in_string = true;
            } else if b == b'/' && bytes.get(i + 1) == Some(&b'/') {
                end = i;
                break;
            }
        }
        out.push_str(&line[..end]);
        out.push('\n');
    }
    out
}

/// The string literal starting at `s` (after optional whitespace), unescaped only for `\"`.
fn string_at(s: &str) -> Option<String> {
    let rest = s.trim_start().strip_prefix('"')?;
    let mut value = String::new();
    let mut chars = rest.chars();
    while let Some(c) = chars.next() {
        match c {
            '"' => return Some(value),
            '\\' => value.push(chars.next()?),
            c => value.push(c),
        }
    }
    None
}

/// Step names from `<build>.step("name", "description")`, in order and without duplicates.
fn steps(src: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for (i, _) in src.match_indices(".step(") {
        let preceded = src[..i].chars().next_back().is_some_and(|c| c.is_alphanumeric() || c == '_');
        if let Some(name) = string_at(&src[i + ".step(".len()..])
            && preceded
            && !name.is_empty()
            && !out.contains(&name)
        {
            out.push(name);
        }
    }
    out
}

struct Executable {
    name: String,
    /// Root source file, relative to the build script's folder.
    source: Option<String>,
}

/// `addExecutable(.{ .name = "…", … .root_source_file = <b>.path("…") … })`: the name at the
/// options' top level (an `imports` entry has its own `.name`) and the first root source file.
fn executables(src: &str) -> Vec<Executable> {
    let mut out: Vec<Executable> = Vec::new();
    for (start, _) in src.match_indices("addExecutable(") {
        let body = &src[start + "addExecutable(".len()..];
        let (mut depth, mut in_string, mut escaped) = (1usize, false, false);
        let mut name = None;
        let mut source = None;
        for (i, c) in body.char_indices() {
            if in_string {
                match c {
                    _ if escaped => escaped = false,
                    '\\' => escaped = true,
                    '"' => in_string = false,
                    _ => {}
                }
                continue;
            }
            match c {
                '"' => in_string = true,
                '(' | '{' | '[' => depth += 1,
                ')' | '}' | ']' => {
                    depth -= 1;
                    if depth == 0 {
                        break;
                    }
                }
                '.' => {
                    let field = &body[i + 1..];
                    let value =
                        |key: &str| field.strip_prefix(key)?.trim_start().strip_prefix('=').map(str::trim_start);
                    if depth == 2 && name.is_none() {
                        name = value("name").and_then(string_at);
                    }
                    if source.is_none()
                        && let Some(v) = value("root_source_file")
                        && let Some(call) = v.find(".path(")
                        && v[..call].chars().all(|c| c.is_alphanumeric() || c == '_')
                    {
                        source = string_at(&v[call + ".path(".len()..]);
                    }
                }
                _ => {}
            }
        }
        if let Some(name) = name
            && !name.is_empty()
            && !out.iter().any(|e| e.name == name)
        {
            out.push(Executable { name, source });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const INIT: &str = r#"const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const mod = b.addModule("app", .{
        .root_source_file = b.path("src/root.zig"),
        .target = target,
    });
    // const old = b.addExecutable(.{ .name = "commented-out" });
    const exe = b.addExecutable(.{
        .name = "app",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/main.zig"),
            .target = target,
            .imports = &.{
                .{ .name = "app", .module = mod },
            },
        }),
    });
    b.installArtifact(exe);
    const tool = b.addExecutable(.{ .name = "gen-docs", .root_module = b.createModule(.{
        .root_source_file = b.path("tools/gen_docs.zig"),
    }) });
    _ = tool;
    const run_step = b.step("run", "Run the app");
    const test_step = b.step("test", "Run tests");
    const docs = b.step("docs", "Generate docs // not a comment");
    _ = .{ run_step, test_step, docs };
}
"#;

    #[test]
    fn steps_and_executables_come_from_the_build_script() {
        let src = code_only(INIT);
        assert_eq!(steps(&src), ["run", "test", "docs"]);
        let exes = executables(&src);
        assert_eq!(
            exes.iter().map(|e| (e.name.as_str(), e.source.as_deref())).collect::<Vec<_>>(),
            [("app", Some("src/main.zig")), ("gen-docs", Some("tools/gen_docs.zig"))]
        );
    }

    #[test]
    fn a_zig_project_gets_build_steps_and_debuggable_executables() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("build.zig"), INIT).unwrap();
        let mut out = Vec::new();
        detect(dir.path(), &mut out);
        let ids: Vec<_> = out.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(ids, ["zig:build", "zig:run", "zig:test", "zig:docs", "zig:exe:app", "zig:exe:gen-docs"]);
        let test = out.iter().find(|c| c.id == "zig:test").unwrap();
        assert!(test.is_test);
        assert_eq!(
            (test.command.as_str(), test.args.as_slice()),
            ("zig", ["build".to_owned(), "test".to_owned()].as_slice())
        );
        let app = out.iter().find(|c| c.id == "zig:exe:app").unwrap();
        assert_eq!(app.kind, "zig-application");
        assert!(app.command.ends_with(if cfg!(windows) { "app.exe" } else { "zig-out/bin/app" }));
        assert_eq!(app.debug_adapter.as_deref(), Some("codelldb"));
        assert_eq!(app.extras.before_launch[0].kind, "run");
        assert_eq!(app.extras.before_launch[0].target, BUILD_ID);
        assert_eq!(app.extras.params.get("source").map(String::as_str), Some("src/main.zig"));
    }
}
