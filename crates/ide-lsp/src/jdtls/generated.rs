//! Maven plugin output that jdtls never imports.
//!
//! `protobuf-maven-plugin` and the same kind of generator call
//! `MavenProject.addCompileSourceRoot` while the build runs. That list is not in the
//! POM, so m2e never adds the folders and the editor keeps reporting missing packages
//! after a successful Maven compile. Annotation-processor output (`annotations`,
//! `test-annotations`) is left out: jdtls compiles it itself, and adding it as a source
//! folder makes the processor emit the same file twice.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

const MAX_DEPTH: usize = 16;
const MAX_JAVA_FILES: usize = 4_000;
const MAX_PARENTS: usize = 8;

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) struct GeneratedRoot {
    pub path: PathBuf,
    pub test: bool,
}

pub(crate) struct GeneratedScan {
    pub maven: bool,
    pub roots: Vec<GeneratedRoot>,
}

/// Generated Java source folders under `root` (a reactor or one module).
pub(crate) fn scan(root: &Path) -> GeneratedScan {
    let mut modules = Vec::new();
    collect_modules(root, 0, &mut modules);
    let mut roots = Vec::new();
    for module in &modules {
        let build = build_dir(module);
        collect_tree(&build.join("generated-sources"), false, &mut roots);
        collect_tree(&build.join("generated-test-sources"), true, &mut roots);
    }
    roots.sort();
    roots.dedup();
    GeneratedScan { maven: !modules.is_empty(), roots }
}

fn collect_modules(dir: &Path, depth: usize, modules: &mut Vec<PathBuf>) {
    if depth > MAX_DEPTH {
        return;
    }
    let has_pom = dir.join("pom.xml").is_file();
    if has_pom {
        modules.push(dir.to_path_buf());
    }
    let build_name = has_pom.then(|| build_dir(dir)).and_then(|dir| dir.file_name().map(|name| name.to_os_string()));
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let Ok(kind) = entry.file_type() else { continue };
        if !kind.is_dir() || kind.is_symlink() {
            continue;
        }
        let name = entry.file_name();
        let shown = name.to_string_lossy();
        if shown.starts_with('.') || shown == "node_modules" || shown == "target" {
            continue;
        }
        if build_name.as_ref().is_some_and(|build| build == &name) {
            continue;
        }
        collect_modules(&entry.path(), depth + 1, modules);
    }
}

fn collect_tree(tree: &Path, test: bool, roots: &mut Vec<GeneratedRoot>) {
    let mut files = Vec::new();
    walk_java(tree, 0, &mut files);
    let mut found = HashSet::new();
    for file in files {
        let Some(package) = package_name(&read_head(&file)) else { continue };
        let Some(root) = source_root(&file, &package) else { continue };
        if root.starts_with(tree) && found.insert(root.clone()) {
            roots.push(GeneratedRoot { path: root, test });
        }
    }
}

fn walk_java(dir: &Path, depth: usize, files: &mut Vec<PathBuf>) {
    if depth > MAX_DEPTH || files.len() >= MAX_JAVA_FILES {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        if files.len() >= MAX_JAVA_FILES {
            return;
        }
        let Ok(kind) = entry.file_type() else { continue };
        if kind.is_symlink() {
            continue;
        }
        let path = entry.path();
        if kind.is_dir() {
            // The compiler's own output. jdtls already consumes it as annotation processing.
            if depth == 0 && matches!(entry.file_name().to_str(), Some("annotations" | "test-annotations")) {
                continue;
            }
            walk_java(&path, depth + 1, files);
        } else if kind.is_file() && path.extension().is_some_and(|ext| ext == "java") {
            files.push(path);
        }
    }
}

fn read_head(path: &Path) -> String {
    let Ok(bytes) = std::fs::read(path) else { return String::new() };
    let head = &bytes[..bytes.len().min(4096)];
    String::from_utf8_lossy(head).into_owned()
}

/// The `package` declaration, ignoring comments that precede it.
fn package_name(text: &str) -> Option<String> {
    let mut rest = text;
    loop {
        let trimmed = rest.trim_start();
        if let Some(after) = trimmed.strip_prefix("//") {
            rest = after.split_once('\n').map(|(_, next)| next).unwrap_or("");
            continue;
        }
        if let Some(after) = trimmed.strip_prefix("/*") {
            rest = after.split_once("*/").map(|(_, next)| next).unwrap_or("");
            continue;
        }
        let after = trimmed.strip_prefix("package")?;
        if !after.starts_with(|c: char| c.is_whitespace()) {
            return None;
        }
        let after = after.trim_start();
        let end = after.find([';', '{', '\n', '\r', ' ', '\t', '/']).unwrap_or(after.len());
        let name = after[..end].trim();
        if name.is_empty() || !name.split('.').all(java_identifier) {
            return None;
        }
        return Some(name.to_owned());
    }
}

fn java_identifier(segment: &str) -> bool {
    let mut chars = segment.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphabetic() || c == '_' || c == '$')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$')
}

/// Directory that is the source root for `file` declaring `package`.
fn source_root(file: &Path, package: &str) -> Option<PathBuf> {
    let mut dir = file.parent()?.to_path_buf();
    for segment in package.split('.').rev() {
        if dir.file_name().and_then(|n| n.to_str()) != Some(segment) {
            return None;
        }
        dir.pop();
    }
    Some(dir)
}

fn build_dir(module: &Path) -> PathBuf {
    let mut pom = module.join("pom.xml");
    let mut seen = HashSet::new();
    for _ in 0..MAX_PARENTS {
        if !seen.insert(pom.clone()) {
            break;
        }
        let Ok(text) = std::fs::read_to_string(&pom) else { break };
        let text = strip_comments(&text);
        if let Some(raw) = own_build_directory(&text) {
            let rel = relative_build_dir(&raw).unwrap_or_else(|| "target".to_owned());
            return module.join(rel);
        }
        let Some(parent) = parent_pom(pom.parent().unwrap_or(module), &text) else { break };
        pom = parent;
    }
    module.join("target")
}

fn own_build_directory(pom: &str) -> Option<String> {
    let build = section(pom, "build")?;
    let own = plugins_removed(build);
    section(&own, "directory").map(str::to_owned)
}

fn parent_pom(dir: &Path, pom: &str) -> Option<PathBuf> {
    let parent = section(pom, "parent")?;
    let rel = match relative_path(parent) {
        Some(value) if value.trim().is_empty() => return None,
        Some(value) => value.trim(),
        None => "../pom.xml",
    };
    if rel.contains("${") || rel.starts_with(['/', '\\']) || rel.contains(':') {
        return None;
    }
    let path = dir.join(rel);
    path.is_file().then_some(path)
}

/// `<relativePath>` text, or `Some("")` for a self-closing `<relativePath/>` (no local parent).
fn relative_path(parent: &str) -> Option<&str> {
    if let Some(value) = section(parent, "relativePath") {
        return Some(value);
    }
    ["<relativePath/>", "<relativePath />"].iter().any(|tag| parent.contains(tag)).then_some("")
}

fn relative_build_dir(raw: &str) -> Option<String> {
    let mut value = raw.trim();
    for prefix in ["${project.basedir}", "${basedir}"] {
        if let Some(rest) = value.strip_prefix(prefix) {
            value = rest.trim_start_matches(['/', '\\']);
        }
    }
    if value.is_empty()
        || value.contains("${")
        || value.contains("..")
        || value.starts_with(['/', '\\'])
        || value.contains(':')
    {
        return None;
    }
    Some(value.replace('\\', "/"))
}

fn strip_comments(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find("<!--") {
        out.push_str(&rest[..start]);
        rest = rest[start..].find("-->").map_or("", |end| &rest[start + end + 3..]);
    }
    out.push_str(rest);
    out
}

fn section<'a>(text: &'a str, tag: &str) -> Option<&'a str> {
    let open = format!("<{tag}>");
    let start = text.find(&open)? + open.len();
    let end = text[start..].find(&format!("</{tag}>"))?;
    Some(&text[start..start + end])
}

fn plugins_removed(build: &str) -> String {
    let mut text = build.to_owned();
    for tag in ["plugins", "pluginManagement"] {
        let (open, close) = (format!("<{tag}>"), format!("</{tag}>"));
        let mut kept = String::with_capacity(text.len());
        let mut rest = text.as_str();
        while let Some(start) = rest.find(&open) {
            kept.push_str(&rest[..start]);
            rest = rest[start..].find(&close).map_or("", |end| &rest[start + end + close.len()..]);
        }
        kept.push_str(rest);
        text = kept;
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(root: &Path, rel: &str, text: &str) {
        let path = root.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    fn grpc(root: &Path) {
        write(root, "pom.xml", "<project><artifactId>app</artifactId></project>");
        write(
            root,
            "target/generated-sources/protobuf/java/com/example/hello/Hello.java",
            "package com.example.hello;\npublic class Hello {}",
        );
        write(
            root,
            "target/generated-sources/protobuf/grpc-java/com/example/hello/HelloGrpc.java",
            "/* generated */\npackage com.example.hello;\npublic class HelloGrpc {}",
        );
        write(
            root,
            "target/generated-sources/annotations/com/example/hello/HelloMapperImpl.java",
            "package com.example.hello;\nclass HelloMapperImpl {}",
        );
    }

    #[test]
    fn protobuf_and_grpc_roots_are_kept_and_annotation_output_is_not() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        grpc(root);
        let scan = scan(root);
        assert!(scan.maven);
        assert_eq!(
            scan.roots,
            vec![
                GeneratedRoot { path: root.join("target/generated-sources/protobuf/grpc-java"), test: false },
                GeneratedRoot { path: root.join("target/generated-sources/protobuf/java"), test: false },
            ]
        );
    }

    #[test]
    fn comments_before_the_package_and_test_sources() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        write(root, "pom.xml", "<project/>");
        write(
            root,
            "target/generated-test-sources/protobuf/java/com/example/hello/HelloTest.java",
            "// package ignored.nope;\n/* package also.nope; */\npackage com.example.hello;\nclass HelloTest {}",
        );
        write(
            root,
            "target/generated-test-sources/test-annotations/com/example/hello/Skip.java",
            "package com.example.hello;\nclass Skip {}",
        );
        write(
            root,
            "target/generated-sources/protobuf/java/com/example/Wrong.java",
            "package com.other;\nclass Wrong {}",
        );
        let scan = scan(root);
        assert_eq!(
            scan.roots,
            vec![GeneratedRoot { path: root.join("target/generated-test-sources/protobuf/java"), test: true }]
        );
    }

    #[test]
    fn custom_build_directory_ignores_plugin_configuration_and_inherits_from_the_parent() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        write(
            root,
            "pom.xml",
            r#"<project><build><directory>out</directory></build><modules><module>app</module></modules></project>"#,
        );
        write(
            root,
            "app/pom.xml",
            r#"<project>
                <parent><groupId>g</groupId><artifactId>p</artifactId><version>1</version></parent>
                <build>
                  <plugins><plugin><configuration><directory>nope</directory></configuration></plugin></plugins>
                  <directory>${project.basedir}/custom</directory>
                </build>
              </project>"#,
        );
        write(
            root,
            "lib/pom.xml",
            "<project><parent><groupId>g</groupId><artifactId>p</artifactId><version>1</version></parent></project>",
        );
        write(
            root,
            "app/custom/generated-sources/protobuf/grpc-java/com/example/hello/HelloGrpc.java",
            "package com.example.hello;\nclass HelloGrpc {}",
        );
        write(
            root,
            "lib/out/generated-sources/protobuf/java/com/example/hello/Hello.java",
            "package com.example.hello;\nclass Hello {}",
        );
        write(
            root,
            "lib/target/generated-sources/protobuf/java/com/example/hello/Stale.java",
            "package com.example.hello;\nclass Stale {}",
        );
        let scan = scan(root);
        let paths: Vec<_> = scan.roots.iter().map(|r| r.path.clone()).collect();
        assert_eq!(
            paths,
            vec![
                root.join("app/custom/generated-sources/protobuf/grpc-java"),
                root.join("lib/out/generated-sources/protobuf/java"),
            ]
        );
    }

    #[test]
    fn an_empty_relative_path_does_not_inherit_the_parent_build_directory() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        write(root, "pom.xml", "<project><build><directory>out</directory></build></project>");
        write(
            root,
            "app/pom.xml",
            "<project><parent><groupId>g</groupId><artifactId>p</artifactId><version>1</version><relativePath/></parent></project>",
        );
        write(
            root,
            "app/target/generated-sources/protobuf/java/com/example/hello/Hello.java",
            "package com.example.hello;\nclass Hello {}",
        );
        write(
            root,
            "app/out/generated-sources/protobuf/java/com/example/hello/Other.java",
            "package com.example.hello;\nclass Other {}",
        );
        let scan = scan(root);
        assert_eq!(
            scan.roots,
            vec![GeneratedRoot { path: root.join("app/target/generated-sources/protobuf/java"), test: false }]
        );
    }

    #[test]
    fn a_project_without_maven_is_not_a_scan() {
        let tmp = tempfile::tempdir().unwrap();
        write(
            tmp.path(),
            "target/generated-sources/protobuf/java/com/example/hello/Hello.java",
            "package com.example.hello;\nclass Hello {}",
        );
        let scan = scan(tmp.path());
        assert!(!scan.maven);
        assert!(scan.roots.is_empty());
    }
}
