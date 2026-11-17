//! Eclipse projects without Maven or Gradle: `.classpath` names the source folders (tests
//! by their `test` attribute), the output folder and the library jars; a Dynamic Web
//! Project's `.settings/org.eclipse.wst.common.component` names the web content folder.
use std::path::Path;

/// What `.classpath` declares, with project-relative `/`-separated paths.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct EclipseClasspath {
    /// Source folders and whether they hold tests.
    pub sources: Vec<(String, bool)>,
    pub output: Option<String>,
    /// Library jars or class folders (`kind="lib"`), project-relative or absolute.
    pub libraries: Vec<String>,
}

/// The value of `name="…"` in a tag's text.
fn attribute(tag: &str, name: &str) -> Option<String> {
    let mut rest = tag;
    while let Some(at) = rest.find(name) {
        let before = rest[..at].chars().last();
        let after = &rest[at + name.len()..];
        rest = after;
        if before.is_some_and(|c| !c.is_whitespace()) {
            continue;
        }
        let Some(after) = after.trim_start().strip_prefix('=') else { continue };
        let after = after.trim_start();
        let quote = after.chars().next().filter(|c| *c == '"' || *c == '\'')?;
        let value = &after[1..];
        let end = value.find(quote)?;
        return Some(unescape(&value[..end]));
    }
    None
}

fn unescape(value: &str) -> String {
    value.replace("&quot;", "\"").replace("&apos;", "'").replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&")
}

/// Each element `<name …>…</name>` or `<name …/>` as (opening tag, inner text).
fn elements<'a>(text: &'a str, name: &str) -> Vec<(&'a str, &'a str)> {
    let open = format!("<{name}");
    let close = format!("</{name}>");
    let mut out = Vec::new();
    let mut rest = text;
    while let Some(at) = rest.find(&open) {
        let from = &rest[at..];
        // `<classpathentry` must not match `<classpathentryX`.
        if !from[open.len()..].starts_with(|c: char| c.is_whitespace() || c == '/' || c == '>') {
            rest = &from[open.len()..];
            continue;
        }
        let Some(end) = from.find('>') else { break };
        let tag = &from[..=end];
        if tag.ends_with("/>") {
            out.push((tag, ""));
            rest = &from[end + 1..];
        } else {
            let body = &from[end + 1..];
            let stop = body.find(&close).unwrap_or(body.len());
            out.push((tag, &body[..stop]));
            rest = &body[stop..];
        }
    }
    out
}

fn clean(path: &str) -> String {
    let p = path.trim().replace('\\', "/");
    let p = p.trim_start_matches("./").trim_end_matches('/');
    p.to_owned()
}

pub fn parse_classpath(text: &str) -> EclipseClasspath {
    let mut out = EclipseClasspath::default();
    for (tag, body) in elements(text, "classpathentry") {
        let (Some(kind), Some(path)) = (attribute(tag, "kind"), attribute(tag, "path")) else { continue };
        let path = clean(&path);
        match kind.as_str() {
            // `/OtherProject` is a project reference, not a folder of this one.
            "src" if !path.starts_with('/') && !path.is_empty() => {
                let test = elements(body, "attribute").iter().any(|(a, _)| {
                    attribute(a, "name").as_deref() == Some("test") && attribute(a, "value").as_deref() == Some("true")
                });
                out.sources.push((path, test));
            }
            "output" if !path.is_empty() => out.output = Some(path),
            "lib" if !path.is_empty() => out.libraries.push(path),
            _ => {}
        }
    }
    out
}

/// The project's `.classpath`, unless a Maven or Gradle build owns its model.
pub fn classpath(dir: &Path) -> Option<EclipseClasspath> {
    if ["pom.xml", "build.gradle", "build.gradle.kts"].iter().any(|f| dir.join(f).is_file()) {
        return None;
    }
    std::fs::read_to_string(dir.join(".classpath")).ok().map(|t| parse_classpath(&t))
}

/// The web content folder of a web project: the `wb-resource` deployed at `/`, else a
/// conventional `WebContent` / `WebRoot` / `web` / `src/main/webapp` holding `WEB-INF/web.xml`.
pub fn web_root(dir: &Path) -> Option<String> {
    if let Ok(text) = std::fs::read_to_string(dir.join(".settings/org.eclipse.wst.common.component")) {
        for (tag, _) in elements(&text, "wb-resource") {
            if attribute(tag, "deploy-path").as_deref() == Some("/")
                && let Some(source) = attribute(tag, "source-path")
            {
                let source = clean(source.trim_start_matches('/'));
                if dir.join(&source).is_dir() {
                    return Some(source);
                }
            }
        }
    }
    ["WebContent", "WebRoot", "web", "src/main/webapp"]
        .into_iter()
        .find(|d| dir.join(d).join("WEB-INF/web.xml").is_file())
        .map(str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_sources_tests_output_and_libraries() {
        let cp = parse_classpath(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<classpath>
	<classpathentry kind="src" path="src"/>
	<classpathentry kind="src" output="bin/test" path="test">
		<attributes>
			<attribute name="test" value="true"/>
		</attributes>
	</classpathentry>
	<classpathentry kind="src" path="/OtherProject"/>
	<classpathentry kind="con" path="org.eclipse.jdt.launching.JRE_CONTAINER"/>
	<classpathentry kind="lib" path="WebContent/WEB-INF/lib/commons-lang.jar"/>
	<classpathentry kind='lib' path='lib\mail.jar' sourcepath="lib/mail-src.zip"/>
	<classpathentry kind="output" path="build/classes"/>
</classpath>"#,
        );
        assert_eq!(cp.sources, [("src".to_owned(), false), ("test".to_owned(), true)]);
        assert_eq!(cp.output.as_deref(), Some("build/classes"));
        assert_eq!(cp.libraries, ["WebContent/WEB-INF/lib/commons-lang.jar", "lib/mail.jar"]);
    }

    #[test]
    fn finds_the_web_content_folder() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("site/WEB-INF")).unwrap();
        std::fs::create_dir_all(dir.path().join(".settings")).unwrap();
        std::fs::write(
            dir.path().join(".settings/org.eclipse.wst.common.component"),
            r#"<project-modules><wb-module deploy-name="shop">
<wb-resource deploy-path="/WEB-INF/classes" source-path="/src"/>
<wb-resource deploy-path="/" source-path="/site" tag="defaultRootSource"/>
</wb-module></project-modules>"#,
        )
        .unwrap();
        assert_eq!(web_root(dir.path()).as_deref(), Some("site"));
        let plain = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(plain.path().join("WebRoot/WEB-INF")).unwrap();
        assert_eq!(web_root(plain.path()), None);
        std::fs::write(plain.path().join("WebRoot/WEB-INF/web.xml"), "<web-app/>").unwrap();
        assert_eq!(web_root(plain.path()).as_deref(), Some("WebRoot"));
    }

    #[test]
    fn detects_the_roots_of_an_eclipse_project() {
        use super::super::{RootKind, detect};
        let dir = tempfile::tempdir().unwrap();
        for d in ["src", "test", "bin"] {
            std::fs::create_dir_all(dir.path().join(d)).unwrap();
        }
        std::fs::write(
            dir.path().join(".classpath"),
            r#"<classpath><classpathentry kind="src" path="src"/><classpathentry kind="src" path="test"><attributes><attribute name="test" value="true"/></attributes></classpathentry><classpathentry kind="output" path="bin"/></classpath>"#,
        )
        .unwrap();
        let roots: Vec<(String, RootKind)> = detect(dir.path()).into_iter().map(|r| (r.path, r.kind)).collect();
        assert_eq!(
            roots,
            [("bin".into(), RootKind::Excluded), ("src".into(), RootKind::Source), ("test".into(), RootKind::Test)]
        );
        // A Maven build owns the model even with a stale `.classpath` next to it.
        std::fs::write(dir.path().join("pom.xml"), "<project/>").unwrap();
        assert!(detect(dir.path()).iter().all(|r| r.detected_from.as_deref() != Some(".classpath")));
    }
}
