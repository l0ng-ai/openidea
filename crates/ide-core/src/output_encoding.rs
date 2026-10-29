//! Makes the output of JVM and Python processes match the encoding the IDE decodes.
//!
//! On Windows both write piped output in the ANSI code page (GBK on a Chinese
//! system: `System.out.println`, `javac` errors, Maven / Gradle logs, `print`), while
//! the console decodes the configured encoding (UTF-8 by default). They are told
//! which one to use:
//! - `java`: `stdout.encoding` / `stderr.encoding` (JDK 19+) and their `sun.*`
//!   forerunners (JDK 8–18) on the command line, plus `file.encoding=UTF-8` for a
//!   UTF-8 console, the default charset of JDK 18+, which logging frameworks' console
//!   appenders write in on older JDKs too.
//! - Build tools and launcher scripts (Maven, Gradle, sbt, …): the same `std*.encoding`
//!   properties in `JAVA_TOOL_OPTIONS`, the one variable every JVM reads, so the JVMs
//!   they fork get them too (`spring-boot:run`, Surefire, `bootRun`, test workers).
//!   Each JVM then reports "Picked up JAVA_TOOL_OPTIONS: …" on stderr (which a build tool
//!   may copy to its stdout); that line is hidden again ([`NoticeFilter`]). `file.encoding` is left alone there: it would change
//!   how a build reads sources that declare no encoding.
//! - Python: `PYTHONIOENCODING`.

use std::collections::BTreeMap;

const STD_PROPERTIES: &[&str] = &["stdout.encoding", "stderr.encoding", "sun.stdout.encoding", "sun.stderr.encoding"];
const FILE_ENCODING: &str = "file.encoding";
const TOOL_OPTIONS: &str = "JAVA_TOOL_OPTIONS";

/// Build tools and launcher scripts that run on (and may fork) JVMs.
const JVM_TOOLS: &[&str] =
    &["mvn", "mvnw", "mvnd", "gradle", "gradlew", "sbt", "ant", "kotlin", "kotlinc", "groovy", "scala", "jbang"];

/// What a launch needs: `-D` options to put first on a `java` command line,
/// environment variables to set, and the notice line its JVMs print because of them.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct EncodingFix {
    pub java_args: Vec<String>,
    pub env: Vec<(String, String)>,
    /// "Picked up JAVA_TOOL_OPTIONS: …" for a variable set here alone, to drop from the output.
    pub notice: Option<String>,
}

pub fn is_utf8(encoding: &str) -> bool {
    matches!(encoding.trim().to_ascii_lowercase().replace('_', "-").as_str(), "utf-8" | "utf8")
}

/// File name of `command` without a Windows executable extension: `C:\jdk\bin\java.exe` → `java`.
fn program_name(command: &str) -> String {
    let name = command.rsplit(['/', '\\']).next().unwrap_or(command).to_ascii_lowercase();
    for ext in [".exe", ".cmd", ".bat"] {
        if let Some(stem) = name.strip_suffix(ext) {
            return stem.to_owned();
        }
    }
    name
}

fn sets(text: &str, properties: &[&str]) -> bool {
    properties.iter().any(|p| text.contains(&format!("-D{p}=")))
}

fn options(properties: &[&str], encoding: &str) -> Vec<String> {
    properties.iter().map(|p| format!("-D{p}={encoding}")).collect()
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Java,
    JvmTool,
    Python,
    Other,
}

fn kind(program: &str) -> Kind {
    let name = program_name(program);
    if name == "java" || name == "javaw" {
        Kind::Java
    } else if JVM_TOOLS.contains(&name.as_str()) {
        Kind::JvmTool
    } else if is_python(&name) {
        Kind::Python
    } else {
        Kind::Other
    }
}

/// The options for a launch of `program` (`args`, environment `vars` over the
/// `inherited` one) whose output is decoded as `encoding`; nothing when the
/// process already writes it (UTF-8 off Windows) or the user chose the options.
pub fn fix(
    program: &str,
    args: &[String],
    vars: &BTreeMap<String, String>,
    inherited: impl Fn(&str) -> Option<String>,
    encoding: &str,
    windows: bool,
) -> EncodingFix {
    fix_kind(kind(program), Some(args), vars, inherited, encoding, windows)
}

/// [`fix`] for a command line run by the shell (`cmd /C "mvn spring-boot:run"`), whose
/// arguments cannot be changed: its first word decides, and only variables are set.
pub fn fix_command_line(
    line: &str,
    vars: &BTreeMap<String, String>,
    inherited: impl Fn(&str) -> Option<String>,
    encoding: &str,
    windows: bool,
) -> EncodingFix {
    let line = line.trim_start();
    let first = match line.chars().next() {
        Some(q @ ('"' | '\'')) => line[1..].split(q).next(),
        _ => line.split(char::is_whitespace).next(),
    }
    .unwrap_or_default();
    fix_kind(kind(first), None, vars, inherited, encoding, windows)
}

fn fix_kind(
    kind: Kind,
    args: Option<&[String]>,
    vars: &BTreeMap<String, String>,
    inherited: impl Fn(&str) -> Option<String>,
    encoding: &str,
    windows: bool,
) -> EncodingFix {
    let encoding = encoding.trim();
    let mut out = EncodingFix::default();
    if encoding.is_empty() || (!windows && is_utf8(encoding)) {
        return out;
    }
    let current = |key: &str| vars.get(key).cloned().or_else(|| inherited(key)).unwrap_or_default();
    let tool_options = current(TOOL_OPTIONS);
    match (kind, args) {
        (Kind::Java, Some(args)) => {
            let java_options = format!("{} {tool_options}", current("JDK_JAVA_OPTIONS"));
            let chosen =
                |properties: &[&str]| args.iter().any(|a| sets(a, properties)) || sets(&java_options, properties);
            if !chosen(STD_PROPERTIES) {
                out.java_args = options(STD_PROPERTIES, encoding);
            }
            if is_utf8(encoding) && !chosen(&[FILE_ENCODING]) {
                out.java_args.push(format!("-D{FILE_ENCODING}=UTF-8"));
            }
        }
        (Kind::Java | Kind::JvmTool, _) => {
            if !sets(&tool_options, STD_PROPERTIES) {
                let added = options(STD_PROPERTIES, encoding).join(" ");
                let value = match tool_options.trim() {
                    "" => {
                        out.notice = Some(format!("Picked up {TOOL_OPTIONS}: {added}"));
                        added
                    }
                    own => format!("{own} {added}"),
                };
                out.env.push((TOOL_OPTIONS.to_owned(), value));
            }
        }
        (Kind::Python, _) if current("PYTHONIOENCODING").trim().is_empty() => {
            out.env.push(("PYTHONIOENCODING".to_owned(), encoding.to_owned()));
        }
        _ => {}
    }
    out
}

/// `vmArgs` of a launch by java-debug, which decodes the JVM's output as `encoding`
/// (its launch attribute, UTF-8 when unset) and sets `file.encoding` itself.
pub fn java_debug_vm_args(vm_args: &str, encoding: Option<&str>, windows: bool) -> Option<String> {
    let encoding = encoding.map(str::trim).filter(|e| !e.is_empty()).unwrap_or("UTF-8");
    if (!windows && is_utf8(encoding)) || sets(vm_args, STD_PROPERTIES) {
        return None;
    }
    let added = options(STD_PROPERTIES, encoding).join(" ");
    Some(match vm_args.trim() {
        "" => added,
        own => format!("{own} {added}"),
    })
}

/// `python`, `python3`, `python3.12`, `py`, and the runners that start one.
fn is_python(name: &str) -> bool {
    name == "python"
        || name == "py"
        || name.strip_prefix("python").is_some_and(|v| v.chars().all(|c| c.is_ascii_digit() || c == '.'))
        || matches!(name, "uv" | "poetry" | "pdm" | "pytest" | "pipenv")
}

/// Drops whole lines equal to `notice` from a stream of decoded text (the
/// [`EncodingFix::notice`] each JVM prints), passing everything else through.
/// The start of a line is held back only while it can still become the notice.
#[derive(Debug)]
pub struct NoticeFilter {
    notice: String,
    held: String,
    at_line_start: bool,
}

impl NoticeFilter {
    pub fn new(notice: String) -> Self {
        Self { notice, held: String::new(), at_line_start: true }
    }

    pub fn filter(&mut self, text: &str, out: &mut String) {
        for piece in text.split_inclusive('\n') {
            if !self.at_line_start && self.held.is_empty() {
                out.push_str(piece);
                self.at_line_start = piece.ends_with('\n');
                continue;
            }
            self.held.push_str(piece);
            if self.held.ends_with('\n') {
                if self.held.trim_end_matches(['\n', '\r']) != self.notice {
                    out.push_str(&self.held);
                }
                self.held.clear();
                self.at_line_start = true;
            } else if !self.could_be_notice() {
                out.push_str(&self.held);
                self.held.clear();
                self.at_line_start = false;
            }
        }
    }

    /// The held text is the start of the notice, or all of it before a `\r\n`.
    fn could_be_notice(&self) -> bool {
        match self.held.strip_suffix('\r') {
            Some(line) => line == self.notice,
            None => self.notice.starts_with(self.held.as_str()),
        }
    }

    /// The held-back start of a line, at the end of the stream.
    pub fn finish(&mut self) -> String {
        std::mem::take(&mut self.held)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const STD_UTF8: [&str; 4] = [
        "-Dstdout.encoding=UTF-8",
        "-Dstderr.encoding=UTF-8",
        "-Dsun.stdout.encoding=UTF-8",
        "-Dsun.stderr.encoding=UTF-8",
    ];
    const TOOL_UTF8: &str =
        "-Dstdout.encoding=UTF-8 -Dstderr.encoding=UTF-8 -Dsun.stdout.encoding=UTF-8 -Dsun.stderr.encoding=UTF-8";

    fn vars(vars: &[(&str, &str)]) -> BTreeMap<String, String> {
        vars.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())).collect()
    }

    fn run(program: &str, args: &[&str], env: &[(&str, &str)], encoding: &str, windows: bool) -> EncodingFix {
        let args: Vec<String> = args.iter().map(|a| (*a).to_owned()).collect();
        fix(program, &args, &vars(env), |_| None, encoding, windows)
    }

    fn tool_env(f: &EncodingFix) -> Option<&str> {
        f.env.iter().find(|(k, _)| k == TOOL_OPTIONS).map(|(_, v)| v.as_str())
    }

    #[test]
    fn java_launches_write_the_console_encoding_on_windows() {
        let mut expected: Vec<&str> = STD_UTF8.to_vec();
        expected.push("-Dfile.encoding=UTF-8");
        // A source-file launch through the Oracle `javapath` shim, and an Application / Spring Boot launch.
        let java = "C:/Program Files/Common Files/Oracle/Java/javapath/java.exe";
        for program in [java, "java", "javaw.exe", r"C:\jdk\bin\java.exe", "JAVA.EXE"] {
            for args in [&["Main.java"][..], &["-cp", "a;b", "org.dromara.DromaraApplication"]] {
                let f = run(program, args, &[], "UTF-8", true);
                assert_eq!(f.java_args, expected, "{program}");
                assert!(f.env.is_empty() && f.notice.is_none());
            }
        }
        // Another console encoding: the streams follow it, the default charset stays the platform's.
        assert_eq!(
            run("java", &["-cp", "x", "a.Main"], &[], "GBK", true).java_args,
            [
                "-Dstdout.encoding=GBK",
                "-Dstderr.encoding=GBK",
                "-Dsun.stdout.encoding=GBK",
                "-Dsun.stderr.encoding=GBK"
            ]
        );
    }

    #[test]
    fn nothing_changes_where_output_already_matches() {
        for (program, args) in [("java", vec!["Main.java"]), ("mvn", vec!["package"]), ("python3", vec!["a.py"])] {
            assert_eq!(run(program, &args, &[], "UTF-8", false), EncodingFix::default(), "{program}");
            assert_eq!(run(program, &args, &[], "utf8", false), EncodingFix::default(), "{program}");
            assert_eq!(run(program, &args, &[], "", true), EncodingFix::default(), "{program}");
        }
        for program in ["node", "cargo", "go", "npm.cmd", "cmd.exe", "javac-wrapper"] {
            assert_eq!(run(program, &[], &[], "UTF-8", true), EncodingFix::default(), "{program}");
        }
        // A console set to another encoding elsewhere still gets it.
        assert_eq!(run("java", &["Main"], &[], "GBK", false).java_args.len(), 4);
    }

    #[test]
    fn options_chosen_by_the_user_win() {
        let f = run("java", &["-Dstdout.encoding=GBK", "Main"], &[], "UTF-8", true);
        assert_eq!(f.java_args, ["-Dfile.encoding=UTF-8"]);
        let f = run("java", &["-Dfile.encoding=GBK", "Main"], &[], "UTF-8", true);
        assert_eq!(f.java_args, STD_UTF8);
        for key in ["JDK_JAVA_OPTIONS", TOOL_OPTIONS] {
            let f = run("java", &["Main"], &[(key, "-Dsun.stdout.encoding=GBK -Dfile.encoding=GBK")], "UTF-8", true);
            assert!(f.java_args.is_empty(), "{key}");
        }
        assert!(run("mvn.cmd", &[], &[(TOOL_OPTIONS, "-Dstdout.encoding=GBK")], "UTF-8", true).env.is_empty());
        assert!(run("python.exe", &[], &[("PYTHONIOENCODING", "gbk")], "UTF-8", true).env.is_empty());
    }

    /// Maven's `spring-boot:run` and Surefire, Gradle's `bootRun` and test workers fork JVMs
    /// that never see `MAVEN_OPTS` / `GRADLE_OPTS`: the options go where every JVM reads them.
    #[test]
    fn build_tools_reach_the_jvms_they_fork() {
        for program in [
            "mvn.cmd",
            "mvnw.cmd",
            r"C:\maven\bin\mvn.cmd",
            "mvnd.cmd",
            "gradlew.bat",
            "gradle.bat",
            "sbt.bat",
            "kotlinc.bat",
        ] {
            let f = run(program, &["spring-boot:run"], &[], "UTF-8", true);
            assert_eq!(tool_env(&f), Some(TOOL_UTF8), "{program}");
            assert_eq!(f.notice.as_deref(), Some(format!("Picked up JAVA_TOOL_OPTIONS: {TOOL_UTF8}").as_str()));
            assert!(f.java_args.is_empty());
            assert!(!tool_env(&f).unwrap().contains("file.encoding"), "a build's source encoding is left alone");
        }
        // Existing options are kept, from the configuration or the inherited environment; the
        // JVMs then print the user's own variable, which stays visible.
        let f = run("mvn.cmd", &[], &[(TOOL_OPTIONS, "-javaagent:a.jar")], "UTF-8", true);
        assert_eq!(tool_env(&f), Some(format!("-javaagent:a.jar {TOOL_UTF8}").as_str()));
        assert!(f.notice.is_none());
        let inherited =
            fix("gradlew.bat", &[], &BTreeMap::new(), |k| (k == TOOL_OPTIONS).then(|| "-Xss4m".into()), "UTF-8", true);
        assert_eq!(tool_env(&inherited), Some(format!("-Xss4m {TOOL_UTF8}").as_str()));
        for program in ["python.exe", "python3", "python3.12", "py.exe", "uv.exe", "poetry"] {
            assert_eq!(
                run(program, &[], &[], "UTF-8", true).env,
                [("PYTHONIOENCODING".to_owned(), "UTF-8".to_owned())],
                "{program}"
            );
        }
        assert_eq!(run("python3", &[], &[], "GBK", false).env, [("PYTHONIOENCODING".to_owned(), "GBK".to_owned())]);
    }

    #[test]
    fn shell_command_lines_get_variables_from_their_first_word() {
        let line = |l: &str| fix_command_line(l, &BTreeMap::new(), |_| None, "UTF-8", true);
        for l in [
            "mvn spring-boot:run -pl ruoyi-admin",
            "\"C:\\Program Files\\Maven\\bin\\mvn.cmd\" test",
            "java -jar app.jar",
        ] {
            let f = line(l);
            assert_eq!(tool_env(&f), Some(TOOL_UTF8), "{l}");
            assert!(f.java_args.is_empty());
        }
        assert_eq!(line("python manage.py runserver").env[0].0, "PYTHONIOENCODING");
        assert_eq!(line("npm run dev && echo done"), EncodingFix::default());
        assert_eq!(fix_command_line("mvn test", &BTreeMap::new(), |_| None, "UTF-8", false), EncodingFix::default());
    }

    #[test]
    fn java_debug_launches_write_what_java_debug_decodes() {
        assert_eq!(java_debug_vm_args("", None, true).as_deref(), Some(TOOL_UTF8));
        assert_eq!(java_debug_vm_args("-Xmx1g", Some(""), true), Some(format!("-Xmx1g {TOOL_UTF8}")));
        assert_eq!(java_debug_vm_args("", Some("GBK"), true).unwrap().split(' ').next(), Some("-Dstdout.encoding=GBK"));
        assert_eq!(java_debug_vm_args("-Dstdout.encoding=GBK", None, true), None);
        assert_eq!(java_debug_vm_args("-Xmx1g", None, false), None);
        assert!(java_debug_vm_args("", Some("GBK"), false).is_some());
    }

    fn filtered(chunks: &[&str]) -> String {
        let mut f = NoticeFilter::new(format!("Picked up JAVA_TOOL_OPTIONS: {TOOL_UTF8}"));
        let mut out = String::new();
        for c in chunks {
            f.filter(c, &mut out);
        }
        out.push_str(&f.finish());
        out
    }

    #[test]
    fn notice_lines_are_dropped_wherever_the_chunks_split() {
        let notice = format!("Picked up JAVA_TOOL_OPTIONS: {TOOL_UTF8}");
        let text =
            format!("{notice}\r\nerror: one\n{notice}\nPicked up nothing\nPicked up JAVA_TOOL_OPTIONS: -Dx\nlast");
        let expected = "error: one\nPicked up nothing\nPicked up JAVA_TOOL_OPTIONS: -Dx\nlast";
        assert_eq!(filtered(&[&text]), expected);
        // Every split point, also inside the notice and between `\r` and `\n`.
        for i in 1..text.len() {
            let (a, b) = text.split_at(i);
            assert_eq!(filtered(&[a, b]), expected, "split at {i}");
        }
        // A line that only starts like it is not held: text mid-line passes through at once.
        let mut f = NoticeFilter::new(notice.clone());
        let mut out = String::new();
        f.filter("Pick a number: ", &mut out);
        assert_eq!(out, "Pick a number: ");
        f.filter("Picked", &mut out);
        assert_eq!(out, "Pick a number: Picked");
        // A prefix at the end of the stream comes out on finish.
        assert_eq!(filtered(&["Picked up"]), "Picked up");
    }
}
