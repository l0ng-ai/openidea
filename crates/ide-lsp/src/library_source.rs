//! `jar:` URIs (`jar:///…/lib.jar!/pkg/Name.class`, also `jar:file:///…`) that
//! language servers return for library code: the official Kotlin LSP for the
//! classes of a dependency, Metals and others for entries of a sources jar.
//! Not every server can serve their contents (`workspace/textDocumentContent`),
//! so they are read here, where the jars are (also on a remote backend): an
//! entry as is, a class as its source from the artifact's `-sources.jar` next to
//! it in the Maven or Gradle cache.

use ide_core::{Location, Pos, Range};
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

/// Whether `loc` is a compiled class a language server answered with: a
/// `jar:` entry, a `jdt://contents/` class-file handle (recent jdtls writes a
/// `.java` / `.kt` name and keeps the `.class` in the query) or a `.class`
/// file on disk.
pub(crate) fn is_binary_class(loc: &Location) -> bool {
    if let Some(uri) = loc.uri.as_deref() {
        if let Some(entry) = parse(uri) {
            return entry.entry.ends_with(".class");
        }
        return binary_class(uri, None).is_some();
    }
    loc.path.extension().is_some_and(|e| e == "class")
}

/// The binary class `loc` names, as `package/name` (`test001/Db`,
/// `pkg/Outer$Inner`, `org/foo/FileKt`): a `jdt://contents/…` handle or a
/// `.class` file under a module's output directory.
fn binary_class(uri: &str, path: Option<&Path>) -> Option<(String, String)> {
    if let Some(rest) = uri.strip_prefix("jdt://contents/") {
        // jdt://contents/<container>/<package>/<Name.class>?=…<package(Name.class
        let (base, query) = rest.split_once('?').unwrap_or((rest, ""));
        let segments: Vec<String> = base
            .split('/')
            .filter(|s| !s.is_empty())
            .map(|s| percent_decode_str(s).decode_utf8_lossy().into_owned())
            .collect();
        let [.., package, name] = segments.as_slice() else { return None };
        // The handle itself is binary when the name is the class or the query
        // carries the real `.class` reference (`<test001(Db.class`).
        let query = percent_decode_str(query).decode_utf8_lossy().into_owned();
        if !name.ends_with(".class") && !query.contains(".class") {
            return None;
        }
        // A class served from a jar (a dependency, the JDK) has no source in this
        // project; only folder containers (module output, the Kotlin bridge's
        // published libraries) can be looked up.
        let container = segments.first().map(String::as_str).unwrap_or_default();
        if container.ends_with(".jar")
            || container.ends_with(".jmod")
            || query.contains(".jar")
            || query.contains(".jmod")
        {
            return None;
        }
        let name =
            name.strip_suffix(".class").or_else(|| name.strip_suffix(".java")).or_else(|| name.strip_suffix(".kt"))?;
        // The package is one dotted segment after the container; a class of the
        // default package has none (`jdt://contents/dir/C.class`).
        let package = if segments.len() >= 3 { package.replace('.', "/") } else { String::new() };
        return Some((package, name.to_owned()));
    }
    if uri.is_empty() {
        let path = path?;
        if path.extension().is_some_and(|e| e != "class") {
            return None;
        }
        let name = path.file_stem()?.to_str()?.to_owned();
        // The package is the directories between the file and the last build-output
        // directory (or the module root, when the output has a custom location).
        let mut package = Vec::new();
        let mut bounded = false;
        for ancestor in path.parent()?.ancestors().take(8) {
            let dir = ancestor.file_name()?.to_str()?.to_owned();
            if OUTPUT_DIRS.contains(&dir.as_str()) || MODULE_MARKERS.iter().any(|m| ancestor.join(m).is_file()) {
                bounded = true;
                break;
            }
            package.push(dir);
        }
        if !bounded {
            return None;
        }
        package.reverse();
        return Some((package.join("/"), name));
    }
    None
}

const MODULE_MARKERS: [&str; 5] =
    ["pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"];

/// Build-output directory names that end the package path of a disk `.class`
/// (`target/classes/pkg/Name.class`, `build/classes/kotlin/main/pkg/Name.class`).
const OUTPUT_DIRS: [&str; 5] = ["target", "build", "out", "bin", "classes"];

/// Directories the search for a project's Kotlin source never enters.
const SKIP_DIRS: [&str; 11] =
    ["target", "build", "out", "bin", "node_modules", ".git", ".openidea", ".gradle", ".idea", ".settings", ".vscode"];

/// The source location of a binary class target: for a `jar:` entry its
/// `.kt` / `.java` file in the artifact's sources jar, for a compiled class of
/// this project its Kotlin source (`#2969` — a Java file's Go to Definition on
/// a Kotlin class must open the `.kt`, not the decompiled `.class`).
/// `None` keeps the original location.
pub(crate) fn class_location(loc: &Location, root: &Path, name: Option<&str>) -> Option<Location> {
    let uri = loc.uri.as_deref().unwrap_or("");
    if let Some(entry) = parse(uri) {
        let class = entry.entry.strip_suffix(".class")?;
        for sources in sources_jars(&entry.jar) {
            if let Some((source, loaded)) = source_entry(&sources, class, None) {
                let range = name
                    .or_else(|| class.rsplit(['/', '$']).next())
                    .map(|n| declaration_range(&loaded.text, n))
                    .unwrap_or_default();
                return Some(Location {
                    path: entry.uri_of(&sources, &source).into(),
                    range,
                    uri: Some(entry.uri_of(&sources, &source)),
                });
            }
        }
        return None;
    }
    let (package, class) = binary_class(uri, Some(&loc.path))?;
    let file = project_kotlin_source(root, &package, &class)?;
    let text = std::fs::read_to_string(&file).ok()?;
    if !declares_package(&text, &package.replace('/', ".")) {
        return None;
    }
    let range = name.or_else(|| class.rsplit('$').next()).map(|n| declaration_range(&text, n)).unwrap_or_default();
    Some(Location { path: file.into(), range, uri: None })
}

/// The project's Kotlin source declaring `class`: `<…>/<package path>/<Outer>.kt`
/// under `root`, build directories skipped, `main` sources preferred over `test`.
/// The file must declare `package`; a same-named file elsewhere is not taken.
fn project_kotlin_source(root: &Path, package: &str, class: &str) -> Option<PathBuf> {
    let outer = class.split('$').next().unwrap_or(class);
    let mut files = vec![format!("{outer}.kt")];
    // Top-level Kotlin declarations compile to a `<File>Kt` facade class.
    if let Some(file) = outer.strip_suffix("Kt").filter(|f| !f.is_empty()) {
        files.push(format!("{file}.kt"));
    }
    let package_dir = if package.is_empty() {
        PathBuf::new()
    } else {
        PathBuf::from(package.replace('/', std::path::MAIN_SEPARATOR_STR))
    };
    // The declaration in the file is dotted (`package org.app`).
    find_kotlin_source(root, &package_dir, &files, &package.replace('/', "."), outer, 0)
}

fn find_kotlin_source(
    dir: &Path,
    package_dir: &Path,
    files: &[String],
    dotted: &str,
    outer: &str,
    depth: usize,
) -> Option<PathBuf> {
    if depth > 12 {
        return None;
    }
    let pkg = dir.join(package_dir);
    for file in files {
        let candidate = pkg.join(file);
        let declares = candidate.is_file()
            && std::fs::read_to_string(&candidate).is_ok_and(|text| declares_package(&text, dotted));
        if declares {
            return Some(candidate);
        }
    }
    // A nested class lives in the outer class's file, which may be named
    // differently (`Utils.kt` declares `class Outer` for `Outer$Inner`).
    if !package_dir.as_os_str().is_empty()
        && let Ok(entries) = std::fs::read_dir(&pkg)
    {
        for entry in entries.flatten() {
            let candidate = entry.path();
            if candidate.extension().is_some_and(|e| e != "kt") {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(&candidate) else { continue };
            if declares_package(&text, dotted) && declaration_range(&text, outer) != Range::default() {
                return Some(candidate);
            }
        }
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return None };
    // `main` sources first: the declaration the language server attached is likelier there.
    let mut dirs: Vec<PathBuf> = entries
        .flatten()
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .map(|e| e.path())
        .filter(|d| !d.file_name().is_some_and(|n| SKIP_DIRS.contains(&n.to_str().unwrap_or_default())))
        .collect();
    dirs.sort_by_key(|d| d.file_name().and_then(|n| n.to_str()).map(|n| n.contains("test")).unwrap_or(false));
    for subdir in dirs {
        if let Some(found) = find_kotlin_source(&subdir, package_dir, files, dotted, outer, depth + 1) {
            return Some(found);
        }
    }
    None
}

/// Whether a Kotlin source declares `package` (the default package: none does).
fn declares_package(text: &str, package: &str) -> bool {
    for line in text.lines() {
        let line = line.trim_start();
        if line.is_empty()
            || line.starts_with("//")
            || line.starts_with("/*")
            || line.starts_with('*')
            || line.starts_with('@')
        {
            continue;
        }
        let declared = line.strip_prefix("package ").map(|rest| rest.trim_end_matches(';').trim());
        return match package.is_empty() {
            true => declared.is_none(),
            false => declared == Some(package),
        };
    }
    false
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

    fn location(uri: &str) -> Location {
        Location {
            path: uri.into(),
            range: Range { start: Pos::default(), end: Pos::default() },
            uri: Some(uri.to_owned()),
        }
    }

    fn disk_location(path: &Path) -> Location {
        Location { path: path.into(), range: Range { start: Pos::default(), end: Pos::default() }, uri: None }
    }

    #[test]
    fn binary_class_names_from_jdt_and_disk_targets() {
        // #2969, as jdtls 1.63 answers from the Kotlin bridge's published library:
        // the handle names the source file, the query keeps the compiled class.
        let bridged = "jdt://contents/published-0/test001/Db.kt?=mixed/C:%5C/Users%5C/me%5C/published-0=/ai.openidea.kotlin=/true=/%3Ctest001%28Db.class";
        assert_eq!(binary_class(bridged, None), Some(("test001".to_owned(), "Db".to_owned())));
        assert_eq!(
            binary_class("jdt://contents/published-0/org.springframework.boot/SpringApplication.class?=x", None),
            Some(("org/springframework/boot".to_owned(), "SpringApplication".to_owned()))
        );
        assert_eq!(
            binary_class("jdt://contents/published-0/p/Outer$Inner.class?=x", None),
            Some(("p".to_owned(), "Outer$Inner".to_owned()))
        );
        assert_eq!(binary_class("jdt://contents/published-0/C.class?=x", None), Some(("".to_owned(), "C".to_owned())));
        assert_eq!(
            binary_class("jdt://contents/published-0/test001/MainKt.kt?=x/%3Ctest001%28MainKt.class", None),
            Some(("test001".to_owned(), "MainKt".to_owned()))
        );
        // A `jdt://` URI without a compiled class reference is not a binary handle.
        assert_eq!(binary_class("jdt://contents/published-0/p/Lib.java?=x", None), None);
        // A class served from a jar — a dependency or the JDK — has no project
        // source, whether the jar is the container or only named in the query.
        assert_eq!(binary_class("jdt://contents/a.jar/p/C.class?=x/%5C/m2%5C/a.jar", None), None);
        assert_eq!(
            binary_class(
                "jdt://contents/java.base/java.lang/String.class?=p/%5C/jdk%5C/lib%5C/jrt-fs.jar%60java.base=x",
                None
            ),
            None
        );
        // A class file under a module's output directory: the package is what is
        // between the file and the build-output directory (or the module root).
        let tmp = tempfile::tempdir().unwrap();
        let class = tmp.path().join("module/target/classes/test001/Db.class");
        std::fs::create_dir_all(class.parent().unwrap()).unwrap();
        std::fs::write(tmp.path().join("module/pom.xml"), "").unwrap();
        assert_eq!(binary_class("", Some(&class)), Some(("test001".to_owned(), "Db".to_owned())));
        // Without a module root the package cannot be told, so nothing is mapped.
        let orphan = tmp.path().join("no-marker/Db.class");
        std::fs::create_dir_all(orphan.parent().unwrap()).unwrap();
        std::fs::write(&orphan, "").unwrap();
        assert_eq!(binary_class("", Some(&orphan)), None);
    }

    #[test]
    fn is_binary_class_covers_jar_jdt_and_disk_targets() {
        assert!(is_binary_class(&location(
            "jar:///m2/lib.jar!/org/springframework/boot/SpringApplicationExtensionsKt.class"
        )));
        assert!(is_binary_class(&location(
            "jdt://contents/published-0/test001/Db.kt?=mixed/x=/ai.openidea.kotlin=/true=/%3Ctest001%28Db.class"
        )));
        let tmp = tempfile::tempdir().unwrap();
        let class = tmp.path().join("target/classes/Db.class");
        std::fs::create_dir_all(class.parent().unwrap()).unwrap();
        std::fs::write(&class, "").unwrap();
        assert!(is_binary_class(&disk_location(&class)));
        assert!(!is_binary_class(&location("jar:///m2/lib.jar!/org/example/Lib.java")));
        // Classes of jars and the JDK are not looked up in the project.
        assert!(!is_binary_class(&location("jdt://contents/a.jar/p/C.class?=x/%5C/m2%5C/a.jar")));
        assert!(!is_binary_class(&location(
            "jdt://contents/java.base/java.lang/String.class?=p/%5C/jdk%5C/lib%5C/jrt-fs.jar%60java.base=x"
        )));
        assert!(!is_binary_class(&disk_location(tmp.path().join("Lib.java").as_path())));
    }

    /// #2969: the mixed Maven project, `new Db()` navigating from Java.
    const DB: &str = "package test001\n\nclass Db {\n    fun query(): String = \"ok\"\n}\n";

    fn mixed_project() -> (tempfile::TempDir, PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("pom.xml"), "").unwrap();
        let source = tmp.path().join("src/main/kotlin/test001/Db.kt");
        std::fs::create_dir_all(source.parent().unwrap()).unwrap();
        std::fs::write(&source, DB).unwrap();
        let path = source;
        (tmp, path)
    }

    #[test]
    fn a_bridged_kotlin_class_navigates_to_its_source() {
        let (tmp, source) = mixed_project();
        let bridged = "jdt://contents/published-0/test001/Db.kt?=mixed/C:%5C/Users%5C/me%5C/published-0=/ai.openidea.kotlin=/true=/%3Ctest001%28Db.class";
        let found = class_location(&location(bridged), tmp.path(), Some("Db")).unwrap();
        assert_eq!(found.path, source.as_path());
        assert_eq!(found.uri, None, "the source opens as a real file");
        assert_eq!((found.range.start.line, found.range.start.col), (2, 6), "at `class Db`");
    }

    #[test]
    fn a_bridged_class_member_navigates_to_its_declaration() {
        let (tmp, _) = mixed_project();
        let bridged = "jdt://contents/published-0/test001/Db.kt?=mixed/x=/%3Ctest001%28Db.class";
        let found = class_location(&location(bridged), tmp.path(), Some("query")).unwrap();
        assert_eq!((found.range.start.line, found.range.start.col), (3, 8), "at `fun query(`");
    }

    #[test]
    fn a_disk_class_navigates_to_its_source() {
        let (tmp, source) = mixed_project();
        let class = tmp.path().join("target/classes/test001/Db.class");
        std::fs::create_dir_all(class.parent().unwrap()).unwrap();
        std::fs::write(&class, "binary").unwrap();
        let found = class_location(&disk_location(&class), tmp.path(), Some("Db")).unwrap();
        assert_eq!(found.path, source.as_path());
    }

    #[test]
    fn facades_and_nested_classes_find_their_files() {
        let tmp = tempfile::tempdir().unwrap();
        let util = tmp.path().join("src/main/kotlin/org/app/Utils.kt");
        std::fs::create_dir_all(util.parent().unwrap()).unwrap();
        std::fs::write(
            &util,
            "@file:JvmName(\"UtilsKt\")\npackage org.app\n\nfun util() {}\n\nclass Outer {\n    class Inner\n}\n",
        )
        .unwrap();
        // Top-level functions compile to a `UtilsKt` facade class.
        let facade = class_location(
            &location("jdt://contents/out/org.app/UtilsKt.kt?=x/%3Corg.app%28UtilsKt.class"),
            tmp.path(),
            Some("util"),
        )
        .unwrap();
        assert_eq!(facade.path, util.as_path());
        // A nested class lives in the outer class's file, at `class Inner`.
        let nested = class_location(
            &location("jdt://contents/out/org.app/Outer$Inner.class?=x/%3Corg.app%28Outer$Inner.class"),
            tmp.path(),
            None,
        )
        .unwrap();
        assert_eq!(nested.path, util.as_path());
        assert_eq!(nested.range.start.line, 6);
    }

    #[test]
    fn only_sources_of_the_class_package_are_taken() {
        let tmp = tempfile::tempdir().unwrap();
        let other = tmp.path().join("src/main/kotlin/test001/Db.kt");
        std::fs::create_dir_all(other.parent().unwrap()).unwrap();
        std::fs::write(&other, "package other\n\nclass Db\n").unwrap();
        let bridged = "jdt://contents/out/test001/Db.kt?=x/%3Ctest001%28Db.class";
        // No candidate declares `package test001`, so the .class stays.
        assert_eq!(class_location(&location(bridged), tmp.path(), Some("Db")), None);
        let right = tmp.path().join("module/src/main/kotlin/test001/Db.kt");
        std::fs::create_dir_all(right.parent().unwrap()).unwrap();
        std::fs::write(&right, DB).unwrap();
        let found = class_location(&location(bridged), tmp.path(), Some("Db")).unwrap();
        assert_eq!(found.path, right.as_path());
    }

    #[test]
    fn main_sources_are_preferred_over_test_sources() {
        let tmp = tempfile::tempdir().unwrap();
        for (root, text) in [
            (tmp.path().join("src/test/kotlin/test001"), "package test001\n\nclass Db\n"),
            (tmp.path().join("src/main/kotlin/test001"), DB),
        ] {
            std::fs::create_dir_all(&root).unwrap();
            std::fs::write(root.join("Db.kt"), text).unwrap();
        }
        let found = class_location(
            &location("jdt://contents/out/test001/Db.kt?=x/%3Ctest001%28Db.class"),
            tmp.path(),
            Some("Db"),
        )
        .unwrap();
        assert!(found.path.starts_with(tmp.path().join("src/main/kotlin")));
    }

    #[test]
    fn build_directories_are_not_sources() {
        let tmp = tempfile::tempdir().unwrap();
        for path in [
            tmp.path().join("target/classes/test001/Db.kt"),
            tmp.path().join("build/test001/Db.kt"),
            tmp.path().join("node_modules/x/test001/Db.kt"),
        ] {
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, DB).unwrap();
        }
        assert_eq!(
            class_location(
                &location("jdt://contents/out/test001/Db.kt?=x/%3Ctest001%28Db.class"),
                tmp.path(),
                Some("Db")
            ),
            None
        );
    }

    #[test]
    fn missing_sources_keep_the_compiled_class() {
        let tmp = tempfile::tempdir().unwrap();
        let bridged = "jdt://contents/published-0/test001/Gone.kt?=mixed/x=/%3Ctest001%28Gone.class";
        assert_eq!(class_location(&location(bridged), tmp.path(), Some("Gone")), None);
    }

    #[test]
    fn jar_classes_still_open_their_sources_jar() {
        let tmp = tempfile::tempdir().unwrap();
        let m2 = tmp.path().join("m2/g/lib/1");
        jar(&m2.join("lib-1.jar"), &[]);
        jar(&m2.join("lib-1-sources.jar"), &[("p/Lib.java", "package p\npublic class Lib {}\n")]);
        let uri = format!("jar://{}/lib-1.jar!/p/Lib.class", m2.to_string_lossy().replace('\\', "/"));
        let found = class_location(&location(&uri), tmp.path(), Some("Lib")).unwrap();
        assert!(found.uri.unwrap().ends_with("-sources.jar!/p/Lib.java"));
    }

    #[test]
    fn kotlin_sources_declare_their_package() {
        assert!(declares_package(DB, "test001"));
        assert!(declares_package("package a.b.c;\nclass X", "a.b.c"));
        assert!(declares_package("// note\n/** doc */\n@file:JvmName(\"X\")\npackage a.b\n", "a.b"));
        assert!(declares_package("class Default", ""));
        assert!(!declares_package("package other\n", "test001"));
        assert!(!declares_package("", "test001"));
    }
}
