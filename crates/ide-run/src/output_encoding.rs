//! Makes the output of JVM and Python processes match the console's encoding.
//!
//! On Windows both write piped output in the ANSI code page (GBK on a Chinese
//! system: `javac` errors, Maven / Gradle logs, `print`), while the console decodes
//! the configured encoding (UTF-8 by default). They are told which one to use:
//! `java` through `stdout.encoding` / `stderr.encoding` (JDK 19+) and their
//! `sun.*` forerunners (JDK 8–18), Maven and Gradle through `MAVEN_OPTS` /
//! `GRADLE_OPTS`, Python through `PYTHONIOENCODING`.

use std::collections::BTreeMap;

const JAVA_PROPERTIES: &[&str] = &["stdout.encoding", "stderr.encoding", "sun.stdout.encoding", "sun.stderr.encoding"];

/// What a launch needs: `-D` options to put first on a `java` command line, and
/// environment variables to set.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct EncodingFix {
    pub java_args: Vec<String>,
    pub env: Vec<(String, String)>,
}

fn is_utf8(encoding: &str) -> bool {
    matches!(encoding.to_ascii_lowercase().replace('_', "-").as_str(), "utf-8" | "utf8")
}

fn java_options(encoding: &str) -> Vec<String> {
    JAVA_PROPERTIES.iter().map(|p| format!("-D{p}={encoding}")).collect()
}

fn sets_java_encoding(text: &str) -> bool {
    JAVA_PROPERTIES.iter().any(|p| text.contains(&format!("-D{p}=")))
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
    let encoding = encoding.trim();
    let mut out = EncodingFix::default();
    if encoding.is_empty() || (!windows && is_utf8(encoding)) {
        return out;
    }
    let current = |key: &str| vars.get(key).cloned().or_else(|| inherited(key));
    let name = crate::wrap::program_name(program).to_ascii_lowercase();
    match name.as_str() {
        "java" | "javaw" => {
            if !args.iter().any(|a| sets_java_encoding(a))
                && !current("JDK_JAVA_OPTIONS").is_some_and(|o| sets_java_encoding(&o))
            {
                out.java_args = java_options(encoding);
            }
        }
        "mvn" | "mvnw" | "mvnd" | "gradle" | "gradlew" => {
            let key = if name.starts_with("gradle") { "GRADLE_OPTS" } else { "MAVEN_OPTS" };
            let opts = current(key).unwrap_or_default();
            if !sets_java_encoding(&opts) {
                let added = java_options(encoding).join(" ");
                let value = if opts.trim().is_empty() { added } else { format!("{} {added}", opts.trim()) };
                out.env.push((key.to_owned(), value));
            }
        }
        _ if is_python(&name) && current("PYTHONIOENCODING").is_none_or(|v| v.trim().is_empty()) => {
            out.env.push(("PYTHONIOENCODING".to_owned(), encoding.to_owned()));
        }
        _ => {}
    }
    out
}

/// `python`, `python3`, `python3.12`, `py`, and the runners that start one.
fn is_python(name: &str) -> bool {
    name == "python"
        || name == "py"
        || name.strip_prefix("python").is_some_and(|v| v.chars().all(|c| c.is_ascii_digit() || c == '.'))
        || matches!(name, "uv" | "poetry" | "pdm" | "pytest" | "pipenv")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(program: &str, args: &[&str], vars: &[(&str, &str)], encoding: &str, windows: bool) -> EncodingFix {
        let args: Vec<String> = args.iter().map(|a| (*a).to_owned()).collect();
        let vars: BTreeMap<String, String> = vars.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())).collect();
        fix(program, &args, &vars, |_| None, encoding, windows)
    }

    #[test]
    fn java_launches_write_the_console_encoding_on_windows() {
        let expected = [
            "-Dstdout.encoding=UTF-8",
            "-Dstderr.encoding=UTF-8",
            "-Dsun.stdout.encoding=UTF-8",
            "-Dsun.stderr.encoding=UTF-8",
        ];
        // The reported case: a source-file launch through the Oracle `javapath` shim.
        let java = "C:/Program Files/Common Files/Oracle/Java/javapath/java.exe";
        for program in [java, "java", "javaw.exe", r"C:\jdk\bin\java.exe"] {
            let f = run(program, &["Main.java"], &[], "UTF-8", true);
            assert_eq!(f.java_args, expected, "{program}");
            assert!(f.env.is_empty());
        }
        assert_eq!(run("java", &["-cp", "x", "a.Main"], &[], "GBK", true).java_args[0], "-Dstdout.encoding=GBK");
    }

    #[test]
    fn nothing_changes_where_output_already_matches() {
        for (program, args) in [("java", vec!["Main.java"]), ("mvn", vec!["package"]), ("python3", vec!["a.py"])] {
            assert_eq!(run(program, &args, &[], "UTF-8", false), EncodingFix::default(), "{program}");
            assert_eq!(run(program, &args, &[], "utf8", false), EncodingFix::default(), "{program}");
            assert_eq!(run(program, &args, &[], "", true), EncodingFix::default(), "{program}");
        }
        for program in ["node", "cargo", "go", "npm.cmd", "cmd.exe"] {
            assert_eq!(run(program, &[], &[], "UTF-8", true), EncodingFix::default(), "{program}");
        }
        // A console set to another encoding elsewhere still gets it.
        assert_eq!(run("java", &["Main"], &[], "GBK", false).java_args.len(), 4);
    }

    #[test]
    fn options_chosen_by_the_user_win() {
        assert!(run("java", &["-Dstdout.encoding=GBK", "Main"], &[], "UTF-8", true).java_args.is_empty());
        assert!(
            run("java", &["Main"], &[("JDK_JAVA_OPTIONS", "-Dsun.stdout.encoding=GBK")], "UTF-8", true)
                .java_args
                .is_empty()
        );
        assert!(run("mvn.cmd", &[], &[("MAVEN_OPTS", "-Dstdout.encoding=GBK")], "UTF-8", true).env.is_empty());
        assert!(run("python.exe", &[], &[("PYTHONIOENCODING", "gbk")], "UTF-8", true).env.is_empty());
    }

    #[test]
    fn build_tools_and_python_get_environment_variables() {
        let opts =
            "-Dstdout.encoding=UTF-8 -Dstderr.encoding=UTF-8 -Dsun.stdout.encoding=UTF-8 -Dsun.stderr.encoding=UTF-8";
        for program in ["mvn.cmd", "mvnw.cmd", r"C:\maven\bin\mvn.cmd"] {
            assert_eq!(
                run(program, &["package"], &[], "UTF-8", true).env,
                [("MAVEN_OPTS".to_owned(), opts.to_owned())]
            );
        }
        for program in ["gradlew.bat", "gradle.bat"] {
            assert_eq!(run(program, &["build"], &[], "UTF-8", true).env, [("GRADLE_OPTS".to_owned(), opts.to_owned())]);
        }
        // Existing options are kept, from the configuration or the inherited environment.
        let f = run("mvn.cmd", &[], &[("MAVEN_OPTS", "-Xmx1g")], "UTF-8", true);
        assert_eq!(f.env, [("MAVEN_OPTS".to_owned(), format!("-Xmx1g {opts}"))]);
        let inherited =
            fix("gradlew.bat", &[], &BTreeMap::new(), |k| (k == "GRADLE_OPTS").then(|| "-Xmx2g".into()), "UTF-8", true);
        assert_eq!(inherited.env, [("GRADLE_OPTS".to_owned(), format!("-Xmx2g {opts}"))]);
        for program in ["python.exe", "python3", "python3.12", "py.exe", "uv.exe", "poetry"] {
            assert_eq!(
                run(program, &[], &[], "UTF-8", true).env,
                [("PYTHONIOENCODING".to_owned(), "UTF-8".to_owned())],
                "{program}"
            );
        }
        assert_eq!(run("python3", &[], &[], "GBK", false).env, [("PYTHONIOENCODING".to_owned(), "GBK".to_owned())]);
    }
}
