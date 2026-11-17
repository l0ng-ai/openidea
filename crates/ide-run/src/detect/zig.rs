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
    let roots = test_roots(&src);
    for step in steps(&src) {
        // `install` is what plain `zig build` runs.
        if step == "install" || step == "uninstall" {
            continue;
        }
        let mut c = config(format!("zig:{step}"), format!("zig build {step}"), "zig", "zig", &["build", &step]);
        if step == "test" || step.starts_with("test-") || step.starts_with("test_") {
            c = c.test();
            if let Some((_, root)) = roots.iter().find(|(name, _)| *name == step) {
                c.extras.params.insert("testRoot".into(), root.clone());
            }
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

/// The call's argument text: from just after its `(` to the matching `)`.
fn call_body(src: &str, start: usize) -> &str {
    let (mut depth, mut in_string, mut escaped) = (1usize, false, false);
    for (i, c) in src[start..].char_indices() {
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
                    return &src[start..start + i];
                }
            }
            _ => {}
        }
    }
    src
}

/// The first `.root_source_file = <receiver>.path("…")` in `body`.
fn root_source_file(body: &str) -> Option<String> {
    for (i, _) in body.match_indices(".root_source_file") {
        let Some(v) = body[i + ".root_source_file".len()..].trim_start().strip_prefix('=') else { continue };
        let v = v.trim_start();
        if let Some(call) = v.find(".path(")
            && v[..call].chars().all(|c| c.is_alphanumeric() || c == '_')
        {
            return string_at(&v[call + ".path(".len()..]);
        }
    }
    None
}

/// The identifier assigned just before `at`: `const mod = b.addModule(…` → `mod`.
fn assigned_var(src: &str, at: usize) -> Option<&str> {
    let before = src[..at].trim_end();
    let before = before.strip_suffix('.')?.trim_end();
    // Drop the receiver (`b`) that sits between the `=` and the call.
    let receiver =
        before.char_indices().rev().take_while(|(_, c)| c.is_alphanumeric() || *c == '_').last().map(|(i, _)| i)?;
    let before = before[..receiver].trim_end();
    let before = before.strip_suffix('=')?.trim_end();
    let start =
        before.char_indices().rev().take_while(|(_, c)| c.is_alphanumeric() || *c == '_').last().map(|(i, _)| i)?;
    Some(&before[start..])
}

/// The test root behind each test-named step (`zig build <step>`): the step's `dependOn` runs
/// an `addTest` artifact — a variable (`const tests = b.addTest(…)`) or an inline call — whose
/// module's `root_source_file` this resolves (through `addModule`/`createModule` variables).
/// `zig build` forwards no args to the test binary, so rerunning a single failed test goes
/// through a standalone `zig test <root> --test-filter …` on the step's own test module.
fn test_roots(src: &str) -> Vec<(String, String)> {
    let mut modules: Vec<(String, String)> = Vec::new();
    for key in ["addModule(", "createModule("] {
        for (i, _) in src.match_indices(key) {
            let Some(root) = root_source_file(call_body(src, i + key.len())) else { continue };
            if let Some(var) = assigned_var(src, i)
                && !modules.iter().any(|(m, _)| *m == var)
            {
                modules.push((var.to_owned(), root));
            }
        }
    }
    let module_root = |body: &str| -> Option<String> {
        root_source_file(body).or_else(|| {
            let at = body.find(".root_module")?;
            let v = body[at + ".root_module".len()..].trim_start().strip_prefix('=')?.trim_start();
            let var: String = v.chars().take_while(|c| c.is_alphanumeric() || *c == '_').collect();
            modules.iter().find(|(m, _)| *m == var).map(|(_, root)| root.clone())
        })
    };
    let mut tests: Vec<(String, String)> = Vec::new();
    for (i, _) in src.match_indices("addTest(") {
        let Some(root) = module_root(call_body(src, i + "addTest(".len())) else { continue };
        if let Some(var) = assigned_var(src, i)
            && !tests.iter().any(|(v, _)| *v == var)
        {
            tests.push((var.to_owned(), root));
        }
    }
    let mut steps: Vec<(String, String)> = Vec::new();
    for (i, _) in src.match_indices(".step(\"") {
        let Some(name) = string_at(&src[i + ".step(".len()..]) else { continue };
        // The match includes the dot, so the assignment ends one character earlier.
        if let Some(var) = assigned_var(src, i + 1) {
            steps.push((var.to_owned(), name));
        }
    }
    let mut out: Vec<(String, String)> = Vec::new();
    for (i, _) in src.match_indices(".dependOn(&") {
        let Some(step) = receiver_var(src, i + 1) else { continue };
        let Some((_, name)) = steps.iter().find(|(v, _)| v == step) else { continue };
        let after = &src[i + ".dependOn(&".len()..];
        let artifact = if let Some(at) = after.find("addRunArtifact(") {
            let v = &after[at + "addRunArtifact(".len()..];
            let var: String = v.chars().take_while(|c| c.is_alphanumeric() || *c == '_').collect();
            tests.iter().find(|(v, _)| *v == var).map(|(_, root)| root.clone())
        } else if let Some(at) = after.find("addTest(") {
            module_root(call_body(after, at + "addTest(".len()))
        } else {
            None
        };
        if let Some(root) = artifact
            && name.starts_with("test")
            && !out.iter().any(|(n, _)| n == name)
        {
            out.push((name.clone(), root));
        }
    }
    out
}

/// The identifier a method is called on just before `at`: `test_step.dependOn(…` → `test_step`.
fn receiver_var(src: &str, at: usize) -> Option<&str> {
    let before = src[..at].trim_end();
    let before = before.strip_suffix('.')?;
    let start =
        before.char_indices().rev().take_while(|(_, c)| c.is_alphanumeric() || *c == '_').last().map(|(i, _)| i)?;
    Some(&before[start..])
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
    const tests = b.addTest(.{ .root_module = mod });
    const test_step = b.step("test", "Run tests");
    test_step.dependOn(&b.addRunArtifact(tests).step);
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
        assert_eq!(test.extras.params.get("testRoot").map(String::as_str), Some("src/root.zig"));
    }

    const TEST_ROOTS: &str = r#"const std = @import("std");

pub fn build(b: *std.Build) void {
    const tally = b.addModule("tally", .{ .root_source_file = b.path("src/tally.zig") });
    const unit = b.addTest(.{ .root_module = tally });
    const test_step = b.step("test", "Run the unit tests");
    test_step.dependOn(&b.addRunArtifact(unit).step);
    const failing = b.addTest(.{ .root_module = b.createModule(.{
        .root_source_file = b.path("src/failing.zig"),
    }) });
    const test_failing_step = b.step("test-failing", "Run the failing tests");
    test_failing_step.dependOn(&b.addRunArtifact(failing).step);
    const direct = b.addTest(.{ .root_source_file = b.path("src/direct.zig") });
    const test_direct_step = b.step("test-direct", "Run the direct tests");
    test_direct_step.dependOn(&b.addRunArtifact(direct).step);
    const run_step = b.step("run", "Run the app");
    run_step.dependOn(&b.addRunArtifact(unit).step);
}
"#;

    #[test]
    fn test_roots_come_from_the_step_s_own_artifact() {
        let src = code_only(TEST_ROOTS);
        assert_eq!(
            test_roots(&src),
            [
                ("test".to_owned(), "src/tally.zig".to_owned()),
                ("test-failing".to_owned(), "src/failing.zig".to_owned()),
                ("test-direct".to_owned(), "src/direct.zig".to_owned()),
            ]
        );
    }
}
