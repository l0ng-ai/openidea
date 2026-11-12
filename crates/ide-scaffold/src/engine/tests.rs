use super::*;
use crate::catalog::{defs, parse};
use std::collections::BTreeMap;
use std::sync::Mutex;

fn request(generator: &str, location: &Path, name: &str, values: &[(&str, &str)]) -> CreateRequest {
    CreateRequest {
        generator: generator.into(),
        location: location.to_path_buf().into(),
        name: name.into(),
        git: false,
        values: values.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
    }
}

/// Relative paths of the files under `dir`, sorted.
fn tree(dir: &Path) -> Vec<String> {
    fn walk(root: &Path, dir: &Path, out: &mut Vec<String>) {
        for e in std::fs::read_dir(dir).unwrap() {
            let p = e.unwrap().path();
            if p.is_dir() {
                walk(root, &p, out);
            } else {
                out.push(p.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/"));
            }
        }
    }
    let mut out = Vec::new();
    walk(dir, dir, &mut out);
    out.sort();
    out
}

fn source_def(id: &str) -> Def {
    parse(id, crate::catalog::SOURCES.iter().find(|(i, _)| *i == id).unwrap().1).unwrap()
}

/// Creates a template project, without the optional `after` steps (a Gradle wrapper).
fn create_template(generator: &str, name: &str, values: &[(&str, &str)]) -> (tempfile::TempDir, PathBuf) {
    let tmp = tempfile::tempdir().unwrap();
    let mut def = source_def(generator);
    def.after.clear();
    let req = request(generator, tmp.path(), name, values);
    let path = create_with(&def, &req, &CancellationToken::new(), &|_| {}).unwrap();
    (tmp, path)
}

#[test]
fn java_maven_and_gradle_trees() {
    let (_tmp, dir) = create_template("java", "My App", &[("jdk", "/opt/jdk-21")]);
    assert_eq!(dir.file_name().unwrap(), "My App");
    assert_eq!(
        tree(&dir),
        [".gitignore", ".openidea/settings.toml", "pom.xml", "src/main/java/com/example/myapp/Main.java"]
    );
    let pom = std::fs::read_to_string(dir.join("pom.xml")).unwrap();
    assert!(pom.contains("<artifactId>my-app</artifactId>"), "{pom}");
    assert!(pom.starts_with("<?xml"));
    let main = std::fs::read_to_string(dir.join("src/main/java/com/example/myapp/Main.java")).unwrap();
    assert!(main.starts_with("package com.example.myapp;"));
    let settings = std::fs::read_to_string(dir.join(".openidea/settings.toml")).unwrap();
    assert_eq!(settings.trim(), "[java]\njdk = \"/opt/jdk-21\"");
    // The staging directory is gone.
    assert_eq!(std::fs::read_dir(dir.parent().unwrap()).unwrap().count(), 1);

    let (_tmp, dir) = create_template("java", "demo", &[("build", "gradle"), ("sample", "false")]);
    assert_eq!(tree(&dir), [".gitignore", "build.gradle.kts", "settings.gradle.kts"]);
}

#[test]
fn kotlin_and_other_template_trees() {
    let (_tmp, dir) = create_template("kotlin", "demo", &[]);
    assert_eq!(
        tree(&dir),
        [".gitignore", "build.gradle.kts", "settings.gradle.kts", "src/main/kotlin/com/example/demo/Main.kt"]
    );
    let (_tmp, dir) = create_template("cpp", "hello world", &[("lang", "c")]);
    assert_eq!(tree(&dir), [".gitignore", "CMakeLists.txt", "src/main.c"]);
    let cmake = std::fs::read_to_string(dir.join("CMakeLists.txt")).unwrap();
    assert!(cmake.contains("project(hello_world LANGUAGES C)"));
    let (_tmp, dir) = create_template("html", "site", &[]);
    assert_eq!(tree(&dir), ["index.html", "script.js", "style.css"]);
    let (_tmp, dir) = create_template("empty", "nothing", &[]);
    assert!(tree(&dir).is_empty());
}

#[test]
fn php_namespace_is_escaped_in_json() {
    let mut def = source_def("php");
    def.requires.clear();
    def.after.clear();
    let tmp = tempfile::tempdir().unwrap();
    let dir = create_with(&def, &request("php", tmp.path(), "shop", &[]), &CancellationToken::new(), &|_| {}).unwrap();
    let composer: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(dir.join("composer.json")).unwrap()).unwrap();
    assert_eq!(composer.pointer("/autoload/psr-4/Acme\\Shop\\").unwrap(), "src/");
    let index = std::fs::read_to_string(dir.join("public/index.php")).unwrap();
    assert!(index.contains(r"new \Acme\Shop\App()"), "{index}");
}

/// The command lines of every command generator, with the field defaults.
#[test]
fn command_lines() {
    let mut lines = BTreeMap::new();
    for def in defs() {
        let values = with_defaults(def, "my-app", &Values::new());
        let steps: Vec<String> = def
            .steps
            .iter()
            .chain(&def.after)
            .filter(|s| matches(&s.when, &values))
            .map(|s| argv(s, &values).join(" "))
            .collect();
        if !steps.is_empty() {
            lines.insert(def.id.clone(), steps);
        }
    }
    insta::assert_yaml_snapshot!(lines);
}

#[test]
fn package_steps_use_the_chosen_runner() {
    let def = def("vite").unwrap();
    let step = &def.steps[0];
    let mut values = with_defaults(def, "web", &Values::new());
    assert_eq!(argv(step, &values)[..3], ["npx", "--yes", "create-vite@latest"]);
    values.insert("pm".into(), "pnpm".into());
    assert_eq!(argv(step, &values)[..3], ["pnpm", "dlx", "create-vite@latest"]);
    values.insert("pm".into(), "bun".into());
    assert_eq!(argv(step, &values)[..2], ["bunx", "create-vite@latest"]);
}

#[test]
fn conditional_arguments() {
    let def = def("python").unwrap();
    let mut values = with_defaults(def, "app", &Values::new());
    assert!(!argv(&def.steps[0], &values).contains(&"--python".to_owned()));
    values.insert("python".into(), "3.13".into());
    assert!(argv(&def.steps[0], &values).ends_with(&["--python".to_owned(), "3.13".to_owned()]));
}

fn failing_def(steps: &str) -> Def {
    toml::from_str(&format!(
        r#"
id = "t"
name = "T"
group = "T"
icon = "folder"
[[files]]
path = "a.txt"
content = "a"
{steps}
"#
    ))
    .unwrap()
}

#[test]
fn a_failed_step_leaves_nothing_behind() {
    let tmp = tempfile::tempdir().unwrap();
    let def = failing_def(
        r#"
[[after]]
label = "Fail"
program = "definitely-not-a-program-openidea"
"#,
    );
    let err = create_with(&def, &request("t", tmp.path(), "p", &[]), &CancellationToken::new(), &|_| {}).unwrap_err();
    assert!(err.message.contains("not installed"), "{}", err.message);
    assert_eq!(std::fs::read_dir(tmp.path()).unwrap().count(), 0);
}

#[test]
fn an_optional_missing_program_is_skipped() {
    let tmp = tempfile::tempdir().unwrap();
    let def = failing_def(
        r#"
[[after]]
label = "Maybe"
program = "definitely-not-a-program-openidea"
optional = true
"#,
    );
    let lines = Mutex::new(Vec::new());
    let dir = create_with(&def, &request("t", tmp.path(), "p", &[]), &CancellationToken::new(), &|e| {
        lines.lock().unwrap().push(format!("{e:?}"))
    })
    .unwrap();
    assert_eq!(tree(&dir), ["a.txt"]);
    assert!(lines.lock().unwrap().iter().any(|l| l.contains("skipped")));
}

#[test]
fn cancelling_leaves_nothing_behind() {
    let tmp = tempfile::tempdir().unwrap();
    let cancel = CancellationToken::new();
    cancel.cancel();
    let def = failing_def("");
    let err = create_with(&def, &request("t", tmp.path(), "p", &[]), &cancel, &|_| {}).unwrap_err();
    assert_eq!(err.kind, ErrorKind::Cancelled);
    assert_eq!(std::fs::read_dir(tmp.path()).unwrap().count(), 0);
}

#[test]
fn refuses_a_non_empty_target_and_bad_names() {
    let tmp = tempfile::tempdir().unwrap();
    std::fs::create_dir(tmp.path().join("p")).unwrap();
    std::fs::write(tmp.path().join("p/x"), "").unwrap();
    let def = failing_def("");
    assert!(create_with(&def, &request("t", tmp.path(), "p", &[]), &CancellationToken::new(), &|_| {}).is_err());
    assert!(std::fs::read_dir(tmp.path().join("p")).unwrap().count() == 1);
    for bad in ["", " ", "a/b", "..", ".hidden"] {
        assert!(name_error(bad).is_some(), "{bad:?}");
    }
    // An existing empty folder is used.
    std::fs::create_dir(tmp.path().join("q")).unwrap();
    let dir = create_with(&def, &request("t", tmp.path(), "q", &[]), &CancellationToken::new(), &|_| {}).unwrap();
    assert_eq!(tree(&dir), ["a.txt"]);
}

#[test]
fn zip_top_folder_is_hoisted() {
    let tmp = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(tmp.path().join("demo/src")).unwrap();
    std::fs::write(tmp.path().join("demo/pom.xml"), "").unwrap();
    hoist_single_dir(tmp.path()).unwrap();
    assert_eq!(tree(tmp.path()), ["pom.xml"]);
    assert!(tmp.path().join("src").is_dir());
}

#[test]
fn versions_and_ansi() {
    assert!(version_at_least("20.19.1", "20.19"));
    assert!(version_at_least("22.0.0", "20.19"));
    assert!(!version_at_least("20.18.3", "20.19"));
    assert!(version_at_least("0.15.1", "0.14"));
    assert_eq!(strip_ansi("\u{1b}[32m✔\u{1b}[0m done\r"), "✔ done");
    assert_eq!(strip_ansi("\u{1b}]8;;http://x\u{7}link\u{1b}]8;;\u{7}"), "link");
}
