//! Checkstyle for OpenIDEA: runs the `checkstyle` command line on a Java file
//! when it is saved (as a cancellable task; a newer save cancels the running
//! check), publishes the problems as diagnostics, and offers quick fixes for
//! the ones it can fix textually.
//!
//! The configuration is the project's own when it has one (`checkstyle.xml`,
//! `config/checkstyle/checkstyle.xml` as Gradle and Maven projects keep it,
//! or `.checkstyle.xml`), else the Google or Sun checks chosen with the
//! commands.

use openidea_plugin::host::{self, storage};
use openidea_plugin::providers::{CodeAction, Document, Providers};
use openidea_plugin::{
    Diagnostic, Error, Event, Invocation, NotificationLevel, Plugin, Position, Project, Range, Severity, TextEdit,
    register_plugin,
};
use std::collections::BTreeMap;

/// Built into the Checkstyle jar.
const GOOGLE: &str = "/google_checks.xml";
const SUN: &str = "/sun_checks.xml";
/// Project configurations, by preference (project-relative; the check runs in the project root).
const PROJECT_CONFIGS: [&str; 3] = ["checkstyle.xml", "config/checkstyle/checkstyle.xml", ".checkstyle.xml"];

/// One reported problem.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Problem {
    /// 0-based.
    pub line: u32,
    /// 0-based; `None` for the whole line.
    pub column: Option<u32>,
    pub severity: Severity,
    pub message: String,
    /// The check's simple name (`FileTabCharacter`).
    pub check: String,
}

#[derive(Default)]
pub struct Checkstyle {
    /// Last results per file (for quick fixes; rebuilt by the next save).
    problems: BTreeMap<String, Vec<Problem>>,
}

fn unescape(s: &str) -> String {
    s.replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&#10;", "\n")
        .replace("&amp;", "&")
}

fn attr(tag: &str, name: &str) -> Option<String> {
    let start = tag.find(&format!(" {name}=\""))? + name.len() + 3;
    let end = tag[start..].find('"')? + start;
    Some(unescape(&tag[start..end]))
}

/// Problems per file from Checkstyle's `-f xml` report.
pub fn parse_report(xml: &str) -> BTreeMap<String, Vec<Problem>> {
    let mut out: BTreeMap<String, Vec<Problem>> = BTreeMap::new();
    let mut file = None;
    for tag in xml.split('<').skip(1) {
        let tag = format!(" {}", tag.split('>').next().unwrap_or(""));
        if tag.starts_with(" file ") {
            file = attr(&tag, "name");
            if let Some(f) = &file {
                out.entry(f.clone()).or_default();
            }
        } else if tag.starts_with(" error ") {
            let (Some(f), Some(line)) = (&file, attr(&tag, "line").and_then(|l| l.parse::<u32>().ok())) else {
                continue;
            };
            let severity = match attr(&tag, "severity").as_deref() {
                Some("error") => Severity::Error,
                Some("info") => Severity::Info,
                Some("ignore") => continue,
                _ => Severity::Warning,
            };
            let check = attr(&tag, "source").unwrap_or_default();
            // Checks configured with an `id` report it after a `#` (Google checks: `RegexpSinglelineCheck#noTrailingWhitespace`).
            let check = check.split('#').next().unwrap_or_default();
            let check = check.rsplit('.').next().unwrap_or(check).trim_end_matches("Check").to_owned();
            out.entry(f.clone()).or_default().push(Problem {
                line: line.saturating_sub(1),
                column: attr(&tag, "column").and_then(|c| c.parse::<u32>().ok()).map(|c| c.saturating_sub(1)),
                severity,
                message: attr(&tag, "message").unwrap_or_default(),
                check,
            });
        }
    }
    out
}

fn diagnostic(p: &Problem, text: &str) -> Diagnostic {
    let line_len = text.split('\n').nth(p.line as usize).map_or(0, |l| l.encode_utf16().count() as u32);
    let start = p.column.unwrap_or(0).min(line_len);
    let end = if p.column.is_some() && start < line_len { start + 1 } else { line_len };
    let range = Range::new(Position::new(p.line, start), Position::new(p.line, end.max(start)));
    Diagnostic::new(range, p.severity, p.message.clone()).code(p.check.clone())
}

/// The project containing `path`.
fn project_of(path: &str) -> Option<Project> {
    host::projects()
        .ok()?
        .into_iter()
        .filter(|p| p.root().is_ok_and(|r| path.starts_with(&r)))
        .max_by_key(|p| p.root().map(|r| r.len()).unwrap_or(0))
}

fn windows_path(path: &str) -> String {
    let path = path.replace('\\', "/");
    if let Some(rest) = path.strip_prefix("//?/UNC/") {
        format!("//{rest}")
    } else {
        path.strip_prefix("//?/").unwrap_or(&path).to_owned()
    }
}

fn report_matches_file(reported: &str, path: &str) -> bool {
    // WASI plugins run on every host, so interpret the host's path rather than cfg(windows).
    let drive = path.as_bytes().get(1) == Some(&b':') && path.as_bytes()[0].is_ascii_alphabetic();
    if drive || path.starts_with("//") || path.starts_with(r"\\") {
        let (reported, path) = (windows_path(reported), windows_path(path));
        reported == path || path.ends_with(&reported)
    } else {
        reported == path || path.ends_with(reported)
    }
}

/// The configuration for files of `project`.
fn config_for(project: &Project) -> String {
    PROJECT_CONFIGS
        .iter()
        .find(|c| project.read_file(c).is_ok())
        .map(|c| (*c).to_owned())
        .or_else(|| storage::get("config").ok().flatten())
        .unwrap_or_else(|| GOOGLE.into())
}

impl Checkstyle {
    /// Checks `path` and publishes the result. `Err(Cancelled)` when a newer
    /// save (or the user) cancelled it.
    fn check(&mut self, path: &str) -> Result<usize, Error> {
        let project = project_of(path).ok_or_else(|| Error::NotFound(format!("{path} is not in an open project")))?;
        let name = path.rsplit(['/', '\\']).next().unwrap_or(path);
        let task = host::begin_task(&format!("Checkstyle: {name}"), true);
        let config = config_for(&project);
        let args = vec!["-f".to_owned(), "xml".into(), "-c".into(), config, path.to_owned()];
        let out = project.run_process("checkstyle", &args, None)?;
        if task.is_cancelled() {
            return Err(Error::Cancelled);
        }
        // Exit status is the number of errors; only missing output is a failure.
        if !out.stdout.contains("<checkstyle") {
            return Err(Error::Failed(format!("checkstyle: {}", out.stderr.lines().next().unwrap_or("no report"))));
        }
        let report = parse_report(&out.stdout);
        let problems =
            report.into_iter().find(|(f, _)| report_matches_file(f, path)).map(|(_, p)| p).unwrap_or_default();
        let text = project.read_file(path).unwrap_or_default();
        let diagnostics: Vec<Diagnostic> = problems.iter().map(|p| diagnostic(p, &text)).collect();
        host::publish_diagnostics(path, &diagnostics)?;
        let n = problems.len();
        self.problems.insert(path.to_owned(), problems);
        Ok(n)
    }
}

impl Providers for Checkstyle {
    fn code_actions(&mut self, doc: &Document, selection: Range) -> Vec<CodeAction> {
        let Some(problems) = self.problems.get(&doc.path) else { return Vec::new() };
        let lines: Vec<&str> = doc.text.split('\n').collect();
        let mut out = Vec::new();
        let mut seen = std::collections::BTreeSet::new();
        for p in problems.iter().filter(|p| p.line >= selection.start.line && p.line <= selection.end.line) {
            let Some(line) = lines.get(p.line as usize) else { continue };
            let whole = Range::new(Position::new(p.line, 0), Position::new(p.line, line.encode_utf16().count() as u32));
            let (title, edit) = match p.check.as_str() {
                "FileTabCharacter" => {
                    ("Replace tabs with spaces", TextEdit { range: whole, text: line.replace('\t', "    ") })
                }
                "RegexpSingleline" if p.message.to_lowercase().contains("trailing") => {
                    ("Remove trailing whitespace", TextEdit { range: whole, text: line.trim_end().to_owned() })
                }
                "NewlineAtEndOfFile" => {
                    let last = lines.len() as u32 - 1;
                    let end = Position::new(last, lines[last as usize].encode_utf16().count() as u32);
                    (
                        "Add a newline at the end of the file",
                        TextEdit { range: Range::new(end, end), text: "\n".into() },
                    )
                }
                _ => continue,
            };
            if seen.insert((title, p.line)) {
                out.push(CodeAction {
                    title: format!("Checkstyle: {title}"),
                    kind: Some("quickfix".into()),
                    preferred: true,
                    edits: vec![(doc.path.clone(), vec![edit])],
                    data: None,
                });
            }
        }
        out
    }
}

impl Plugin for Checkstyle {
    fn run_command(&mut self, id: &str, ctx: &Invocation, _arg: Option<&str>) -> Result<Option<String>, Error> {
        match id {
            "check" => {
                let editor = ctx.editor().ok_or("no file is open")?;
                let n = self.check(&editor.path())?;
                Ok(Some(format!("{n} problems")))
            }
            "use-google" | "use-sun" => {
                storage::set("config", if id == "use-sun" { SUN } else { GOOGLE })?;
                Ok(None)
            }
            _ => Err(Error::NotFound(format!("command {id}"))),
        }
    }

    fn handle_events(&mut self, events: &[Event], _ctx: &Invocation) {
        let mut saved: Vec<&str> = events
            .iter()
            .filter_map(|e| match e {
                Event::FileSaved(p) if p.ends_with(".java") => Some(p.as_str()),
                _ => None,
            })
            .collect();
        saved.sort_unstable();
        saved.dedup();
        for path in saved {
            match self.check(path) {
                Ok(_) => {}
                Err(Error::Cancelled) => return, // a newer save takes over
                Err(e) => {
                    host::notify(NotificationLevel::Warning, "Checkstyle", &e.to_string());
                    return;
                }
            }
        }
    }
}

register_plugin!(Checkstyle, providers);

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
    use super::*;
    use openidea_plugin::ProcessOutput;
    use openidea_plugin::mock::MockHost;

    const REPORT: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<checkstyle version="10.17.0">
<file name="/project/src/A.java">
<error line="2" column="1" severity="warning" message="Line contains a tab character." source="com.puppycrawl.tools.checkstyle.checks.whitespace.FileTabCharacterCheck"/>
<error line="3" severity="error" message="Trailing whitespace is not allowed" source="com.puppycrawl.tools.checkstyle.checks.regexp.RegexpSinglelineCheck#noTrailingWhitespace"/>
</file>
</checkstyle>"#;

    #[test]
    fn parses_reports() {
        let r = parse_report(REPORT);
        let p = &r["/project/src/A.java"];
        assert_eq!(p.len(), 2);
        assert_eq!((p[0].line, p[0].column, p[0].check.as_str()), (1, Some(0), "FileTabCharacter"));
        assert_eq!(
            (p[1].severity, p[1].message.as_str(), p[1].check.as_str()),
            (Severity::Error, "Trailing whitespace is not allowed", "RegexpSingleline")
        );
    }

    #[test]
    fn checks_saved_java_files_and_fixes() {
        let host = MockHost::install().with_capabilities(&["project.read", "events", "storage", "process:checkstyle"]);
        let text = "class A {\n\tint x;\n  void f() {}   \n}";
        host.add_file("src/A.java", text);
        host.on_process("checkstyle", |args, _| {
            assert_eq!(&args[..4], ["-f", "xml", "-c", GOOGLE]);
            Ok(ProcessOutput { status: Some(1), stdout: REPORT.into(), stderr: String::new() })
        });
        let mut p = Checkstyle::default();
        p.handle_events(
            &[Event::FileSaved("/project/src/A.java".into()), Event::FileSaved("/project/notes.txt".into())],
            &host.invocation(),
        );
        assert_eq!(host.process_runs().len(), 1, "only Java files");
        assert_eq!(host.process_runs()[0].cwd.as_deref(), Some("/project"));
        let d = &host.diagnostics()["/project/src/A.java"];
        assert_eq!(d.len(), 2);
        assert_eq!(d[1].range, Range::new(Position::new(2, 0), Position::new(2, 16)), "whole line without a column");
        assert!(host.tasks()[0].ended);

        let doc =
            Document { path: "/project/src/A.java".into(), language: "java".into(), version: 1, text: text.into() };
        let actions = p.code_actions(&doc, Range::new(Position::new(1, 0), Position::new(2, 0)));
        let titles: Vec<_> = actions.iter().map(|a| a.title.as_str()).collect();
        assert_eq!(titles, ["Checkstyle: Replace tabs with spaces", "Checkstyle: Remove trailing whitespace"]);
        assert_eq!(actions[1].edits[0].1[0].text, "  void f() {}");
    }

    #[test]
    fn unix_report_paths_preserve_backslashes() {
        assert!(report_matches_file("/project/A\\B.java", "/project/A\\B.java"));
        assert!(!report_matches_file("/project/A\\B.java", "/project/A/B.java"));
    }

    #[test]
    fn windows_reports_match_the_saved_file_and_keep_quick_fixes() {
        for (root, reported) in [
            ("C:/project", r"C:\project\src\A.java"),
            ("C:/project", r"\\?\C:\project\src\A.java"),
            ("C:/project", r"src\A.java"),
            ("//server/share/project", r"\\server\share\project\src\A.java"),
            ("//server/share/project", r"\\?\UNC\server\share\project\src\A.java"),
        ] {
            let host =
                MockHost::install().with_capabilities(&["project.read", "events", "storage", "process:checkstyle"]);
            host.set_project_root(Some(root));
            host.add_file("src/A.java", "class A {\n\tint x;\n  void f() {}   \n}");
            let xml = REPORT.replace("/project/src/A.java", reported);
            host.on_process("checkstyle", move |_, _| {
                Ok(ProcessOutput { status: Some(1), stdout: xml.clone(), stderr: String::new() })
            });
            let path = format!("{root}/src/A.java");
            let mut plugin = Checkstyle::default();
            plugin.handle_events(&[Event::FileSaved(path.clone())], &host.invocation());
            assert_eq!(host.diagnostics()[&path].len(), 2, "{reported}");
            let doc = Document {
                path: path.clone(),
                language: "java".into(),
                version: 1,
                text: "class A {\n\tint x;\n  void f() {}   \n}".into(),
            };
            let actions = plugin.code_actions(&doc, Range::new(Position::new(1, 0), Position::new(2, 0)));
            assert_eq!(actions.len(), 2, "{reported}");
            assert_eq!(actions[0].edits[0].0, path);
        }
    }

    #[test]
    fn the_projects_configuration_wins() {
        let host = MockHost::install().with_capabilities(&["project.read", "events", "storage", "process:checkstyle"]);
        host.add_file("src/A.java", "class A {}");
        host.on_process("checkstyle", |_, _| {
            Ok(ProcessOutput { status: Some(0), stdout: "<checkstyle/>".into(), stderr: String::new() })
        });
        let mut p = Checkstyle::default();
        p.run_command("use-sun", &host.invocation(), None).unwrap();
        p.handle_events(&[Event::FileSaved("/project/src/A.java".into())], &host.invocation());
        host.add_file("config/checkstyle/checkstyle.xml", "<module name=\"Checker\"/>");
        p.handle_events(&[Event::FileSaved("/project/src/A.java".into())], &host.invocation());
        let configs: Vec<String> = host.process_runs().iter().map(|r| r.args[3].clone()).collect();
        assert_eq!(configs, [SUN, "config/checkstyle/checkstyle.xml"]);
    }

    #[test]
    fn a_missing_checkstyle_is_reported_once() {
        let host = MockHost::install().with_capabilities(&["project.read", "events", "storage"]);
        host.add_file("src/A.java", "class A {}");
        Checkstyle::default().handle_events(&[Event::FileSaved("/project/src/A.java".into())], &host.invocation());
        assert!(host.notifications()[0].body.contains("process:checkstyle"));
    }
}
