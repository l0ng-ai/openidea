//! Private Maven builds for JDT's Kotlin binary libraries. Never use launch outputs.

use crate::BuildModel;
use crate::compile::{self, BuildEvent, BuildKind, BuildMessage};
use ide_core::{CancellationToken, IdeError, IdeResult};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Module {
    key: String,
    project_uri: String,
    output: PathBuf,
    test_output: Option<PathBuf>,
    dependencies: Vec<Dependency>,
    has_kotlin: bool,
    kotlin_goals: Vec<KotlinGoal>,
}

#[derive(Clone, Debug, Deserialize)]
struct KotlinGoal {
    execution: String,
    status: String,
}

#[derive(Clone, Debug, Deserialize)]
struct Dependency {
    key: String,
    scope: String,
    #[serde(rename = "type")]
    kind: Option<String>,
    classifier: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct Library {
    pub path: PathBuf,
    pub test: bool,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectLibraries {
    pub project_uri: String,
    pub libraries: Vec<Library>,
}

pub struct Outcome {
    pub projects: Vec<ProjectLibraries>,
    pub messages: Vec<BuildMessage>,
    pub success: bool,
}

/// Inspect sources, excluding generated/build/VCS trees and never following symlinks.
pub fn has_kotlin(root: &Path) -> bool {
    let Ok(entries) = std::fs::read_dir(root) else { return false };
    entries.flatten().any(|entry| {
        let Ok(kind) = entry.file_type() else { return false };
        if kind.is_file() {
            entry.path().extension().is_some_and(|e| e == "kt")
        } else {
            kind.is_dir()
                && !matches!(
                    entry.file_name().to_str(),
                    Some("target" | "build" | "out" | "bin" | "node_modules" | ".git" | ".openidea")
                )
                && has_kotlin(&entry.path())
        }
    })
}

/// Run the project's configured wrapper/settings/JDK and lifecycle, with an output
/// redirector loaded before Maven calculates its lifecycle execution plans.
pub fn build(
    root: &Path,
    model: &BuildModel,
    bundle: &Path,
    generation: &Path,
    cancel: &CancellationToken,
) -> IdeResult<Outcome> {
    std::fs::create_dir_all(generation)?;
    let mut plan = compile::plan(root, model, BuildKind::Build, None)?;
    if plan.system != compile::BuildSystem::Maven {
        return Err(IdeError::invalid("Kotlin bridge requires a Maven build root"));
    }
    let mut manifests = Vec::new();
    for (index, step) in plan.steps.iter_mut().enumerate() {
        step.args.push("--fail-at-end".into());
        let directory = generation.join(format!("reactor-{index}"));
        std::fs::create_dir_all(&directory)?;
        manifests.push(directory.join("modules.json"));
        let mut extensions = vec![bundle.to_path_buf()];
        step.args.retain(|arg| {
            if let Some(value) = arg.strip_prefix("-Dmaven.ext.class.path=") {
                extensions.extend(std::env::split_paths(value));
                false
            } else {
                true
            }
        });
        let extension_path = std::env::join_paths(extensions).map_err(|e| IdeError::invalid(e.to_string()))?;
        step.args.push(format!("-Dmaven.ext.class.path={}", extension_path.to_string_lossy()));
        step.args.push(format!("-Dopenidea.kotlin.staging={}", directory.join("staging").display()));
    }
    let mut messages = Vec::new();
    // Independent linked reactors must still run after another reactor's javac fails.
    for step in &plan.steps {
        let mut reactor = plan.clone();
        reactor.steps = vec![step.clone()];
        let result = compile::run(root, &reactor, cancel, &|event| {
            if let BuildEvent::Output { text, .. } = event {
                tracing::debug!("kotlin bridge: {}", text.trim_end());
            }
        })?;
        messages.extend(result.messages);
    }
    // javac diagnostics belong to JDT, including when a Kotlin target was skipped.
    messages.retain(|message| {
        message.path.as_ref().is_some_and(|path| PathBuf::from(path.clone()).extension().is_some_and(|e| e == "kt"))
    });
    let mut modules = Vec::new();
    for manifest in manifests {
        let parsed: Vec<Module> = serde_json::from_slice(&std::fs::read(manifest)?)
            .map_err(|e| IdeError::internal(format!("Kotlin module manifest: {e}")))?;
        modules.extend(parsed);
    }
    messages.extend(kotlin_failures(&modules));
    if messages.iter().any(|message| message.severity == ide_core::Severity::Error) {
        return Ok(Outcome { projects: Vec::new(), messages, success: false });
    }
    let pending = generation.join("libraries.pending");
    let published = generation.join("libraries");
    std::fs::create_dir_all(&pending)?;
    let mut libraries = BTreeMap::new();
    for (index, module) in modules.iter().enumerate() {
        let mut outputs = ModuleLibraries::default();
        for (source, target, name) in [
            (Some(&module.output), &mut outputs.main, format!("main-{index}")),
            (module.test_output.as_ref(), &mut outputs.test, format!("test-{index}")),
        ] {
            let Some(source) = source else { continue };
            if !source.starts_with(generation) {
                return Err(IdeError::internal("Kotlin build output escaped staging"));
            }
            if copy_kotlin(source, &pending.join(&name), cancel)? {
                *target = Some(published.join(name));
            }
        }
        libraries.insert(module.key.clone(), outputs);
    }
    publish(&pending, &published, cancel)?;
    Ok(Outcome { projects: consumers(&modules, &libraries), messages, success: true })
}

fn kotlin_failures(modules: &[Module]) -> Vec<BuildMessage> {
    let mut messages = Vec::new();
    for module in modules {
        if !module.has_kotlin {
            continue;
        }
        if module.kotlin_goals.is_empty() {
            messages.push(kotlin_failure(module, "compile target was not executed"));
        }
        for goal in &module.kotlin_goals {
            if goal.status != "success" {
                messages.push(kotlin_failure(module, &format!("{} {}", goal.execution, goal.status)));
            }
        }
    }
    messages
}

fn kotlin_failure(module: &Module, reason: &str) -> BuildMessage {
    BuildMessage {
        severity: ide_core::Severity::Error,
        text: format!("Kotlin compilation for {}: {reason}", module.key),
        path: None,
        range: None,
        code: None,
    }
}

fn publish(pending: &Path, published: &Path, cancel: &CancellationToken) -> IdeResult<()> {
    if cancel.is_cancelled() {
        return Err(IdeError::cancelled());
    }
    std::fs::rename(pending, published)?;
    Ok(())
}

#[derive(Default)]
struct ModuleLibraries {
    main: Option<PathBuf>,
    test: Option<PathBuf>,
}

fn consumers(modules: &[Module], libraries: &BTreeMap<String, ModuleLibraries>) -> Vec<ProjectLibraries> {
    modules
        .iter()
        .map(|consumer| {
            let mut visible = Vec::<Library>::new();
            let mut add = |path: &Option<PathBuf>, test: bool| {
                if let Some(path) = path {
                    if let Some(previous) = visible.iter_mut().find(|entry| &entry.path == path) {
                        previous.test &= test;
                    } else {
                        visible.push(Library { path: path.clone(), test });
                    }
                }
            };
            if let Some(own) = libraries.get(&consumer.key) {
                add(&own.test, true);
                add(&own.main, false);
            }
            // Maven's resolved artifacts already apply exclusions, mediation and optional
            // propagation. Preserve their classpath order, after the module's own output.
            for dependency in &consumer.dependencies {
                let Some(output) = libraries.get(&dependency.key) else { continue };
                let test = match dependency.scope.as_str() {
                    "compile" | "provided" | "system" | "" => false,
                    "test" | "runtime" => true,
                    _ => continue,
                };
                match (dependency.kind.as_deref(), dependency.classifier.as_deref()) {
                    (Some("test-jar"), None | Some("tests")) | (Some("jar"), Some("tests")) => add(&output.test, test),
                    (None | Some("jar"), None | Some("")) => add(&output.main, test),
                    _ => {}
                }
            }
            ProjectLibraries { project_uri: consumer.project_uri.clone(), libraries: visible }
        })
        .collect()
}

fn copy_kotlin(source: &Path, destination: &Path, cancel: &CancellationToken) -> IdeResult<bool> {
    let Ok(entries) = std::fs::read_dir(source) else { return Ok(false) };
    let mut found = false;
    for entry in entries {
        if cancel.is_cancelled() {
            return Err(IdeError::cancelled());
        }
        let entry = entry?;
        let kind = entry.file_type()?;
        let path = entry.path();
        let output = destination.join(entry.file_name());
        if kind.is_dir() {
            found |= copy_kotlin(&path, &output, cancel)?;
        } else if kind.is_file() {
            let bytes = std::fs::read(&path)?;
            let class = path.extension().is_some_and(|e| e == "class");
            let metadata = path.extension().is_some_and(|e| e == "kotlin_module");
            if metadata || (class && kotlin_class(&bytes).unwrap_or(false)) {
                std::fs::create_dir_all(destination)?;
                std::fs::write(output, bytes)?;
                found |= class;
            }
        }
    }
    Ok(found)
}

/// Read the actual class-level SourceFile attribute, rather than searching strings
/// (a Java constant containing "Something.kt" must never become a Kotlin library).
fn kotlin_class(bytes: &[u8]) -> Option<bool> {
    struct Reader<'a> {
        bytes: &'a [u8],
        pos: usize,
    }
    impl<'a> Reader<'a> {
        fn take(&mut self, count: usize) -> Option<&'a [u8]> {
            let value = self.bytes.get(self.pos..self.pos.checked_add(count)?)?;
            self.pos += count;
            Some(value)
        }
        fn u2(&mut self) -> Option<usize> {
            Some(u16::from_be_bytes(self.take(2)?.try_into().ok()?) as usize)
        }
        fn u4(&mut self) -> Option<usize> {
            Some(u32::from_be_bytes(self.take(4)?.try_into().ok()?) as usize)
        }
        fn attributes(&mut self) -> Option<()> {
            for _ in 0..self.u2()? {
                self.u2()?;
                let n = self.u4()?;
                self.take(n)?;
            }
            Some(())
        }
    }
    let mut reader = Reader { bytes, pos: 0 };
    if reader.take(4)? != [0xca, 0xfe, 0xba, 0xbe] {
        return None;
    }
    reader.take(4)?;
    let count = reader.u2()?;
    let mut utf8 = BTreeMap::new();
    let mut index = 1;
    while index < count {
        match reader.take(1)?[0] {
            1 => {
                let n = reader.u2()?;
                utf8.insert(index, reader.take(n)?);
            }
            3 | 4 | 9..=12 | 17 | 18 => {
                reader.take(4)?;
            }
            5 | 6 => {
                reader.take(8)?;
                index += 1;
            }
            7 | 8 | 16 | 19 | 20 => {
                reader.take(2)?;
            }
            15 => {
                reader.take(3)?;
            }
            _ => return None,
        }
        index += 1;
    }
    reader.take(6)?;
    let interfaces = reader.u2()?;
    reader.take(interfaces.checked_mul(2)?)?;
    for _ in 0..2 {
        for _ in 0..reader.u2()? {
            reader.take(6)?;
            reader.attributes()?;
        }
    }
    for _ in 0..reader.u2()? {
        let name = reader.u2()?;
        let length = reader.u4()?;
        if utf8.get(&name).copied() == Some(b"SourceFile".as_slice()) && length == 2 {
            let source = reader.u2()?;
            return Some(utf8.get(&source)?.ends_with(b".kt"));
        }
        reader.take(length)?;
    }
    Some(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_kotlin_target_must_succeed_even_when_maven_fails_elsewhere() {
        let mut modules: Vec<Module> = serde_json::from_str(r#"[
            {"key":"lib","projectUri":"lib","output":"lib","dependencies":[],"hasKotlin":true,
             "kotlinGoals":[{"execution":"main:compile","status":"success"},{"execution":"test:test-compile","status":"success"}]},
            {"key":"java","projectUri":"java","output":"java","dependencies":[],"hasKotlin":false,"kotlinGoals":[]}
        ]"#).unwrap();
        assert!(kotlin_failures(&modules).is_empty());
        for status in ["failed", "skipped"] {
            modules[0].kotlin_goals[1].status = status.into();
            let failures = kotlin_failures(&modules);
            assert_eq!(failures.len(), 1);
            assert!(failures[0].text.contains(&format!("test:test-compile {status}")));
        }
        modules[0].kotlin_goals.clear();
        assert_eq!(kotlin_failures(&modules).len(), 1);
        modules[0].has_kotlin = false;
        assert!(kotlin_failures(&modules).is_empty());
        assert!(
            serde_json::from_str::<Vec<Module>>(
                r#"[{"key":"old","projectUri":"old","output":"old","dependencies":[]}]"#
            )
            .is_err()
        );
    }

    #[test]
    fn respects_mavens_resolved_closure_and_scopes() {
        let json = r#"[
          {"key":"zapp","projectUri":"app","output":"app", "hasKotlin":false,"kotlinGoals":[],"dependencies":[{"key":"mid","scope":"compile","optional":false},{"key":"lib","scope":"compile","optional":false}]},
          {"key":"mid","projectUri":"mid","output":"mid", "hasKotlin":false,"kotlinGoals":[],"dependencies":[
            {"key":"lib","scope":"compile","optional":false},
            {"key":"optional","scope":"compile","optional":true},
            {"key":"test","scope":"test","optional":false},
            {"key":"provided","scope":"provided","optional":false}]},
          {"key":"lib","projectUri":"lib","output":"lib","hasKotlin":false,"kotlinGoals":[],"dependencies":[]}
        ]"#;
        let modules: Vec<Module> = serde_json::from_str(json).unwrap();
        let libraries = ["zapp", "lib", "optional", "test", "provided"]
            .into_iter()
            .map(|key| (key.to_owned(), ModuleLibraries { main: Some(PathBuf::from(key)), test: None }))
            .collect();
        let result = consumers(&modules, &libraries);
        assert_eq!(
            result[0].libraries,
            vec![Library { path: "zapp".into(), test: false }, Library { path: "lib".into(), test: false },]
        );
        assert_eq!(result[1].libraries.len(), 4);
        assert!(result[1].libraries.iter().find(|l| l.path == Path::new("test")).unwrap().test);
    }

    #[test]
    fn test_outputs_are_private_unless_maven_resolves_a_test_jar() {
        let modules: Vec<Module> = serde_json::from_str(r#"[
          {"key":"lib","projectUri":"lib","output":"lib","hasKotlin":false,"kotlinGoals":[],"dependencies":[]},
          {"key":"app","projectUri":"app","output":"app","hasKotlin":false,"kotlinGoals":[],"dependencies":[{"key":"lib","scope":"compile","type":"jar","classifier":null}]},
          {"key":"test-app","projectUri":"test-app","output":"app","hasKotlin":false,"kotlinGoals":[],"dependencies":[{"key":"lib","scope":"test","type":"test-jar","classifier":"tests"}]}
        ]"#).unwrap();
        let libraries =
            BTreeMap::from([("lib".into(), ModuleLibraries { main: Some("main".into()), test: Some("test".into()) })]);
        let result = consumers(&modules, &libraries);
        assert_eq!(
            result[0].libraries,
            vec![Library { path: "test".into(), test: true }, Library { path: "main".into(), test: false }]
        );
        assert_eq!(result[1].libraries, vec![Library { path: "main".into(), test: false }]);
        assert_eq!(result[2].libraries, vec![Library { path: "test".into(), test: true }]);
    }

    #[test]
    fn publishes_complete_directories_and_cancellation_keeps_them_private() {
        let directory = tempfile::tempdir().unwrap();
        let pending = directory.path().join("pending");
        let final_path = directory.path().join("published");
        std::fs::create_dir(&pending).unwrap();
        std::fs::write(pending.join("Channel.class"), "complete").unwrap();
        let cancelled = CancellationToken::new();
        cancelled.cancel();
        assert!(publish(&pending, &final_path, &cancelled).is_err());
        assert!(!final_path.exists());
        assert!(pending.exists());
        publish(&pending, &final_path, &CancellationToken::new()).unwrap();
        assert!(!pending.exists());
        assert_eq!(std::fs::read(final_path.join("Channel.class")).unwrap(), b"complete");
    }

    #[test]
    fn never_runs_another_build_system_with_maven_output_properties() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(directory.path().join("Cargo.toml"), "").unwrap();
        let error = build(
            directory.path(),
            &BuildModel::default(),
            Path::new("unused.jar"),
            &directory.path().join("private"),
            &CancellationToken::new(),
        )
        .err()
        .unwrap();
        assert_eq!(error.message, "Kotlin bridge requires a Maven build root");
    }

    #[test]
    fn does_not_find_deleted_sources_in_build_outputs() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("target/generated")).unwrap();
        std::fs::write(dir.path().join("target/generated/Old.kt"), "").unwrap();
        assert!(!has_kotlin(dir.path()));
        std::fs::write(dir.path().join("New.kt"), "").unwrap();
        assert!(has_kotlin(dir.path()));
    }

    #[test]
    fn parses_sourcefile_and_rejects_truncated_classes() {
        let mut class = vec![0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 52, 0, 3, 1, 0, 10];
        class.extend_from_slice(b"SourceFile");
        class.extend_from_slice(&[1, 0, 10]);
        class.extend_from_slice(b"Channel.kt");
        class.extend_from_slice(&[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 2, 0, 2]);
        assert_eq!(kotlin_class(&class), Some(true));
        for end in 0..class.len() {
            assert!(kotlin_class(&class[..end]).is_none());
        }
        let offset = 26;
        class[offset..offset + 10].copy_from_slice(b"Other.java");
        assert_eq!(kotlin_class(&class), Some(false));
    }
}
