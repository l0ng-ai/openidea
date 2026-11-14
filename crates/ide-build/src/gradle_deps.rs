//! A Gradle project's resolved dependencies for the Dependency Analyzer:
//! `gradle <project>:dependencies --configuration <name>`, parsed from its tree report.

use crate::gradle;
use crate::process;
use crate::sync::{SyncOptions, error_summary};
use ide_core::{CancellationToken, IdeError, IdeResult};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::Path;

/// One line of the report: an occurrence of a dependency where it is requested.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GradleDependency {
    /// `group`, empty for a project dependency.
    pub group: String,
    /// Artifact name, or the project path (`:core`) of a project dependency.
    pub name: String,
    /// The version asked for here; `None` when a platform or constraint supplies it.
    pub requested: Option<String>,
    /// The version Gradle selected (`-> 1.2`), when it differs from the request.
    pub selected: Option<String>,
    /// A project of the build (`project :core`, or a module substituted by one).
    pub project: bool,
    /// `(*)`: listed with its dependencies earlier in the tree.
    pub repeated: bool,
    /// `(c)`: a dependency constraint rather than a dependency.
    pub constraint: bool,
    /// `(n)` / `FAILED`: not resolved.
    pub unresolved: bool,
    pub children: Vec<GradleDependency>,
}

/// Parses the tree of a `dependencies --configuration` report (lines `+--- g:a:1.0 -> 1.1 (*)`).
pub fn parse_report(output: &str) -> Vec<GradleDependency> {
    let mut roots: Vec<GradleDependency> = Vec::new();
    // Path of child indexes from the roots to the last node of each depth.
    let mut path: Vec<usize> = Vec::new();
    for line in output.lines() {
        let Some((depth, text)) = tree_line(line) else { continue };
        let node = parse_entry(text);
        path.truncate(depth);
        if depth > path.len() {
            continue; // A line deeper than its parent allows: not part of a well-formed tree.
        }
        let siblings = if depth == 0 {
            &mut roots
        } else {
            let mut list = &mut roots;
            for &i in &path[..depth - 1] {
                list = &mut list[i].children;
            }
            let Some(parent) = list.get_mut(path[depth - 1]) else { continue };
            &mut parent.children
        };
        siblings.push(node);
        path.push(siblings.len() - 1);
    }
    roots
}

/// `|    \--- g:a:1.0` → (1, "g:a:1.0").
fn tree_line(line: &str) -> Option<(usize, &str)> {
    let mut rest = line;
    let mut depth = 0;
    loop {
        if let Some(r) = rest.strip_prefix("+--- ").or_else(|| rest.strip_prefix("\\--- ")) {
            return Some((depth, r.trim()));
        }
        rest = rest.strip_prefix("|    ").or_else(|| rest.strip_prefix("     "))?;
        depth += 1;
    }
}

fn parse_entry(text: &str) -> GradleDependency {
    let mut d = GradleDependency::default();
    let mut text = text.trim();
    loop {
        if let Some(t) = text.strip_suffix(" (*)") {
            d.repeated = true;
            text = t;
        } else if let Some(t) = text.strip_suffix(" (c)") {
            d.constraint = true;
            text = t;
        } else if let Some(t) = text.strip_suffix(" (n)").or_else(|| text.strip_suffix(" FAILED")) {
            d.unresolved = true;
            text = t;
        } else {
            break;
        }
        text = text.trim_end();
    }
    let (left, right) = match text.split_once(" -> ") {
        Some((l, r)) => (l.trim(), Some(r.trim())),
        None => (text, None),
    };
    if let Some(project) = left.strip_prefix("project ") {
        d.project = true;
        d.name = project_path(project);
    } else {
        let mut parts = left.splitn(3, ':');
        d.group = parts.next().unwrap_or_default().to_owned();
        d.name = parts.next().unwrap_or_default().to_owned();
        d.requested = parts.next().filter(|v| !v.is_empty()).map(str::to_owned);
    }
    if let Some(right) = right {
        if let Some(project) = right.strip_prefix("project ") {
            // A module substituted by a project of the build.
            d.project = true;
            d.selected = Some(project_path(project));
        } else {
            d.selected = Some(right.to_owned());
        }
    }
    d
}

/// `:core`, or `':core'` as Gradle 9 quotes it.
fn project_path(text: &str) -> String {
    let t = text.trim();
    t.strip_prefix('\'').and_then(|t| t.strip_suffix('\'')).unwrap_or(t).to_owned()
}

/// Runs the `dependencies` report of `project` (a Gradle path, `:` for the root) for
/// `configuration` and returns its tree.
pub fn gradle_dependencies(
    root: &Path,
    model: &gradle::GradleModel,
    options: &SyncOptions,
    project: &str,
    configuration: &str,
    cancel: &CancellationToken,
) -> IdeResult<Vec<GradleDependency>> {
    if !configuration.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') || configuration.is_empty() {
        return Err(IdeError::invalid(format!("not a configuration name: {configuration}")));
    }
    if !project.starts_with(':') || project.chars().any(char::is_whitespace) {
        return Err(IdeError::invalid(format!("not a Gradle project path: {project}")));
    }
    let task = if project == ":" { ":dependencies".to_owned() } else { format!("{project}:dependencies") };
    let mut args: Vec<String> =
        vec!["--console=plain".into(), "-q".into(), task, "--configuration".into(), configuration.into()];
    if options.offline {
        args.push("--offline".into());
    }
    let out = process::run(
        options.gradle_command.as_deref().unwrap_or(&model.command),
        &args,
        &root.join(&model.dir),
        &options.env,
        cancel,
        |_, _| {},
    )?;
    if !out.success {
        return Err(IdeError::unavailable(error_summary(&out.text)));
    }
    Ok(parse_report(&out.text))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dep(group: &str, name: &str, requested: Option<&str>) -> GradleDependency {
        GradleDependency {
            group: group.into(),
            name: name.into(),
            requested: requested.map(Into::into),
            ..Default::default()
        }
    }

    #[test]
    fn parses_the_tree_with_selected_versions_and_markers() {
        let report = "\
------------------------------------------------------------
Project ':app'
------------------------------------------------------------

runtimeClasspath - Runtime classpath of source set 'main'.
+--- org.springframework.boot:spring-boot-starter-web -> 3.2.0
|    +--- org.springframework.boot:spring-boot-starter:3.2.0
|    |    \\--- org.yaml:snakeyaml:2.2
|    \\--- com.fasterxml.jackson.core:jackson-databind:2.15.0 -> 2.15.3 (*)
+--- project ':core'
|    \\--- com.google.guava:guava:{strictly 32.1.3-jre} -> 32.1.3-jre (c)
+--- org.example:legacy:1.0 -> project :legacy
\\--- org.missing:gone:9 FAILED

(c) - A dependency constraint, not a dependency. The dependency affected by the constraint occurs elsewhere in the tree.
(*) - Indicates repeated occurrences of a transitive dependency subtree. Gradle expands transitive dependency subtrees only once per project; repeat occurrences only display the root of the subtree, followed by this annotation.
";
        let tree = parse_report(report);
        assert_eq!(tree.len(), 4);
        let web = &tree[0];
        assert_eq!((web.group.as_str(), web.name.as_str()), ("org.springframework.boot", "spring-boot-starter-web"));
        assert_eq!((web.requested.as_deref(), web.selected.as_deref()), (None, Some("3.2.0")));
        assert_eq!(web.children.len(), 2);
        assert_eq!(web.children[0].children, vec![dep("org.yaml", "snakeyaml", Some("2.2"))]);
        let databind = &web.children[1];
        assert_eq!((databind.requested.as_deref(), databind.selected.as_deref()), (Some("2.15.0"), Some("2.15.3")));
        assert!(databind.repeated);
        let core = &tree[1];
        assert!(core.project && core.group.is_empty());
        assert_eq!(core.name, ":core");
        let guava = &core.children[0];
        assert!(guava.constraint);
        assert_eq!(guava.requested.as_deref(), Some("{strictly 32.1.3-jre}"));
        let legacy = &tree[2];
        assert!(legacy.project);
        assert_eq!((legacy.name.as_str(), legacy.selected.as_deref()), ("legacy", Some(":legacy")));
        assert!(tree[3].unresolved);
        assert_eq!(tree[3].requested.as_deref(), Some("9"));
    }

    #[test]
    fn an_empty_configuration_has_no_dependencies() {
        assert!(
            parse_report("compileClasspath - Compile classpath for source set 'main'.\nNo dependencies\n").is_empty()
        );
    }

    #[test]
    fn rejects_names_that_are_not_configurations_or_projects() {
        let tmp = tempfile::tempdir().unwrap();
        let options = SyncOptions::default();
        let cancel = CancellationToken::new();
        assert!(
            gradle_dependencies(tmp.path(), &Default::default(), &options, ":", "x --init-script y", &cancel).is_err()
        );
        assert!(
            gradle_dependencies(tmp.path(), &Default::default(), &options, "app", "runtimeClasspath", &cancel).is_err()
        );
    }

    #[cfg(unix)]
    #[test]
    fn runs_the_report_of_the_project_and_configuration() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::write(root.join("settings.gradle"), "include 'app'").unwrap();
        std::fs::write(root.join("build.gradle"), "").unwrap();
        let launcher = root.join("fake-gradle");
        std::fs::write(&launcher, "#!/bin/sh\necho \"$@\" > args\necho '\\--- org.a:b:1.0'\n").unwrap();
        std::fs::set_permissions(&launcher, std::fs::Permissions::from_mode(0o755)).unwrap();
        let options = SyncOptions {
            gradle_command: Some(launcher.to_string_lossy().into_owned()),
            offline: true,
            ..Default::default()
        };
        let tree = gradle_dependencies(
            root,
            &gradle::load(root).unwrap(),
            &options,
            ":app",
            "testRuntimeClasspath",
            &CancellationToken::new(),
        )
        .unwrap();
        assert_eq!(tree, vec![dep("org.a", "b", Some("1.0"))]);
        assert_eq!(
            std::fs::read_to_string(root.join("args")).unwrap().trim(),
            "--console=plain -q :app:dependencies --configuration testRuntimeClasspath --offline"
        );
    }
}
