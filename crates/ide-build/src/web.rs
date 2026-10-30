//! WAR modules and build-tool-owned archive resolution (including custom output names).
use crate::BuildModel;
use ide_core::{IdeError, IdeResult};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::{collections::BTreeMap, fs, path::Path};

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WebArtifact {
    pub id: String,
    pub name: String,
    pub module: String,
    pub tool: String,
}

pub fn artifacts(root: &Path, model: &BuildModel) -> Vec<WebArtifact> {
    let mut out = Vec::new();
    if let Some(maven) = &model.maven {
        for p in maven.projects.iter().filter(|p| p.packaging == "war") {
            out.push(WebArtifact {
                id: format!("maven:{}", p.pom),
                name: p.artifact_id.clone(),
                module: p.dir.clone(),
                tool: "maven".into(),
            });
        }
    }
    if let Some(gradle) = &model.gradle {
        for p in &gradle.projects {
            let script = p.build_file.as_ref().and_then(|f| fs::read_to_string(root.join(f)).ok()).unwrap_or_default();
            if p.tasks.iter().any(|t| t.name == "war") || crate::gradle::has_war_plugin(&script) {
                out.push(WebArtifact {
                    id: format!("gradle:{}", p.path),
                    name: p.name.clone(),
                    module: p.dir.clone(),
                    tool: "gradle".into(),
                });
            }
        }
    }
    out
}

pub struct WebBuild {
    pub command: String,
    pub args: Vec<String>,
    pub cwd: String,
    pub env: BTreeMap<String, String>,
}

pub fn build(root: &Path, model: &BuildModel, id: &str, cache: &Path) -> IdeResult<WebBuild> {
    fs::create_dir_all(cache)?;
    let manifest = cache.join("artifact-path.txt");
    // A failed build must never silently reuse an older archive manifest.
    if manifest.exists() {
        fs::remove_file(&manifest)?;
    }
    fs::write(cache.join("artifact-id.txt"), id)?;
    if let Some(pom) = id.strip_prefix("maven:") {
        let p = model
            .maven
            .as_ref()
            .and_then(|m| m.projects.iter().find(|p| p.pom == pom && p.packaging == "war"))
            .ok_or_else(|| IdeError::invalid("Choose a Maven WAR module"))?;
        let projects = &model.maven.as_ref().unwrap().projects;
        let top = projects
            .iter()
            .filter(|t| {
                !t.aggregated && (t.dir.is_empty() || p.dir == t.dir || p.dir.starts_with(&format!("{}/", t.dir)))
            })
            .max_by_key(|t| t.dir.len())
            .unwrap_or(p);
        let mut args = top.options.clone();
        if top.pom != p.pom {
            let module = root
                .join(&p.dir)
                .strip_prefix(root.join(&top.dir))
                .map_err(|e| IdeError::invalid(e.to_string()))?
                .to_string_lossy()
                .replace('\\', "/");
            args.extend(["-pl".into(), module, "-am".into()]);
        }
        args.extend([
            "-DskipTests".into(),
            "package".into(),
            "help:evaluate".into(),
            "-Dexpression=project.artifact.file".into(),
            format!("-Doutput={}", manifest.display()),
        ]);
        return Ok(WebBuild { command: top.command.clone(), args, cwd: top.dir.clone(), env: p.env.clone() });
    }
    if let Some(path) = id.strip_prefix("gradle:") {
        let g = model.gradle.as_ref().ok_or_else(|| IdeError::invalid("Choose a Gradle WAR module"))?;
        if !artifacts(root, model).iter().any(|a| a.id == id) {
            return Err(IdeError::invalid("Choose a Gradle WAR module"));
        }
        let literal = |s: &str| format!("'{}'", s.replace('\\', "\\\\").replace('\'', "\\'"));
        let script = cache.join("war.init.gradle");
        fs::write(
            &script,
            format!(
                r#"gradle.projectsEvaluated {{
    def p = gradle.rootProject.project({})
    def warTask = p.tasks.named('war')
    p.tasks.register('openideaTomcatArtifact') {{
        dependsOn warTask
        doLast {{ new File({}).text = warTask.get().archiveFile.get().asFile.absolutePath }}
    }}
}}
"#,
                literal(path),
                literal(&manifest.to_string_lossy())
            ),
        )?;
        let task = format!("{}:openideaTomcatArtifact", path.trim_end_matches(':'));
        return Ok(WebBuild {
            command: g.command.clone(),
            args: vec!["--init-script".into(), script.to_string_lossy().into_owned(), task],
            cwd: g.dir.clone(),
            env: g.env.clone(),
        });
    }
    Err(IdeError::invalid("Choose a WAR artifact"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn maven_war_modules_use_resolved_artifact_file() {
        let tmp = tempfile::tempdir().unwrap();
        fs::write(tmp.path().join("pom.xml"), "<project><modelVersion>4.0.0</modelVersion><groupId>test</groupId><artifactId>web</artifactId><version>1</version><packaging>war</packaging><build><directory>custom</directory><finalName>renamed</finalName></build></project>").unwrap();
        let model = crate::load(tmp.path(), &tmp.path().join("cache"), None);
        let a = artifacts(tmp.path(), &model);
        assert_eq!(a.len(), 1);
        assert_eq!(a[0].name, "web");
        let plan = build(tmp.path(), &model, &a[0].id, &tmp.path().join("base with spaces")).unwrap();
        assert!(plan.args.contains(&"-Dexpression=project.artifact.file".into()));
        assert!(plan.args.iter().any(|a| a.ends_with("base with spaces/artifact-path.txt")));
    }
    #[test]
    fn maven_module_build_includes_reactor_dependencies() {
        let tmp = tempfile::tempdir().unwrap();
        fs::create_dir_all(tmp.path().join("web")).unwrap();
        fs::write(tmp.path().join("pom.xml"), "<project><groupId>test</groupId><artifactId>parent</artifactId><version>1</version><packaging>pom</packaging><modules><module>web</module></modules></project>").unwrap();
        fs::write(tmp.path().join("web/pom.xml"), "<project><parent><groupId>test</groupId><artifactId>parent</artifactId><version>1</version></parent><artifactId>web</artifactId><packaging>war</packaging></project>").unwrap();
        let model = crate::load(tmp.path(), &tmp.path().join("cache"), None);
        let plan = build(tmp.path(), &model, "maven:web/pom.xml", &tmp.path().join("base")).unwrap();
        assert_eq!(plan.cwd, "");
        assert_eq!(&plan.args[..3], &["-pl", "web", "-am"]);
    }
    #[test]
    fn gradle_war_uses_archive_provider_and_ignores_comments() {
        let tmp = tempfile::tempdir().unwrap();
        fs::write(
            tmp.path().join("build.gradle.kts"),
            "plugins { war }\ntasks.war { archiveFileName.set(\"custom.war\") }",
        )
        .unwrap();
        let model = crate::load(tmp.path(), &tmp.path().join("cache"), None);
        let a = artifacts(tmp.path(), &model);
        assert_eq!(a.len(), 1);
        let plan = build(tmp.path(), &model, &a[0].id, &tmp.path().join("base")).unwrap();
        assert!(plan.args.contains(&":openideaTomcatArtifact".into()));
        assert!(fs::read_to_string(tmp.path().join("base/war.init.gradle")).unwrap().contains("archiveFile.get()"));
        assert!(!crate::gradle::has_war_plugin("// plugins { war }"));
    }
}
