//! `jar:` URIs (`jar:///…/lib.jar!/pkg/Name.class`, also `jar:file:///…`) that
//! language servers return for library code: the official Kotlin LSP for the
//! classes of a dependency, Metals and others for entries of a sources jar.
//! Not every server can serve their contents (`workspace/textDocumentContent`),
//! so they are read here, where the jars are (also on a remote backend): an
//! entry as is, a class as its source from the artifact's `-sources.jar` next to
//! it in the Maven or Gradle cache.

use ide_core::{Pos, Range};
use ide_vfs::LoadedText;
use percent_encoding::{AsciiSet, CONTROLS, percent_decode_str, utf8_percent_encode};
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

/// The text of `entry` in the archive `jar`, decoded like a file opened in the
/// editor; `encoding` decodes with it instead of detecting ("Reload with
/// Encoding"). `None` for binary or unreadable entries.
pub(crate) fn read_entry(jar: &Path, entry: &str, encoding: Option<&str>) -> Option<LoadedText> {
    let path = ide_vfs::archive_entry_path(jar, entry);
    let loaded = match encoding {
        Some(enc) => ide_vfs::load_text_as(&path, enc).ok()?,
        None => ide_vfs::load_text(&path).ok()?,
    };
    (!loaded.binary).then_some(loaded)
}

/// The library source for a class entry: its `.kt` / `.java` file in the
/// artifact's sources jar, as `(uri, text)`.
pub(crate) fn class_source(uri: &str, encoding: Option<&str>) -> Option<(String, LoadedText)> {
    let jar = parse(uri)?;
    let class = jar.entry.strip_suffix(".class")?;
    for sources in sources_jars(&jar.jar) {
        if let Some((entry, text)) = source_entry(&sources, class, encoding) {
            return Some((jar.uri_of(&sources, &entry), text));
        }
    }
    None
}

pub(crate) fn source_in_archive(uri: &str, sources: &Path, encoding: Option<&str>) -> Option<(String, LoadedText)> {
    let jar = if uri.starts_with("jdt://contents/") {
        let path = uri.split('?').next()?.strip_prefix("jdt://contents/")?;
        let parts: Vec<_> = path.split('/').collect();
        let [_, package, file] = parts.as_slice() else { return None };
        let file = percent_decode_str(file).decode_utf8().ok()?;
        let name = file.strip_suffix(".class").or_else(|| file.strip_suffix(".java"))?;
        let package = percent_decode_str(package).decode_utf8().ok()?.replace('.', "/");
        JarEntry {
            prefix: "jar:file://".into(),
            jar: sources.to_owned(),
            entry: if package.is_empty() { format!("{name}.class") } else { format!("{package}/{name}.class") },
        }
    } else {
        parse(uri)?
    };
    let class = jar.entry.strip_suffix(".class")?;
    let (entry, text) = source_entry(sources, class, encoding)?;
    Some((jar.uri_of(sources, &entry), text))
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
fn source_entry(sources: &Path, class: &str, encoding: Option<&str>) -> Option<(String, LoadedText)> {
    let zip = zip::ZipArchive::new(std::fs::File::open(sources).ok()?).ok()?;
    let (package, name) = class.rsplit_once('/').unwrap_or(("", class));
    let outer = name.split('$').next().unwrap_or(name);
    let dir = if package.is_empty() { String::new() } else { format!("{package}/") };
    let mut candidates = vec![format!("{dir}{outer}.java"), format!("{dir}{outer}.kt")];
    // Top-level Kotlin declarations compile to a `<File>Kt` facade class.
    if let Some(file) = outer.strip_suffix("Kt").filter(|f| !f.is_empty()) {
        candidates.push(format!("{dir}{file}.kt"));
    }
    let read = |entry: &str| read_entry(sources, entry, encoding);
    for entry in &candidates {
        if let Some(text) = read(entry) {
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
        if let Some(text) = read(&entry)
            && text.text.contains(&jvm_name)
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
    let mut block_comment = false;
    for (line_no, line) in text.lines().enumerate() {
        let trimmed = line.trim_start();
        if block_comment {
            block_comment = !trimmed.contains("*/");
            continue;
        }
        if trimmed.starts_with("/*") {
            block_comment = !trimmed.contains("*/");
            continue;
        }
        if trimmed.starts_with("//") || trimmed.starts_with('*') {
            continue;
        }
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
            let java_member = after == Some('(')
                && !head.trim_end().ends_with('.')
                && !head.trim().is_empty()
                && !head.contains(['=', '('])
                && !words.iter().any(|w| matches!(*w, "return" | "throw" | "new" | "yield" | "assert"));
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

/// A class of a class folder on JDT's classpath, as `(package path, class name)`, read
/// from the element handle in the query:
/// `jdt://contents/<folder>/<pkg>/<File>?=<project>/<escaped folder>[=/<attribute>=/<value>]…<pkg(Name.class`
/// (`<File>` is the class's SourceFile, `Db.kt` for a Kotlin class). A folder is a project's
/// own build output (the Kotlin classes the IDE compiles for JDT among them), never a
/// dependency, which is a jar or a JDK module.
pub(crate) fn folder_class(uri: &str) -> Option<(String, String)> {
    uri.strip_prefix("jdt://contents/")?;
    let query = percent_decode_str(uri.split_once('?')?.1).decode_utf8().ok()?;
    let (root, element) = query.split_once('/')?.1.split_once('<')?;
    let folder = PathBuf::from(root.split("=/").next()?.replace('\\', ""));
    let (package, file) = element.split_once('(')?;
    let name = file.strip_suffix(".class")?;
    if name.is_empty() || !folder.is_dir() {
        return None;
    }
    Some((package.replace('.', "/"), name.to_owned()))
}

/// The project's source of `class` (`Name`, `Outer$Inner`, `FileKt`) in `package`
/// (`/`-separated): a `.kt` / `.java` file of that name declaring the package. Build
/// output and ignored files are skipped.
pub(crate) fn project_class_source(root: &Path, package: &str, class: &str) -> Option<PathBuf> {
    let outer = class.split('$').next().unwrap_or(class);
    let mut names = vec![format!("{outer}.kt"), format!("{outer}.java")];
    if let Some(file) = outer.strip_suffix("Kt").filter(|f| !f.is_empty()) {
        names.push(format!("{file}.kt"));
    }
    let package = package.replace('/', ".");
    let mut found: Vec<PathBuf> = ignore::WalkBuilder::new(root)
        .filter_entry(|e| {
            let output = matches!(e.file_name().to_str(), Some("target" | "build" | "out" | "node_modules"));
            // A package may be named `build`: only outside source trees is it output.
            !output || e.path().components().any(|c| c.as_os_str() == "src")
        })
        .build()
        .flatten()
        .filter(|e| e.file_type().is_some_and(|t| t.is_file()))
        .filter(|e| e.file_name().to_str().is_some_and(|n| names.iter().any(|name| name == n)))
        .map(|e| e.into_path())
        .filter(|p| std::fs::read_to_string(p).is_ok_and(|text| declared_package(&text) == package))
        .collect();
    // The directory matching the package first, then by name order.
    found.sort_by_key(|p| {
        let dir = p.parent().map(|d| d.to_string_lossy().replace('\\', "/")).unwrap_or_default();
        let name = p.file_name().and_then(|n| n.to_str()).unwrap_or_default();
        (!dir.ends_with(&format!("/{}", package.replace('.', "/"))), names.iter().position(|n| n == name))
    });
    found.into_iter().next()
}

/// The `package` a Kotlin or Java file declares; empty for the default package.
fn declared_package(text: &str) -> String {
    text.lines()
        .map(str::trim)
        .find(|line| line.starts_with("package "))
        .map(|line| line["package ".len()..].trim_end_matches(';').trim().replace('`', ""))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn jar(path: &Path, entries: &[(&str, &str)]) {
        jar_bytes(path, &entries.iter().map(|(n, t)| (*n, t.as_bytes())).collect::<Vec<_>>());
    }

    fn jar_bytes(path: &Path, entries: &[(&str, &[u8])]) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut zip = zip::ZipWriter::new(std::fs::File::create(path).unwrap());
        for (name, bytes) in entries {
            zip.start_file(*name, zip::write::SimpleFileOptions::default()).unwrap();
            zip.write_all(bytes).unwrap();
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
    fn opens_selected_archives_for_jdt_and_jar_classes() {
        let tmp = tempfile::tempdir().unwrap();
        let sources = tmp.path().join("library sources.zip");
        jar(&sources, &[("p/Lib.java", "package p; public class Lib { class Inner {} }")]);
        for uri in [
            "jdt://contents/lib-1.jar/p/Lib.class?=project/escaped-jar-path",
            "jdt://contents/lib-1.jar/p/Lib.java?=project/escaped-jar-path",
            "jar:file:///m2/g/lib/1/lib-1.jar!/p/Lib$Inner.class",
        ] {
            let (uri, text) = source_in_archive(uri, &sources, None).unwrap();
            assert!(uri.ends_with("library%20sources.zip!/p/Lib.java"), "{uri}");
            assert!(text.text.contains("class Lib"));
        }
        assert!(source_in_archive("jdt://contents/lib.jar/p/Missing.class", &sources, None).is_none());
        assert!(source_in_archive("csharp:/p/App.csproj/decompiled/Lib.cs", &sources, None).is_none());
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
                let (source_uri, text) =
                    class_source(&uri(class), None).unwrap_or_else(|| panic!("{class} in {binary:?}"));
                let dir = class.rsplit_once('/').map_or(String::new(), |(p, _)| format!("{p}/"));
                assert!(source_uri.ends_with(&format!("-sources.jar!/{dir}{file}")), "{source_uri}");
                assert_eq!(
                    parse(&source_uri).and_then(|e| read_entry(&e.jar, &e.entry, None)).map(|l| l.text),
                    Some(text.text.clone())
                );
            }
            assert!(class_source(&uri("org/springframework/boot/Missing.class"), None).is_none());
        }
        // No sources jar: nothing to show from here.
        let lone = tmp.path().join("lone/x-1.jar");
        jar(&lone, &[]);
        assert!(class_source(&format!("jar://{}!/X.class", lone.to_string_lossy().replace('\\', "/")), None).is_none());
    }

    /// The reported case: a library source file saved as GBK bytes, not UTF-8.
    const GBK_SAMPLE: &str = "package example.encoding;\n\n/** 中文编码测试。 */\npublic final class EncodingSample {\n    public static String message() {\n        return \"中文编码测试：是否启用\";\n    }\n}\n";

    #[test]
    fn archive_entries_decode_like_files_opened_in_the_editor() {
        let tmp = tempfile::tempdir().unwrap();
        let gbk = encoding_rs::GBK.encode(GBK_SAMPLE).0.into_owned();
        // encoding_rs' encode() falls back to UTF-8 for UTF-16 (WHATWG has no encoder for it).
        let mut utf16 = vec![0xFF, 0xFE];
        utf16.extend(GBK_SAMPLE.encode_utf16().flat_map(u16::to_le_bytes));
        let cases: Vec<(&str, Vec<u8>, &str, &str, bool)> = vec![
            ("utf8.java", GBK_SAMPLE.as_bytes().to_vec(), GBK_SAMPLE, "utf-8", false),
            ("bom.java", [b"\xEF\xBB\xBF", GBK_SAMPLE.as_bytes()].concat(), GBK_SAMPLE, "utf-8", true),
            ("gbk.java", gbk, GBK_SAMPLE, "gbk", false),
            ("utf16.java", utf16, GBK_SAMPLE, "utf-16le", true),
        ];
        for (name, bytes, text, encoding, has_bom) in cases {
            let jar_path = tmp.path().join(format!("lib-{name}.jar"));
            jar_bytes(&jar_path, &[(&format!("p/{name}"), &bytes)]);
            let loaded = read_entry(&jar_path, &format!("p/{name}"), None).unwrap_or_else(|| panic!("{name}"));
            assert_eq!(loaded.text, text, "{name}");
            assert_eq!(loaded.encoding, encoding, "{name}");
            assert_eq!(loaded.has_bom, has_bom, "{name}");
            assert!(!loaded.binary, "{name}");
        }
        // Binary entries are not shown as text.
        let jar_path = tmp.path().join("bin.jar");
        jar_bytes(&jar_path, &[("p/img.png", &[0x89, b'P', b'N', b'G', 0, 0, 0, 0])]);
        assert!(read_entry(&jar_path, "p/img.png", None).is_none());
        assert!(read_entry(&jar_path, "p/missing.java", None).is_none());
    }

    #[test]
    fn reload_decodes_archive_entries_with_the_chosen_encoding() {
        let tmp = tempfile::tempdir().unwrap();
        let jar_path = tmp.path().join("lib.jar");
        let gbk = encoding_rs::GBK.encode(GBK_SAMPLE).0.into_owned();
        jar_bytes(&jar_path, &[("p/EncodingSample.java", &gbk)]);
        let loaded = read_entry(&jar_path, "p/EncodingSample.java", Some("gbk")).unwrap();
        assert_eq!((loaded.text.as_str(), loaded.encoding.as_str()), (GBK_SAMPLE, "gbk"));
        // An explicit encoding wins over detection, even when it decodes to replacement characters.
        let forced = read_entry(&jar_path, "p/EncodingSample.java", Some("utf-8")).unwrap();
        assert!(forced.text.contains('\u{FFFD}'));
        assert_eq!(forced.encoding, "utf-8");
        assert!(read_entry(&jar_path, "p/EncodingSample.java", Some("not-an-encoding")).is_none());
    }

    #[test]
    fn class_sources_in_maven_caches_decode_non_utf8() {
        let tmp = tempfile::tempdir().unwrap();
        let m2 = tmp.path().join("m2/com/example/encoding-sample/1.0.0");
        let gbk = encoding_rs::GBK.encode(GBK_SAMPLE).0.into_owned();
        let facade = "@file:JvmName(\"SampleUtils\")\npackage example.encoding\n\n/** 中文注释。 */\nfun message() = \"中文编码测试：是否启用\"\n";
        let facade_gbk = encoding_rs::GBK.encode(facade).0.into_owned();
        jar(&m2.join("encoding-sample-1.0.0.jar"), &[]);
        jar_bytes(
            &m2.join("encoding-sample-1.0.0-sources.jar"),
            &[("example/encoding/EncodingSample.java", &gbk), ("example/encoding/Renamed.kt", &facade_gbk)],
        );
        let uri = |class: &str| {
            format!("jar://{}!/{class}", m2.join("encoding-sample-1.0.0.jar").to_string_lossy().replace('\\', "/"))
        };
        for (class, text) in
            [("example/encoding/EncodingSample.class", GBK_SAMPLE), ("example/encoding/SampleUtils.class", facade)]
        {
            let (source_uri, loaded) = class_source(&uri(class), None).unwrap_or_else(|| panic!("{class}"));
            assert!(
                source_uri.ends_with("-sources.jar!/example/encoding/EncodingSample.java")
                    || source_uri.ends_with("-sources.jar!/example/encoding/Renamed.kt")
            );
            assert_eq!(loaded.text, text, "{class}");
            assert_eq!(loaded.encoding, "gbk", "{class}");
            // The manually attached archive path decodes the same way.
            let jdt = "jdt://contents/encoding-sample-1.0.0.jar/example.encoding/EncodingSample.class?=project/x";
            let (_, attached) = source_in_archive(jdt, &m2.join("encoding-sample-1.0.0-sources.jar"), None).unwrap();
            assert_eq!((attached.text.as_str(), attached.encoding.as_str()), (GBK_SAMPLE, "gbk"));
        }
        // Reload with an explicit encoding re-reads the same source.
        let (_, reloaded) = class_source(&uri("example/encoding/EncodingSample.class"), Some("gbk")).unwrap();
        assert_eq!((reloaded.text.as_str(), reloaded.encoding.as_str()), (GBK_SAMPLE, "gbk"));
    }

    #[test]
    fn maps_class_folder_classes_to_project_sources() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let output = root.join(".cache/kotlin/main-0");
        std::fs::create_dir_all(output.join("test001")).unwrap();
        // As jdtls writes it: the class's source file name in the path, the library's
        // classpath attributes after the folder.
        let escaped = output.to_string_lossy().replace('/', "\\/");
        let handle = format!("=demo/{escaped}=/ai.openidea.kotlin=/true=/<test001(Db.class");
        let uri = format!("jdt://contents/main-0/test001/Db.kt?{}", utf8_percent_encode(&handle, PATH));
        assert_eq!(folder_class(&uri), Some(("test001".into(), "Db".into())));
        let plain = format!(
            "jdt://contents/main-0/test001/Db.class?{}",
            utf8_percent_encode(&format!("=demo/{escaped}<test001(Db.class"), PATH)
        );
        assert_eq!(folder_class(&plain), Some(("test001".into(), "Db".into())));
        let nested = format!(
            "jdt://contents/main-0/a.b/Db.kt?{}",
            utf8_percent_encode(&format!("=demo/{escaped}<a.b(Db$Companion.class"), PATH)
        );
        assert_eq!(folder_class(&nested), Some(("a/b".into(), "Db$Companion".into())));
        let jar = "jdt://contents/a.jar/p/C.class?=p/%5C/m2%5C/a.jar%3Cp%28C.class";
        assert_eq!(folder_class(jar), None, "a dependency jar");
        assert_eq!(folder_class(&uri.replace("main-0", "gone")), None);

        let write = |path: &str, text: &str| {
            let path = root.join(path);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, text).unwrap();
        };
        write("src/main/kotlin/test001/Db.kt", "package test001\n\nclass Db\n");
        write("src/main/kotlin/other/Db.kt", "package other\n\nclass Db\n");
        write("target/generated/test001/Db.kt", "package test001\n\nclass Db\n");
        write("src/main/kotlin/util/Strings.kt", "@file:JvmName(\"Strings\")\npackage util\n\nfun shout() = 1\n");
        write("src/main/kotlin/com/x/build/Tool.kt", "package com.x.build\n\nclass Tool\n");
        write("src/main/kotlin/flat/Elsewhere.kt", "");
        write("src/main/kotlin/Loose.kt", "package flat\n\nobject Loose\n");
        let source = |package: &str, class: &str| {
            project_class_source(root, package, class).map(|p| p.strip_prefix(root).unwrap().to_owned())
        };
        assert_eq!(source("test001", "Db"), Some(PathBuf::from("src/main/kotlin/test001/Db.kt")));
        assert_eq!(source("test001", "Db$Companion"), Some(PathBuf::from("src/main/kotlin/test001/Db.kt")));
        assert_eq!(source("other", "Db"), Some(PathBuf::from("src/main/kotlin/other/Db.kt")));
        assert_eq!(source("util", "StringsKt"), Some(PathBuf::from("src/main/kotlin/util/Strings.kt")));
        assert_eq!(source("com/x/build", "Tool"), Some(PathBuf::from("src/main/kotlin/com/x/build/Tool.kt")));
        assert_eq!(source("flat", "Loose"), Some(PathBuf::from("src/main/kotlin/Loose.kt")), "any directory");
        assert_eq!(source("test001", "Missing"), None);
        assert_eq!(declared_package("package a.b.c;\n"), "a.b.c");
        assert_eq!(declared_package("class A"), "");
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
        let java = "class Lib {\n    boolean caller(String s) { return isBlank(s); }\n    /**\n     * Changed signature from isBlank(String) to isBlank(CharSequence).\n     */\n    public static boolean isBlank(CharSequence cs) { return false; }\n}\n";
        assert_eq!(at(java, "isBlank"), (5, 26, 33), "the declaration, not a call or Javadoc signature");
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
