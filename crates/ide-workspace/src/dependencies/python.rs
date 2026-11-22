//! Python requirements in `requirements*.txt` and `pyproject.toml`. Whether one is
//! satisfied is up to the interpreter (`ide-sdk`): markers depend on it.
use super::ManifestDependency;
use std::path::Path;
use toml_edit::{Document, Item, TableLike};

/// `requirements.txt`, `requirements-dev.txt`, `requirements_test.txt`.
pub fn is_requirements_file(name: &str) -> bool {
    name.starts_with("requirements") && name.ends_with(".txt")
}

#[derive(Clone, Debug)]
pub struct PythonRequirement {
    /// `requirement` is the PEP 508 string and `from..to` its UTF-16 span.
    pub dependency: ManifestDependency,
    /// The requirements-file line that installs it (with its `--hash`es); `None` when pip
    /// alone wouldn't install it from where the project means (uv sources, own indexes).
    pub install: Option<String>,
}

#[derive(Debug, Default)]
pub struct PythonManifest {
    pub requirements: Vec<PythonRequirement>,
    /// Options every install from this file needs (`--index-url`, `-c <absolute path>`,
    /// `--require-hashes`), including those of files it includes with `-r`.
    pub options: Vec<String>,
}

/// The requirements of the manifest `path`, whose text is `text`; `read` loads files it includes.
pub fn manifest(path: &Path, text: &str, read: &dyn Fn(&Path) -> Option<String>) -> PythonManifest {
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or_default();
    let dir = path.parent().unwrap_or(Path::new(""));
    if name == "pyproject.toml" {
        pyproject(text)
    } else if is_requirements_file(name) {
        let mut manifest = PythonManifest::default();
        requirements_txt(text, dir, read, 0, &mut manifest);
        manifest
    } else {
        PythonManifest::default()
    }
}

/// PEP 503: `Typing_Extensions` and `typing.extensions` are `typing-extensions`.
fn normalize(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    for c in name.chars() {
        if matches!(c, '-' | '_' | '.') {
            if !out.ends_with('-') {
                out.push('-');
            }
        } else {
            out.push(c.to_ascii_lowercase());
        }
    }
    out
}

const ARCHIVES: [&str; 11] =
    [".whl", ".zip", ".tar", ".tar.gz", ".tgz", ".tar.bz2", ".tbz", ".tar.xz", ".txz", ".tar.lz", ".tlz"];

/// The distribution name a requirement starts with, if it names one (not a URL, path or archive).
fn named(requirement: &str) -> Option<String> {
    let end = requirement
        .find(|c: char| !(c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.')))
        .unwrap_or(requirement.len());
    let name = requirement[..end].trim_end_matches(['.', '-', '_']);
    let rest = requirement[end..].trim_start();
    let direct = rest.starts_with('@');
    if name.is_empty()
        || !name.as_bytes()[0].is_ascii_alphanumeric()
        || rest.starts_with([':', '/', '\\'])
        || !direct && ARCHIVES.iter().any(|ext| requirement.to_ascii_lowercase().ends_with(ext))
        || requirement.contains("://") && !direct && !rest.starts_with('[')
    {
        return None;
    }
    Some(name.to_owned())
}

fn utf16(text: &str, byte: usize) -> u32 {
    text[..byte].encode_utf16().count() as u32
}

/// pip's logical lines: a line ending in `\` continues on the next, except a comment line.
/// Each comes with the byte offset in `text` of every byte it keeps.
fn logical_lines(text: &str) -> Vec<(String, Vec<usize>)> {
    let mut out = Vec::new();
    let mut joined = String::new();
    let mut origin = Vec::new();
    let mut start = 0;
    for line in text.split_inclusive('\n') {
        let body = line.trim_end_matches(['\n', '\r']);
        let comment = body.trim_start().starts_with('#');
        let continued = body.ends_with('\\') && !comment;
        let kept = if continued { &body[..body.len() - 1] } else { body };
        joined.push_str(kept);
        origin.extend(start..start + kept.len());
        start += line.len();
        if !continued {
            out.push((std::mem::take(&mut joined), std::mem::take(&mut origin)));
        }
    }
    if !joined.is_empty() {
        out.push((joined, origin));
    }
    out
}

/// The line without its comment: `#` at the start or after whitespace.
fn strip_comment(line: &str) -> &str {
    let bytes = line.as_bytes();
    let cut = (0..bytes.len())
        .find(|&i| bytes[i] == b'#' && (i == 0 || bytes[i - 1].is_ascii_whitespace()))
        .unwrap_or(line.len());
    line[..cut].trim_end()
}

/// The value of option `short`/`long`: `-c x`, `-cx`, `--constraint x`, `--constraint=x`.
fn option_value<'a>(line: &'a str, short: &str, long: &str) -> Option<&'a str> {
    let mut tokens = line.split_whitespace();
    let first = tokens.next()?;
    if first == short || first == long {
        return tokens.next();
    }
    first.strip_prefix(&format!("{long}=")).or_else(|| first.strip_prefix(short).filter(|v| !v.is_empty()))
}

fn is_local(value: &str) -> bool {
    !value.contains("://")
}

/// An option line made independent of the file's folder: local paths of `-c` / `-f` absolute.
fn absolute_option(line: &str, dir: &Path) -> String {
    for (short, long) in [("-c", "--constraint"), ("-f", "--find-links")] {
        if let Some(value) = option_value(line, short, long).filter(|v| is_local(v) && Path::new(v).is_relative()) {
            return format!("{long} {}", dir.join(value).display());
        }
    }
    line.to_owned()
}

fn requirements_txt(
    text: &str,
    dir: &Path,
    read: &dyn Fn(&Path) -> Option<String>,
    depth: usize,
    out: &mut PythonManifest,
) {
    for (line, origin) in logical_lines(text) {
        let content = strip_comment(&line);
        let lead = content.len() - content.trim_start().len();
        let content = content.trim_start();
        if content.is_empty() {
            continue;
        }
        if content.starts_with('-') {
            if let Some(value) = option_value(content, "-r", "--requirement") {
                // An included file's options apply to the whole install; its requirements belong to it.
                let file = dir.join(value);
                if depth < 8
                    && is_local(value)
                    && let Some(included) = read(&file)
                {
                    let mut nested = PythonManifest::default();
                    requirements_txt(&included, file.parent().unwrap_or(dir), read, depth + 1, &mut nested);
                    out.options.extend(nested.options);
                }
            } else if option_value(content, "-e", "--editable").is_none() {
                out.options.push(absolute_option(content, dir));
            }
            continue;
        }
        if depth > 0 {
            continue;
        }
        // Per-requirement options (`--hash`) start at the first whitespace-separated `-` token.
        let requirement_len = content
            .char_indices()
            .find(|&(i, c)| c == '-' && i > 0 && content.as_bytes()[i - 1].is_ascii_whitespace())
            .map_or(content.len(), |(i, _)| i);
        let requirement = content[..requirement_len].trim_end();
        let Some(package) = named(requirement) else { continue };
        let end = lead + requirement.len();
        out.requirements.push(PythonRequirement {
            dependency: ManifestDependency {
                package,
                requirement: requirement.to_owned(),
                from: utf16(text, origin[lead]),
                to: utf16(text, origin[end - 1] + 1),
            },
            install: Some(content.to_owned()),
        });
    }
}

/// Only `[project].dependencies`: extras and dependency groups are optional by design.
fn pyproject(text: &str) -> PythonManifest {
    let Ok(doc) = text.parse::<Document<String>>() else { return PythonManifest::default() };
    let Some(project) = doc.get("project").and_then(Item::as_table_like) else { return PythonManifest::default() };
    let own = project.get("name").and_then(Item::as_str).map(normalize);
    let tool = |path: &[&str]| -> Option<&Item> {
        path.iter().try_fold(doc.get("tool")?, |item, key| item.as_table_like()?.get(key))
    };
    // Packages the project gets from its own indexes, which a plain pip install wouldn't use.
    let own_index = [
        &["uv", "index"][..],
        &["uv", "index-url"],
        &["uv", "extra-index-url"],
        &["uv", "find-links"],
        &["uv", "no-index"],
        &["poetry", "source"],
        &["pdm", "source"],
    ]
    .iter()
    .any(|path| tool(path).is_some());
    let sources = tool(&["uv", "sources"]).and_then(Item::as_table_like);
    let source = |name: &str| -> Option<&Item> {
        let sources: &dyn TableLike = sources?;
        sources.iter().find(|(key, _)| normalize(key) == name).map(|(_, item)| item)
    };
    let mut out = PythonManifest::default();
    let Some(array) = project.get("dependencies").and_then(Item::as_array) else { return out };
    for value in array.iter() {
        let (Some(requirement), Some(span)) = (value.as_str(), value.span()) else { continue };
        let Some(raw) = text.get(span.clone()) else { continue };
        let requirement = requirement.trim();
        let Some(package) = named(requirement) else { continue };
        let name = normalize(&package);
        let source = source(&name);
        let member = source.and_then(|s| s.get("workspace")).and_then(Item::as_bool) == Some(true);
        if own.as_deref() == Some(name.as_str()) || member {
            continue;
        }
        let delimiter = if raw.starts_with("\"\"\"") || raw.starts_with("'''") { 3 } else { 1 };
        out.requirements.push(PythonRequirement {
            dependency: ManifestDependency {
                package,
                requirement: requirement.to_owned(),
                from: utf16(text, span.start + delimiter),
                to: utf16(text, span.end - delimiter),
            },
            install: (!own_index && source.is_none()).then(|| requirement.to_owned()),
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn no_files(_: &Path) -> Option<String> {
        None
    }

    type Row = (String, String, String, Option<String>);

    /// (package, requirement, span text, install line).
    fn rows(m: &PythonManifest, text: &str) -> Vec<Row> {
        let units: Vec<u16> = text.encode_utf16().collect();
        m.requirements
            .iter()
            .map(|r| {
                let d = &r.dependency;
                let span = String::from_utf16(&units[d.from as usize..d.to as usize]).unwrap();
                (d.package.clone(), d.requirement.clone(), span, r.install.clone())
            })
            .collect()
    }

    fn row(p: &str, r: &str, span: &str, install: Option<&str>) -> Row {
        (p.into(), r.into(), span.into(), install.map(Into::into))
    }

    #[test]
    fn requirements_txt_keeps_named_requirements_only() {
        let text = "# 中文 😀 comment\n\
            Django>=4.2,<5 # web\n\
            typing_extensions\n\
            requests[socks]==2.31.0 ; python_version >= \"3.8\"\n\
            -e ./local\n\
            ./pkg\n\
            /abs/path\n\
            https://example.com/x.tar.gz\n\
            foo-1.0-py3-none-any.whl\n\
            bar-2.0.tar.bz2\n\
            baz-1.0.TAR.XZ\n\
            pkg @ https://example.com/pkg.zip\n\
            black --config-settings=x=y\n";
        let m = manifest(Path::new("/p/requirements.txt"), text, &no_files);
        let marker = "requests[socks]==2.31.0 ; python_version >= \"3.8\"";
        let url = "pkg @ https://example.com/pkg.zip";
        assert_eq!(
            rows(&m, text),
            [
                row("Django", "Django>=4.2,<5", "Django>=4.2,<5", Some("Django>=4.2,<5")),
                row("typing_extensions", "typing_extensions", "typing_extensions", Some("typing_extensions")),
                row("requests", marker, marker, Some(marker)),
                row("pkg", url, url, Some(url)),
                row("black", "black", "black", Some("black --config-settings=x=y")),
            ]
        );
    }

    #[test]
    fn continuation_lines_join_like_pip_but_comments_do_not() {
        let text = "numpy==1.26.4 \\\n    --hash=sha256:abc \\\n    --hash=sha256:def\n\
            foo==1.0 \\\n    ; python_version < '3.8'\n\
            # note \\\n\
            django\n";
        let m = manifest(Path::new("/p/requirements.txt"), text, &no_files);
        assert_eq!(
            rows(&m, text),
            [
                row(
                    "numpy",
                    "numpy==1.26.4",
                    "numpy==1.26.4",
                    Some("numpy==1.26.4     --hash=sha256:abc     --hash=sha256:def")
                ),
                row(
                    "foo",
                    "foo==1.0     ; python_version < '3.8'",
                    "foo==1.0 \\\n    ; python_version < '3.8'",
                    Some("foo==1.0     ; python_version < '3.8'")
                ),
                row("django", "django", "django", Some("django")),
            ]
        );
    }

    #[test]
    fn install_options_include_indexes_constraints_and_included_files() {
        let text = "--index-url https://private.example/simple\n\
            --extra-index-url=https://mirror.example/simple # second\n\
            -c constraints.txt\n\
            --find-links=wheels\n\
            -f https://example.com/links\n\
            --require-hashes\n\
            -r base/common.txt\n\
            -e .\n\
            internal-pkg==1.0\n";
        let read = |path: &Path| {
            (path == Path::new("/p/base/common.txt"))
                .then(|| "--trusted-host private.example\n-c pins.txt\ncommon-only==1\n".to_owned())
        };
        let m = manifest(Path::new("/p/requirements.txt"), text, &read);
        let abs = |p: &str| PathBuf::from(p).display().to_string();
        assert_eq!(
            m.options,
            [
                "--index-url https://private.example/simple".to_owned(),
                "--extra-index-url=https://mirror.example/simple".to_owned(),
                format!("--constraint {}", abs("/p/constraints.txt")),
                format!("--find-links {}", abs("/p/wheels")),
                "-f https://example.com/links".to_owned(),
                "--require-hashes".to_owned(),
                "--trusted-host private.example".to_owned(),
                format!("--constraint {}", abs("/p/base/pins.txt")),
            ]
        );
        assert_eq!(rows(&m, text).len(), 1, "requirements of an included file stay its own");
    }

    #[test]
    fn requirements_files_by_name() {
        assert!(is_requirements_file("requirements.txt"));
        assert!(is_requirements_file("requirements-dev.txt"));
        assert!(!is_requirements_file("constraints.txt"));
        assert!(manifest(Path::new("/p/notes.txt"), "django\n", &no_files).requirements.is_empty());
    }

    #[test]
    fn pyproject_checks_project_dependencies_without_self_or_workspace_members() {
        let text = r#"[build-system]
requires = ["setuptools"]

[project]
name = "Demo_App"
dependencies = [
  "flask>=3",   # 注释
  'PyYAML',
  "demo-app[docs]",
  "member-lib",
  "local-lib",
]

[project.optional-dependencies]
test = ["pytest>=8"]

[dependency-groups]
dev = ["ruff"]

[tool.uv.sources]
Member_Lib = { workspace = true }
local-lib = { path = "../local" }
"#;
        let m = manifest(Path::new("/p/pyproject.toml"), text, &no_files);
        assert_eq!(
            rows(&m, text),
            [
                row("flask", "flask>=3", "flask>=3", Some("flask>=3")),
                row("PyYAML", "PyYAML", "PyYAML", Some("PyYAML")),
                row("local-lib", "local-lib", "local-lib", None),
            ]
        );
        assert!(m.options.is_empty());
        assert!(manifest(Path::new("/p/pyproject.toml"), "[project\n", &no_files).requirements.is_empty());
    }

    #[test]
    fn pyproject_with_its_own_index_is_not_installed_by_pip() {
        let text = "[project]\nname = \"x\"\ndependencies = [\"internal-pkg==1.0\"]\n\n\
            [[tool.uv.index]]\nname = \"private\"\nurl = \"https://private.example/simple\"\n";
        let m = manifest(Path::new("/p/pyproject.toml"), text, &no_files);
        assert_eq!(m.requirements.len(), 1);
        assert_eq!(m.requirements[0].install, None);
    }

    #[test]
    fn names_normalize_per_pep_503() {
        assert_eq!(normalize("Typing__Extensions"), "typing-extensions");
        assert_eq!(normalize("zope.interface"), "zope-interface");
    }
}
