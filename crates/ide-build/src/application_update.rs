//! Resource processing by the project's build tool, then publishing to the live JVM's output directory.
use crate::BuildModel;
use ide_core::{IdeError, IdeResult};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

pub struct ResourceBuild {
    pub command: String,
    pub args: Vec<String>,
    pub cwd: String,
    pub env: BTreeMap<String, String>,
    pub kind: &'static str,
}

fn literal(value: &str) -> String {
    format!("'{}'", value.replace('\\', "\\\\").replace('\'', "\\'"))
}

pub fn plan(root: &Path, model: &BuildModel, module: &Path, cache: &Path) -> IdeResult<ResourceBuild> {
    fs::create_dir_all(cache)?;
    let manifest = cache.join("resource-output.txt");
    if manifest.exists() {
        fs::remove_file(&manifest)?;
    }
    let module = dunce::canonicalize(root.join(module))?;
    if let Some(p) = model.maven.as_ref().and_then(|m| m.projects.iter().find(|p| root.join(&p.dir) == module)) {
        let mut args = p.options.clone();
        args.extend([
            "process-resources".into(),
            "help:evaluate".into(),
            "-Dexpression=project.build.outputDirectory".into(),
            format!("-Doutput={}", manifest.display()),
        ]);
        return Ok(ResourceBuild {
            command: p.command.clone(),
            args,
            cwd: p.dir.clone(),
            env: p.env.clone(),
            kind: "maven",
        });
    }
    if let Some(g) = &model.gradle
        && let Some(p) = g.projects.iter().find(|p| root.join(&p.dir) == module)
    {
        let script = cache.join("resources.init.gradle");
        fs::write(
            &script,
            format!(
                r#"gradle.projectsEvaluated {{
    def p = gradle.rootProject.project({})
    def resources = p.tasks.named('processResources')
    p.tasks.register('openideaUpdateResources') {{
        dependsOn resources
        doLast {{ new File({}).setText(resources.get().destinationDir.absolutePath, 'UTF-8') }}
    }}
}}
"#,
                literal(&p.path),
                literal(&manifest.to_string_lossy())
            ),
        )?;
        return Ok(ResourceBuild {
            command: g.command.clone(),
            args: vec![
                "--init-script".into(),
                script.to_string_lossy().into_owned(),
                format!("{}:openideaUpdateResources", p.path.trim_end_matches(':')),
            ],
            cwd: g.dir.clone(),
            env: g.env.clone(),
            kind: "gradle",
        });
    }
    Err(IdeError::invalid("The Spring Boot module must belong to a linked Maven or Gradle build"))
}

pub fn publish(root: &Path, cache: &Path, class_paths: &[String], main_class: &str) -> IdeResult<()> {
    let output = PathBuf::from(fs::read_to_string(cache.join("resource-output.txt"))?.trim());
    if !output.is_absolute() || !output.is_dir() {
        return Err(IdeError::invalid("The resource build did not report an output directory"));
    }
    let output = dunce::canonicalize(output)?;
    let paths: Vec<_> = class_paths.iter().filter_map(|p| dunce::canonicalize(root.join(p)).ok()).collect();
    // A separate resource directory is already on the runtime classpath (e.g. build/resources/main).
    if paths.contains(&output) {
        return Ok(());
    }
    // jdtls uses bin/main for Gradle, rather than Gradle's build/resources/main.
    let class_file = main_class.split('.').collect::<PathBuf>().with_extension("class");
    let destination = paths.iter().find(|p| p.join(&class_file).is_file()).ok_or_else(|| {
        IdeError::invalid("Cannot find the running main class output directory; restart the application")
    })?;
    let previous: Vec<String> = fs::read(cache.join("published-resources.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default();
    let mut current = Vec::new();
    copy_resources(&output, &output, destination, &mut current)?;
    for rel in previous.iter().filter(|p| !current.contains(p)) {
        let path = destination.join(rel);
        if path.is_file() {
            fs::remove_file(path)?;
        }
    }
    fs::write(
        cache.join("published-resources.json"),
        serde_json::to_vec(&current).map_err(|e| IdeError::internal(e.to_string()))?,
    )?;
    Ok(())
}

fn copy_resources(root: &Path, from: &Path, to: &Path, copied: &mut Vec<String>) -> IdeResult<()> {
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let path = entry.path();
        let kind = entry.file_type()?;
        if kind.is_symlink() {
            continue;
        }
        if kind.is_dir() {
            copy_resources(root, &path, to, copied)?;
        } else if kind.is_file() && path.extension().is_none_or(|e| e != "class") {
            let rel = path.strip_prefix(root).map_err(|e| IdeError::internal(e.to_string()))?;
            let dest = to.join(rel);
            if let Some(parent) = dest.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::copy(&path, dest)?;
            copied.push(rel.to_string_lossy().into_owned());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resource_plans_use_the_selected_module_and_build_configuration() {
        let tmp = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(tmp.path()).unwrap();
        fs::create_dir(root.join("app")).unwrap();
        let mut model = BuildModel {
            maven: Some(crate::MavenModel {
                projects: vec![crate::MavenProject {
                    dir: "app".into(),
                    command: "/tools/mvnw".into(),
                    options: vec!["-Pdev".into()],
                    env: BTreeMap::from([("JAVA_HOME".into(), "/jdk".into())]),
                    ..Default::default()
                }],
                ..Default::default()
            }),
            ..Default::default()
        };
        let cache = root.join("cache");
        let maven = plan(&root, &model, Path::new("app"), &cache).unwrap();
        assert_eq!(maven.command, "/tools/mvnw");
        assert_eq!(maven.cwd, "app");
        assert_eq!(maven.args[0..2], ["-Pdev", "process-resources"]);
        assert!(maven.args.contains(&"-Dexpression=project.build.outputDirectory".into()));
        assert_eq!(maven.env["JAVA_HOME"], "/jdk");
        model.maven = None;
        model.gradle = Some(crate::GradleModel {
            command: "/tools/gradlew".into(),
            projects: vec![crate::GradleProject { path: ":app".into(), dir: "app".into(), ..Default::default() }],
            ..Default::default()
        });
        let gradle = plan(&root, &model, Path::new("app"), &cache).unwrap();
        assert_eq!(gradle.command, "/tools/gradlew");
        assert_eq!(gradle.args.last().unwrap(), ":app:openideaUpdateResources");
        let script = fs::read_to_string(cache.join("resources.init.gradle")).unwrap();
        assert!(script.contains("processResources") && script.contains("destinationDir.absolutePath"));
        assert!(!script.contains("build/resources/main")); // The task owns custom output locations.
    }

    #[test]
    fn publishes_maven_and_gradle_resource_outputs_to_the_runtime_classpath() {
        for layout in ["target/classes", "build/resources/main", "custom resource output"] {
            let tmp = tempfile::tempdir().unwrap();
            let root = tmp.path();
            let cache = root.join("cache");
            let output = root.join(layout);
            let runtime = if layout == "target/classes" { output.clone() } else { root.join("bin/main") };
            fs::create_dir_all(output.join("static")).unwrap();
            fs::create_dir_all(runtime.join("example")).unwrap();
            fs::create_dir_all(&cache).unwrap();
            fs::write(cache.join("resource-output.txt"), output.to_string_lossy().as_bytes()).unwrap();
            fs::write(output.join("static/index.html"), "after").unwrap();
            fs::write(output.join("unrelated.class"), "do not publish").unwrap();
            fs::write(runtime.join("example/Application.class"), "running").unwrap();
            publish(root, &cache, &[runtime.to_string_lossy().into_owned()], "example.Application").unwrap();
            assert_eq!(fs::read_to_string(runtime.join("static/index.html")).unwrap(), "after");
            assert_eq!(fs::read_to_string(runtime.join("example/Application.class")).unwrap(), "running");
            if output != runtime {
                assert!(!runtime.join("unrelated.class").exists());
                fs::remove_file(output.join("static/index.html")).unwrap();
                publish(root, &cache, &[runtime.to_string_lossy().into_owned()], "example.Application").unwrap();
                assert!(!runtime.join("static/index.html").exists());
            }
        }
    }

    #[test]
    fn leaves_separate_runtime_resource_directories_in_place_and_rejects_jar_only_runs() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let output = root.join("build/resources/main");
        let cache = root.join("cache");
        fs::create_dir_all(&output).unwrap();
        fs::create_dir(&cache).unwrap();
        fs::write(cache.join("resource-output.txt"), output.to_string_lossy().as_bytes()).unwrap();
        publish(root, &cache, &[output.to_string_lossy().into_owned()], "a.Main").unwrap();
        assert!(publish(root, &cache, &["app.jar".into()], "a.Main").is_err());
    }
}
