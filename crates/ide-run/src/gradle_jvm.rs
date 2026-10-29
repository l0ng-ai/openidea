//! VM options for the JVMs a Gradle build forks (`bootRun`, `run`, `test`): Gradle has no
//! command-line switch for them, so a launch passes an init script that adds them to every
//! `JavaExec` and `Test` task (`--init-script <file>`). Gradle's own JVM is left alone.

use std::path::{Path, PathBuf};

/// Groovy string literal (single-quoted, `\` and `'` escaped).
fn groovy_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('\'');
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '\'' => out.push_str("\\'"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            c => out.push(c),
        }
    }
    out.push('\'');
    out
}

/// The init script adding `jvm_args` (one argument each) to the forked JVMs.
pub fn init_script(jvm_args: &[String]) -> String {
    let list = jvm_args.iter().map(|a| groovy_string(a)).collect::<Vec<_>>().join(", ");
    format!(
        "// Written by OpenIDEA: VM options of the run configuration.\n\
         allprojects {{\n    \
             tasks.withType(JavaExec).configureEach {{ jvmArgs([{list}]) }}\n    \
             tasks.withType(Test).configureEach {{ jvmArgs([{list}]) }}\n\
         }}\n"
    )
}

/// Where the scripts are written.
pub fn default_dir() -> PathBuf {
    std::env::temp_dir().join("openidea-gradle")
}

/// Writes the script for `jvm_args` under `dir` (named by its content, so launches share
/// it and nothing needs deleting) and returns its path.
pub fn write_init_script(dir: &Path, jvm_args: &[String]) -> std::io::Result<PathBuf> {
    use std::hash::{Hash, Hasher};
    let text = init_script(jvm_args);
    let mut h = std::collections::hash_map::DefaultHasher::new();
    text.hash(&mut h);
    let file = dir.join(format!("jvm-args-{:016x}.init.gradle", h.finish()));
    if std::fs::read_to_string(&file).is_ok_and(|t| t == text) {
        return Ok(file);
    }
    std::fs::create_dir_all(dir)?;
    let tmp = file.with_extension(format!("{}.tmp", std::process::id()));
    std::fs::write(&tmp, &text)?;
    std::fs::rename(&tmp, &file).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })?;
    Ok(file)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| (*s).to_owned()).collect()
    }

    #[test]
    fn adds_each_argument_to_java_exec_and_test_tasks() {
        let script = init_script(&args(&["-Ddemo.flag=on", "--add-opens", "java.base/java.lang=ALL-UNNAMED"]));
        let list = "['-Ddemo.flag=on', '--add-opens', 'java.base/java.lang=ALL-UNNAMED']";
        assert!(script.contains(&format!("tasks.withType(JavaExec).configureEach {{ jvmArgs({list}) }}")), "{script}");
        assert!(script.contains(&format!("tasks.withType(Test).configureEach {{ jvmArgs({list}) }}")), "{script}");
    }

    #[test]
    fn escapes_quotes_backslashes_and_keeps_spaces_and_dollars() {
        let script = init_script(&args(&[r"-Dpath=C:\Program Files\app", "-Dq=it's", "-Dv=${x}"]));
        assert!(script.contains(r"'-Dpath=C:\\Program Files\\app'"), "{script}");
        assert!(script.contains(r"'-Dq=it\'s'"), "{script}");
        // Single-quoted Groovy strings don't interpolate.
        assert!(script.contains("'-Dv=${x}'"), "{script}");
    }

    #[test]
    fn writes_one_file_per_content() {
        let dir = tempfile::tempdir().unwrap();
        let a = write_init_script(dir.path(), &args(&["-Xmx1g"])).unwrap();
        let again = write_init_script(dir.path(), &args(&["-Xmx1g"])).unwrap();
        let b = write_init_script(dir.path(), &args(&["-Xmx2g"])).unwrap();
        assert_eq!(a, again);
        assert_ne!(a, b);
        assert_eq!(std::fs::read_to_string(&a).unwrap(), init_script(&args(&["-Xmx1g"])));
        assert!(a.to_string_lossy().ends_with(".init.gradle"));
    }
}
