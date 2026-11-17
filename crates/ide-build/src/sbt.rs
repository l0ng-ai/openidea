//! sbt builds for the sbt tool window: each `build.sbt` build under the project root
//! with the projects its definition declares (`lazy val core = project`,
//! `(project in file("core"))`, `Project("core", file("core"))`), read statically —
//! sbt itself is not started.

use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::Path;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SbtBuild {
    /// Folder of `build.sbt`, relative to the project root (`""` for the root itself).
    pub dir: String,
    /// The launcher: a `sbt` / `sbtx` script in the build folder, else `sbt` on `PATH`.
    pub command: String,
    /// `sbt.version` of `project/build.properties`.
    pub version: Option<String>,
    /// The root project first, then the declared projects in source order.
    pub projects: Vec<SbtProject>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SbtProject {
    /// The project id tasks are scoped with (`core/compile`).
    pub id: String,
    /// Base folder relative to the build folder (`""` for the build's own).
    pub dir: String,
    /// The build's root project: its tasks run unscoped (and aggregate when sbt does).
    pub root: bool,
}

/// The sbt builds under `root` (outermost `build.sbt` folders).
pub fn load(root: &Path) -> Vec<SbtBuild> {
    ide_core::project_roots::discover(root, &["build.sbt"])
        .into_iter()
        .filter_map(|dir| {
            let text = std::fs::read_to_string(dir.join("build.sbt")).ok()?;
            let rel = dir.strip_prefix(root).unwrap_or(&dir).to_string_lossy().replace('\\', "/");
            let name = dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "root".to_owned());
            Some(SbtBuild {
                dir: rel,
                command: launcher(&dir),
                version: build_version(&dir),
                projects: projects(&text, &name),
            })
        })
        .collect()
}

fn launcher(dir: &Path) -> String {
    for script in ["sbt", "sbtx"] {
        if !cfg!(windows) && dir.join(script).is_file() {
            return format!("./{script}");
        }
    }
    if cfg!(windows) && dir.join("sbt.bat").is_file() {
        return "sbt.bat".to_owned();
    }
    "sbt".to_owned()
}

fn build_version(dir: &Path) -> Option<String> {
    let text = std::fs::read_to_string(dir.join("project/build.properties")).ok()?;
    text.lines().find_map(|line| {
        let (key, value) = line.split_once('=')?;
        (key.trim() == "sbt.version").then(|| value.trim().to_owned())
    })
}

/// `text` with comments and the contents of string literals blanked (quotes kept),
/// byte for byte, so offsets into it are offsets into `text`.
fn mask(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let blank = |out: &mut String, c: char| {
        if c == '\n' {
            out.push('\n');
        } else {
            out.extend(std::iter::repeat_n(' ', c.len_utf8()));
        }
    };
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '"' => {
                out.push('"');
                let mut ahead = chars.clone();
                if ahead.next() == Some('"') && ahead.next() == Some('"') {
                    // `"""…"""`: no escapes inside.
                    chars.next();
                    chars.next();
                    out.push_str("\"\"");
                    let mut quotes = 0;
                    for c in chars.by_ref() {
                        quotes = if c == '"' { quotes + 1 } else { 0 };
                        if quotes > 0 {
                            out.push('"')
                        } else {
                            blank(&mut out, c)
                        }
                        if quotes == 3 {
                            break;
                        }
                    }
                    continue;
                }
                while let Some(c) = chars.next() {
                    if c == '"' || c == '\n' {
                        out.push(c);
                        break;
                    }
                    blank(&mut out, c);
                    if c == '\\'
                        && let Some(n) = chars.next()
                    {
                        blank(&mut out, n);
                    }
                }
            }
            '/' if chars.peek() == Some(&'/') => {
                blank(&mut out, c);
                for c in chars.by_ref() {
                    blank(&mut out, c);
                    if c == '\n' {
                        break;
                    }
                }
            }
            '/' if chars.peek() == Some(&'*') => {
                blank(&mut out, c);
                let mut prev = ' ';
                for c in chars.by_ref() {
                    blank(&mut out, c);
                    if prev == '*' && c == '/' {
                        break;
                    }
                    prev = c;
                }
            }
            _ => out.push(c),
        }
    }
    out
}

fn identifier(s: &str) -> Option<(&str, &str)> {
    let s = s.trim_start();
    if let Some(rest) = s.strip_prefix('`') {
        let end = rest.find('`')?;
        return Some((&rest[..end], &rest[end + 1..]));
    }
    let end = s.find(|c: char| !(c.is_alphanumeric() || c == '_')).unwrap_or(s.len());
    (end > 0).then(|| (&s[..end], &s[end..]))
}

/// The string literal at the start of `s` (after spaces), and the rest.
fn string_literal(s: &str) -> Option<(&str, &str)> {
    let rest = s.trim_start().strip_prefix('"')?;
    let end = rest.find('"')?;
    Some((&rest[..end], &rest[end + 1..]))
}

/// The folder of a `file("x")` / `new File("x")` at the start of `s`.
fn file_arg(s: &str) -> Option<&str> {
    let s = s.trim_start();
    let s = s.strip_prefix("file").or_else(|| s.strip_prefix("new File"))?;
    let s = s.trim_start().strip_prefix('(')?;
    string_literal(s).map(|(dir, _)| dir)
}

fn normalize_dir(dir: &str) -> String {
    let dir = dir.trim_start_matches("./").trim_end_matches('/');
    if dir == "." { String::new() } else { dir.to_owned() }
}

/// What a `lazy val <id> = <rhs>` declares: a project and its base folder. `rhs` is
/// masked (see [`mask`]); `original` is the same text unmasked, for the folder names.
fn project_of(id: &str, rhs: &str, original: &str) -> Option<String> {
    let at = |s: &str| original.get(rhs.len() - s.len()..).unwrap_or_default();
    let rhs = rhs.trim_start().trim_start_matches('(').trim_start();
    if let Some(rest) = rhs.strip_prefix("Project") {
        // `Project("id", file("dir"))` / `Project(id = "x", base = file("dir"))`.
        let args = rest.trim_start().strip_prefix('(')?;
        let base = args.find("file(").or_else(|| args.find("new File("))?;
        return file_arg(at(&args[base..])).map(normalize_dir);
    }
    let rest = rhs.strip_prefix("project")?;
    if rest.starts_with(|c: char| c.is_alphanumeric() || c == '_') {
        return None;
    }
    let rest = rest.trim_start();
    let located = rest
        .strip_prefix(".in")
        .and_then(|r| r.trim_start().strip_prefix('('))
        .or_else(|| rest.strip_prefix("in ").or_else(|| rest.strip_prefix("in\t")));
    Some(match located.and_then(|l| file_arg(at(l))) {
        Some(dir) => normalize_dir(dir),
        None => id.to_owned(),
    })
}

/// The projects a build definition declares; `name` is the build folder's name, the id
/// sbt gives an implicit root project.
pub fn projects(text: &str, name: &str) -> Vec<SbtProject> {
    let masked = mask(text);
    let mut out: Vec<SbtProject> = Vec::new();
    let mut from = 0;
    while let Some(found) = masked[from..].find("val ") {
        let at = from + found;
        from = at + 4;
        if masked[..at].chars().last().is_some_and(|c| c.is_alphanumeric() || c == '_') {
            continue;
        }
        let Some((id, tail)) = identifier(&masked[from..]) else { continue };
        let Some(rhs) = tail.trim_start().strip_prefix('=') else { continue };
        if rhs.starts_with('=') || rhs.starts_with('>') {
            continue;
        }
        let Some(dir) = project_of(id, rhs, &text[masked.len() - rhs.len()..]) else { continue };
        if !out.iter().any(|p| p.id == id) {
            out.push(SbtProject { id: id.to_owned(), root: dir.is_empty(), dir });
        }
    }
    match out.iter().position(|p| p.root) {
        Some(i) => {
            let root = out.remove(i);
            out.insert(0, root);
        }
        None => out.insert(0, SbtProject { id: name.to_owned(), dir: String::new(), root: true }),
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(text: &str) -> Vec<(String, String, bool)> {
        projects(text, "shop").into_iter().map(|p| (p.id, p.dir, p.root)).collect()
    }

    #[test]
    fn single_project_builds_have_an_implicit_root() {
        assert_eq!(
            ids("ThisBuild / scalaVersion := \"3.3.4\"\nname := \"shop\"\n"),
            [("shop".into(), "".into(), true)]
        );
    }

    #[test]
    fn declared_projects_and_their_folders() {
        let text = r#"
// lazy val commented = project
lazy val root = (project in file("."))
  .aggregate(core, `web-app`, util)
  .settings(name := "shop")

lazy val core = project
lazy val `web-app` = (project in file("modules/web")).dependsOn(core)
lazy val util = project.in(file("libs/util/"))
lazy val legacy = Project("legacy", file("old"))
/* lazy val hidden = project */
val description = "lazy val fake = project"
lazy val projectSettings = Seq(scalacOptions += "-deprecation")
"#;
        assert_eq!(
            ids(text),
            [
                ("root".into(), "".into(), true),
                ("core".into(), "core".into(), false),
                ("web-app".into(), "modules/web".into(), false),
                ("util".into(), "libs/util".into(), false),
                ("legacy".into(), "old".into(), false),
            ]
        );
    }

    #[test]
    fn a_root_declared_last_is_listed_first() {
        let text = "lazy val api = project\nlazy val all = (project in file(\".\")).aggregate(api)\n";
        assert_eq!(ids(text), [("all".into(), "".into(), true), ("api".into(), "api".into(), false)]);
    }

    #[test]
    fn builds_are_found_with_their_launcher_and_version() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join("svc/project")).unwrap();
        std::fs::create_dir_all(root.join("svc/core")).unwrap();
        std::fs::write(root.join("svc/build.sbt"), "lazy val core = project\n").unwrap();
        // A project's own build.sbt is part of the outer build.
        std::fs::write(root.join("svc/core/build.sbt"), "libraryDependencies += \"a\" % \"b\" % \"1\"\n").unwrap();
        std::fs::write(root.join("svc/project/build.properties"), "sbt.version = 1.10.7\n").unwrap();
        let builds = load(root);
        assert_eq!(builds.len(), 1);
        let b = &builds[0];
        assert_eq!((b.dir.as_str(), b.command.as_str(), b.version.as_deref()), ("svc", "sbt", Some("1.10.7")));
        assert_eq!(b.projects.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(), ["svc", "core"]);
    }
}
