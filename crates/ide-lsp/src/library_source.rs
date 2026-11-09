//! `jar:` URIs (`jar:///…/lib.jar!/pkg/Name.class`, also `jar:file:///…`) that
//! language servers return for library code: the official Kotlin LSP for the
//! classes of a dependency, Metals and others for entries of a sources jar.
//! Not every server can serve their contents (`workspace/textDocumentContent`),
//! so they are read here, where the jars are (also on a remote backend): an
//! entry as is, a class as its source from the artifact's `-sources.jar` next to
//! it in the Maven or Gradle cache.

use ide_core::{Pos, Range};
use percent_encoding::{AsciiSet, CONTROLS, percent_decode_str, utf8_percent_encode};
use std::io::Read;
use std::path::{Path, PathBuf};

/// An entry of an archive named by a `jar:` URI.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct JarEntry {
    /// The URI up to the archive path (`jar:///` or `jar:file:///`), kept for new URIs.
    prefix: String,
    pub jar: PathBuf,
    /// `/`-separated, without a leading `/`.
    pub entry: String,
}

pub(crate) fn parse(uri: &str) -> Option<JarEntry> {
    let rest = uri.strip_prefix("jar:")?;
    let (archive, entry) = rest.split_once("!/")?;
    let (prefix, path) = if let Some(path) = archive.strip_prefix("file://") {
        ("jar:file://", path)
    } else if let Some(path) = archive.strip_prefix("//") {
        ("jar://", path)
    } else {
        ("jar:", archive)
    };
    let path = percent_decode_str(path).decode_utf8().ok()?;
    let path = if cfg!(windows) {
        // `/C:/x` → `C:\x`
        let trimmed = path.strip_prefix('/').filter(|s| s.as_bytes().get(1) == Some(&b':')).unwrap_or(&path);
        PathBuf::from(trimmed.replace('/', "\\"))
    } else {
        PathBuf::from(path.into_owned())
    };
    let entry = percent_decode_str(entry.split(['?', '#']).next().unwrap_or(entry)).decode_utf8().ok()?;
    Some(JarEntry { prefix: prefix.to_owned(), jar: path, entry: entry.trim_start_matches('/').to_owned() })
}

const PATH: &AsciiSet = &CONTROLS.add(b' ').add(b'#').add(b'%').add(b'?').add(b'!');

impl JarEntry {
    /// The URI of `entry` in `jar`, written like the URI this one came from.
    fn uri_of(&self, jar: &Path, entry: &str) -> String {
        let mut path = jar.to_string_lossy().replace('\\', "/");
        if !path.starts_with('/') {
            path.insert(0, '/');
        }
        let encode = |s: &str| utf8_percent_encode(s, PATH).to_string();
        format!("{}{}!/{}", self.prefix, encode(&path), encode(entry))
    }
}

/// The text of `entry` in the archive `jar`, when it is a UTF-8 file.
pub(crate) fn read_entry(jar: &Path, entry: &str) -> Option<String> {
    let mut zip = zip::ZipArchive::new(std::fs::File::open(jar).ok()?).ok()?;
    let mut file = zip.by_name(entry).ok()?;
    let mut text = String::new();
    file.read_to_string(&mut text).ok()?;
    Some(text)
}

/// The library source for a class entry: its `.kt` / `.java` file in the
/// artifact's sources jar, as `(uri, text)`.
pub(crate) fn class_source(uri: &str) -> Option<(String, String)> {
    let jar = parse(uri)?;
    let class = jar.entry.strip_suffix(".class")?;
    for sources in sources_jars(&jar.jar) {
        if let Some((entry, text)) = source_entry(&sources, class) {
            return Some((jar.uri_of(&sources, &entry), text));
        }
    }
    None
}

/// Sources jars of the artifact `jar`: `<name>-sources.jar` next to it (Maven
/// repository), or in a sibling hash folder (Gradle `files-2.1/<g>/<a>/<v>/<hash>/`).
fn sources_jars(jar: &Path) -> Vec<PathBuf> {
    let (Some(dir), Some(stem)) = (jar.parent(), jar.file_stem().and_then(|s| s.to_str())) else { return vec![] };
    let name = format!("{stem}-sources.jar");
    let mut out: Vec<PathBuf> = vec![dir.join(&name)];
    if let Some(version_dir) = dir.parent()
        && version_dir.ancestors().any(|a| a.file_name().is_some_and(|n| n == "files-2.1"))
        && let Ok(entries) = std::fs::read_dir(version_dir)
    {
        out.extend(entries.flatten().map(|e| e.path().join(&name)));
    }
    out.retain(|p| p.is_file());
    out
}

/// The source file of `class` (`pkg/Name`, `pkg/Outer$Inner`, `pkg/FileKt`) in `sources`.
fn source_entry(sources: &Path, class: &str) -> Option<(String, String)> {
    let mut zip = zip::ZipArchive::new(std::fs::File::open(sources).ok()?).ok()?;
    let (package, name) = class.rsplit_once('/').unwrap_or(("", class));
    let outer = name.split('$').next().unwrap_or(name);
    let dir = if package.is_empty() { String::new() } else { format!("{package}/") };
    let mut candidates = vec![format!("{dir}{outer}.java"), format!("{dir}{outer}.kt")];
    // Top-level Kotlin declarations compile to a `<File>Kt` facade class.
    if let Some(file) = outer.strip_suffix("Kt").filter(|f| !f.is_empty()) {
        candidates.push(format!("{dir}{file}.kt"));
    }
    let read = |zip: &mut zip::ZipArchive<std::fs::File>, entry: &str| {
        let mut text = String::new();
        zip.by_name(entry).ok()?.read_to_string(&mut text).ok()?;
        Some(text)
    };
    for entry in &candidates {
        if let Some(text) = read(&mut zip, entry) {
            return Some((entry.clone(), text));
        }
    }
    // A facade renamed with `@file:JvmName("…")`.
    let kotlin_files: Vec<String> = zip
        .file_names()
        .filter_map(|n| n.ok().map(|n| n.into_owned()))
        .filter(|n| n.ends_with(".kt") && n.strip_prefix(&dir).is_some_and(|rest| !rest.contains('/')))
        .collect();
    let jvm_name = format!("@file:JvmName(\"{outer}\")");
    for entry in kotlin_files {
        if let Some(text) = read(&mut zip, &entry)
            && text.contains(&jvm_name)
        {
            return Some((entry, text));
        }
    }
    None
}

/// Where `name` is declared in a Kotlin or Java source `text` (the start of the
/// name), else the start of the file.
pub(crate) fn declaration_range(text: &str, name: &str) -> Range {
    const KEYWORDS: [&str; 9] = ["fun", "class", "interface", "object", "val", "var", "typealias", "enum", "record"];
    let is_ident = |c: char| c.is_alphanumeric() || c == '_' || c == '$';
    let mut fallback = None;
    for (line_no, line) in text.lines().enumerate() {
        let mut from = 0;
        while let Some(i) = line[from..].find(name) {
            let start = from + i;
            let end = start + name.len();
            from = end;
            let before = line[..start].chars().next_back();
            let after = line[end..].chars().next();
            if before.is_some_and(is_ident) || after.is_some_and(is_ident) {
                continue;
            }
            let head = &line[..start];
            let words: Vec<&str> = head.split(|c: char| !is_ident(c)).filter(|w| !w.is_empty()).collect();
            let col = head.encode_utf16().count() as u32;
            let range = Range {
                start: Pos::new(line_no as u32, col),
                end: Pos::new(line_no as u32, col + name.encode_utf16().count() as u32),
            };
            // Kotlin: `fun <T> Foo.name(`, `class Name`; Java: `… Type name(`.
            if words.iter().any(|w| KEYWORDS.contains(w)) {
                return range;
            }
            let java_member =
                after == Some('(') && !head.trim_end().ends_with('.') && !head.trim().is_empty() && !head.contains('=');
            if java_member && fallback.is_none() {
                fallback = Some(range);
            }
        }
    }
    fallback.unwrap_or_default()
}

/// The identifier around `col` (UTF-16) of `line`.
pub(crate) fn identifier_at(line: &str, col: u32) -> Option<&str> {
    let is_ident = |c: char| c.is_alphanumeric() || c == '_' || c == '$';
    let mut utf16 = 0u32;
    let mut at = line.len();
    for (i, c) in line.char_indices() {
        if utf16 >= col {
            at = i;
            break;
        }
        utf16 += c.len_utf16() as u32;
    }
    let start =
        line[..at].rfind(|c: char| !is_ident(c)).map_or(0, |i| i + line[i..].chars().next().map_or(1, char::len_utf8));
    let end = line[at..].find(|c: char| !is_ident(c)).map_or(line.len(), |i| at + i);
    let word = &line[start..end];
    (!word.is_empty() && !word.starts_with(|c: char| c.is_ascii_digit())).then_some(word)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn jar(path: &Path, entries: &[(&str, &str)]) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut zip = zip::ZipWriter::new(std::fs::File::create(path).unwrap());
        for (name, text) in entries {
            zip.start_file(*name, zip::write::SimpleFileOptions::default()).unwrap();
            zip.write_all(text.as_bytes()).unwrap();
        }
        zip.finish().unwrap();
    }

    const EXTENSIONS: &str = "package org.springframework.boot\n\nimport kotlin.reflect.KClass\n\n/**\n * Top-level function acting as a Kotlin shortcut allowing to write\n * `runApplication<Foo>(arg1, arg2)` instead of `SpringApplication.run(Foo::class.java, arg1, arg2)`.\n */\ninline fun <reified T : Any> runApplication(vararg args: String): ConfigurableApplicationContext =\n\t\tSpringApplication.run(T::class.java, *args)\n";

    #[test]
    fn parses_both_jar_uri_forms() {
        for uri in [
            "jar:///home/me/.m2/repository/b/spring-boot-3.5.16.jar!/org/springframework/boot/SpringApplicationExtensionsKt.class",
            "jar:file:///home/me/.m2/repository/b/spring-boot-3.5.16.jar!/org/springframework/boot/SpringApplicationExtensionsKt.class",
        ] {
            let e = parse(uri).unwrap();
            if !cfg!(windows) {
                assert_eq!(e.jar, PathBuf::from("/home/me/.m2/repository/b/spring-boot-3.5.16.jar"));
            }
            assert_eq!(e.entry, "org/springframework/boot/SpringApplicationExtensionsKt.class");
            assert_eq!(e.uri_of(&e.jar, &e.entry), uri, "written back the same way");
        }
        let spaced = parse("jar:///tmp/my%20libs/a.jar!/A.class").unwrap();
        assert!(spaced.jar.to_string_lossy().contains("my libs"));
        assert_eq!(spaced.uri_of(&spaced.jar, "A.kt"), "jar:///tmp/my%20libs/a.jar!/A.kt");
        assert_eq!(parse("jdt://contents/a.jar/A.class"), None);
        assert_eq!(parse("jar:///no/entry.jar"), None);
    }

    #[test]
    fn finds_the_source_of_each_kind_of_class_in_maven_and_gradle_caches() {
        let tmp = tempfile::tempdir().unwrap();
        let m2 = tmp.path().join("m2/org/springframework/boot/spring-boot/3.5.16");
        let gradle = tmp.path().join("gradle/caches/modules-2/files-2.1/org.springframework.boot/spring-boot/3.5.16");
        let sources: &[(&str, &str)] = &[
            ("org/springframework/boot/SpringApplicationExtensions.kt", EXTENSIONS),
            ("org/springframework/boot/SpringApplication.java", "public class SpringApplication {}"),
            (
                "org/springframework/boot/Renamed.kt",
                "@file:JvmName(\"BootUtils\")\npackage org.springframework.boot\nfun util() {}",
            ),
            ("org/springframework/boot/Builder.kt", "class Builder"),
            ("Root.java", "class Root {}"),
        ];
        jar(&m2.join("spring-boot-3.5.16.jar"), &[]);
        jar(&m2.join("spring-boot-3.5.16-sources.jar"), sources);
        // Gradle keeps each file under its own hash folder.
        jar(&gradle.join("aaa/spring-boot-3.5.16.jar"), &[]);
        jar(&gradle.join("bbb/spring-boot-3.5.16-sources.jar"), sources);
        for binary in [m2.join("spring-boot-3.5.16.jar"), gradle.join("aaa/spring-boot-3.5.16.jar")] {
            let uri = |class: &str| format!("jar://{}!/{class}", binary.to_string_lossy().replace('\\', "/"));
            for (class, file) in [
                ("org/springframework/boot/SpringApplicationExtensionsKt.class", "SpringApplicationExtensions.kt"),
                ("org/springframework/boot/SpringApplication.class", "SpringApplication.java"),
                ("org/springframework/boot/SpringApplication$Running.class", "SpringApplication.java"),
                ("org/springframework/boot/BootUtils.class", "Renamed.kt"),
                ("org/springframework/boot/Builder.class", "Builder.kt"),
                ("Root.class", "Root.java"),
            ] {
                let (source_uri, text) = class_source(&uri(class)).unwrap_or_else(|| panic!("{class} in {binary:?}"));
                let dir = class.rsplit_once('/').map_or(String::new(), |(p, _)| format!("{p}/"));
                assert!(source_uri.ends_with(&format!("-sources.jar!/{dir}{file}")), "{source_uri}");
                assert_eq!(
                    parse(&source_uri).and_then(|e| read_entry(&e.jar, &e.entry)).as_deref(),
                    Some(text.as_str())
                );
            }
            assert_eq!(class_source(&uri("org/springframework/boot/Missing.class")), None);
        }
        // No sources jar: nothing to show from here.
        let lone = tmp.path().join("lone/x-1.jar");
        jar(&lone, &[]);
        assert_eq!(class_source(&format!("jar://{}!/X.class", lone.to_string_lossy().replace('\\', "/"))), None);
    }

    #[test]
    fn locates_declarations_in_kotlin_and_java_sources() {
        let at = |text: &str, name: &str| {
            let r = declaration_range(text, name);
            (r.start.line, r.start.col, r.end.col)
        };
        assert_eq!(at(EXTENSIONS, "runApplication"), (8, 29, 43), "the declaration, not the KDoc mention");
        let java = "package a;\n\npublic class SpringApplication {\n    public static ConfigurableApplicationContext run(Class<?> source, String... args) {\n        return run(new Class<?>[] { source }, args);\n    }\n}\n";
        assert_eq!(at(java, "SpringApplication"), (2, 13, 30));
        assert_eq!(at(java, "run"), (3, 49, 52), "the member, not the call in its body");
        assert_eq!(at("val x = 1", "missing"), (0, 0, 0));
        assert_eq!(at("// é\nfun ü() {}", "ü"), (1, 4, 5), "UTF-16 columns");
    }

    #[test]
    fn identifier_under_the_caret() {
        let line = "    runApplication<Application>(*args)";
        assert_eq!(identifier_at(line, 4), Some("runApplication"));
        assert_eq!(identifier_at(line, 10), Some("runApplication"));
        assert_eq!(identifier_at(line, 18), Some("runApplication"), "right after it");
        assert_eq!(identifier_at(line, 20), Some("Application"));
        assert_eq!(identifier_at("a + b", 2), None);
    }
}
