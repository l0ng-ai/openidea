//! A Maven module's Surefire configuration, for test runs OpenIDEA starts itself instead of
//! Surefire (IDEA's `MavenJUnitPatcher`): what the forked test JVM would get from the POM.
//!
//! Read from the effective POM the last sync cached (Maven merged parents, profiles and
//! `pluginManagement` there), else from the module's own `pom.xml` and its `<properties>`.

use crate::maven::{MavenModel, interpolate};
use crate::xml::{self, Element};
use std::collections::{BTreeMap, HashMap};
use std::path::Path;

const SUREFIRE: &str = "maven-surefire-plugin";

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SurefireConfig {
    /// `<argLine>`, split into JVM options.
    pub arg_line: Vec<String>,
    /// `<systemPropertyVariables>` and the older `<systemProperties>`.
    pub system_properties: BTreeMap<String, String>,
    /// `<environmentVariables>`.
    pub environment: BTreeMap<String, String>,
    pub working_directory: Option<String>,
    /// `<additionalClasspathElements>`.
    pub additional_classpath: Vec<String>,
    /// `<classpathDependencyExcludes>`: `groupId:artifactId`.
    pub classpath_excludes: Vec<String>,
}

/// The Surefire configuration of the Maven module at `module` (absolute), if it is one.
pub fn surefire_config(root: &Path, cache_dir: &Path, model: &MavenModel, module: &Path) -> Option<SurefireConfig> {
    let same = |a: &Path, b: &Path| dunce::canonicalize(a).ok() == dunce::canonicalize(b).ok();
    let project = model.projects.iter().find(|p| same(&root.join(&p.dir), module))?;
    let pom = root.join(&project.pom);
    let modified = |p: &Path| std::fs::metadata(p).and_then(|m| m.modified()).ok();
    // A cache written before the POM last changed would apply an old configuration.
    let effective = std::fs::read_dir(cache_dir).ok()?.flatten().map(|e| e.path()).find_map(|path| {
        let name = path.file_name()?.to_str()?;
        if !(name.starts_with("effective-pom-") && name.ends_with(".xml")) || modified(&path) < modified(&pom) {
            return None;
        }
        let root = xml::parse(&xml::read_text(&path)?)?;
        let projects: Vec<Element> = if root.name == "projects" {
            root.children.into_iter().filter(|p| p.name == "project").collect()
        } else {
            vec![root]
        };
        projects.into_iter().find(|p| {
            let group = p.text_of("groupId").or_else(|| p.at("parent/groupId").map(|g| g.text.trim().to_owned()));
            group.as_deref() == Some(project.group_id.as_str())
                && p.text_of("artifactId").as_deref() == Some(&project.artifact_id)
        })
    });
    let (element, own) = match effective {
        Some(e) => (e, false),
        // ponytail: without a sync, inherited configuration and parent properties are missing; Reload adds them.
        None => (xml::parse(&xml::read_text(&pom)?)?, true),
    };
    let mut props: HashMap<String, String> = element
        .child("properties")
        .map(|p| p.children.iter().map(|c| (c.name.clone(), c.text.trim().to_owned())).collect())
        .unwrap_or_default();
    let dir = module.to_string_lossy().into_owned();
    for (key, value) in [
        ("basedir", dir.clone()),
        ("project.basedir", dir.clone()),
        ("project.build.directory", format!("{dir}/target")),
        ("project.groupId", project.group_id.clone()),
        ("project.artifactId", project.artifact_id.clone()),
        ("project.version", project.version.clone()),
    ] {
        props.entry(key.into()).or_insert(value);
    }
    Some(read(&element, &props, own))
}

/// `<build><plugins>` Surefire's configuration, then its `default-test` execution's.
fn read(project: &Element, props: &HashMap<String, String>, own: bool) -> SurefireConfig {
    let is_surefire = |p: &&Element| p.text_of("artifactId").as_deref() == Some(SUREFIRE);
    let mut plugins: Vec<&Element> = project.list("build/plugins", "plugin").into_iter().filter(is_surefire).collect();
    if own && plugins.is_empty() {
        plugins = project.list("build/pluginManagement/plugins", "plugin").into_iter().filter(is_surefire).collect();
    }
    let mut configurations: Vec<&Element> = Vec::new();
    for plugin in plugins {
        configurations.extend(plugin.child("configuration"));
        let default_test = plugin
            .list("executions", "execution")
            .into_iter()
            .find(|e| e.text_of("id").as_deref() == Some("default-test"));
        configurations.extend(default_test.and_then(|e| e.child("configuration")));
    }
    let value = |text: &str| resolve(text.trim(), props);
    let mut config = SurefireConfig::default();
    for c in configurations {
        if let Some(arg_line) = c.child("argLine") {
            config.arg_line = split_arg_line(&value(&arg_line.text));
        }
        for p in c.child("systemPropertyVariables").map_or(&[][..], |p| &p.children) {
            config.system_properties.insert(p.name.clone(), value(&p.text));
        }
        // `<systemProperties>`: `<property><name/><value/></property>` (deprecated, still honoured).
        for p in c.list("systemProperties", "property") {
            if let Some(name) = p.text_of("name") {
                config.system_properties.insert(name, value(&p.text_of("value").unwrap_or_default()));
            }
        }
        for e in c.child("environmentVariables").map_or(&[][..], |e| &e.children) {
            config.environment.insert(e.name.clone(), value(&e.text));
        }
        if let Some(dir) = c.text_of("workingDirectory").map(|d| value(&d)).filter(|d| !d.is_empty()) {
            config.working_directory = Some(dir);
        }
        let texts = |list: &str, item: &str| -> Vec<String> {
            c.list(list, item).into_iter().map(|e| value(&e.text)).filter(|t| !t.is_empty()).collect()
        };
        config.additional_classpath.extend(texts("additionalClasspathElements", "additionalClasspathElement"));
        config.classpath_excludes.extend(texts("classpathDependencyExcludes", "classpathDependencyExclude"));
    }
    config
}

/// `${…}` from the POM's properties, then Surefire's late replacement `@{…}` (a property a plugin
/// sets during the build, such as JaCoCo's `argLine`, is unknown here and left out, as in IDEA).
fn resolve(text: &str, props: &HashMap<String, String>) -> String {
    let mut out = interpolate(text, props);
    for open in ["@{", "${"] {
        while let Some(start) = out.find(open) {
            let Some(len) = out[start..].find('}') else { break };
            let key = &out[start + 2..start + len];
            let replacement = if open == "@{" { props.get(key).cloned().unwrap_or_default() } else { String::new() };
            out.replace_range(start..=start + len, &replacement);
        }
    }
    out.trim().to_owned()
}

/// Splits `argLine` as Surefire does (plexus `CommandLineUtils`): whitespace, `"…"` and `'…'`, no escapes.
fn split_arg_line(line: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current: Option<String> = None;
    let mut quote: Option<char> = None;
    for c in line.chars() {
        match quote {
            Some(q) if c == q => quote = None,
            Some(_) => current.get_or_insert_default().push(c),
            None if c == '"' || c == '\'' => {
                quote = Some(c);
                current.get_or_insert_default();
            }
            None if c.is_whitespace() => out.extend(current.take()),
            None => current.get_or_insert_default().push(c),
        }
    }
    out.extend(current);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const POM: &str = r#"<project>
      <groupId>com.example</groupId><artifactId>orders</artifactId><version>1</version>
      <properties><openideaFail>true</openideaFail><mockito>/m2/mockito.jar</mockito></properties>
      <build><plugins><plugin>
        <artifactId>maven-surefire-plugin</artifactId>
        <configuration>
          <argLine>@{argLine} @{jacoco} -javaagent:${mockito} --add-opens "java.base/java.lang=ALL-UNNAMED" -Dx=${undefined}</argLine>
          <systemPropertyVariables><openidea.fail>${openideaFail}</openidea.fail><dir>${project.build.directory}</dir></systemPropertyVariables>
          <systemProperties><property><name>old</name><value>style</value></property></systemProperties>
          <environmentVariables><TZ>UTC</TZ></environmentVariables>
          <additionalClasspathElements><additionalClasspathElement>${basedir}/extra</additionalClasspathElement></additionalClasspathElements>
          <classpathDependencyExcludes><classpathDependencyExclude>org.slf4j:slf4j-simple</classpathDependencyExclude></classpathDependencyExcludes>
        </configuration>
        <executions><execution><id>default-test</id><configuration><workingDirectory>${basedir}/work</workingDirectory></configuration></execution></executions>
      </plugin></plugins></build>
    </project>"#;

    fn model(dir: &Path) -> MavenModel {
        crate::maven::load(dir)
    }

    #[test]
    fn reads_the_module_pom_and_the_effective_pom_the_sync_cached() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::write(root.join("pom.xml"), POM).unwrap();
        let cache = root.join("cache");
        std::fs::create_dir_all(&cache).unwrap();
        let config = surefire_config(root, &cache, &model(root), root).unwrap();
        let d = root.to_string_lossy();
        assert_eq!(
            config.arg_line,
            ["-javaagent:/m2/mockito.jar", "--add-opens", "java.base/java.lang=ALL-UNNAMED", "-Dx="]
        );
        assert_eq!(config.system_properties["openidea.fail"], "true");
        assert_eq!(config.system_properties["dir"], format!("{d}/target"));
        assert_eq!(config.system_properties["old"], "style");
        assert_eq!(config.environment["TZ"], "UTC");
        assert_eq!(config.working_directory, Some(format!("{d}/work")));
        assert_eq!(config.additional_classpath, [format!("{d}/extra")]);
        assert_eq!(config.classpath_excludes, ["org.slf4j:slf4j-simple"]);

        // A sync's effective POM wins: it has what the module inherits.
        let effective = POM.replace("<argLine>", "<argLine>-Xmx1g ").replace("<TZ>UTC</TZ>", "<TZ>Asia/Tokyo</TZ>");
        std::fs::write(cache.join("effective-pom-0.xml"), format!("<projects>{effective}</projects>")).unwrap();
        let config = surefire_config(root, &cache, &model(root), root).unwrap();
        assert_eq!(config.arg_line[0], "-Xmx1g");
        assert_eq!(config.environment["TZ"], "Asia/Tokyo");
    }

    #[test]
    fn splits_arg_line_like_surefire() {
        assert_eq!(split_arg_line(r#" -a  "b c" 'd "e"' C:\x\y "" "#), ["-a", "b c", r#"d "e""#, r"C:\x\y", ""]);
    }
}
