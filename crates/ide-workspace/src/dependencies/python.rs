//! Python requirements in `requirements*.txt` and `pyproject.toml`. Whether one is
//! satisfied is up to the interpreter (`ide-sdk`): markers and PEP 440 depend on it.
use super::ManifestDependency;
use toml_edit::{Document, Item};

/// `requirements.txt`, `requirements-dev.txt`, `requirements/base.txt`'s siblings named alike.
pub fn is_requirements_file(name: &str) -> bool {
    name.starts_with("requirements") && name.ends_with(".txt")
}

/// The requirements of a manifest, by file name; `requirement` is the PEP 508 string
/// and `from..to` its UTF-16 span.
pub fn requirements(file_name: &str, text: &str) -> Vec<ManifestDependency> {
    if file_name == "pyproject.toml" {
        pyproject(text)
    } else if is_requirements_file(file_name) {
        requirements_txt(text)
    } else {
        Vec::new()
    }
}

/// The distribution name a requirement starts with, if it names one (not a URL, path or archive).
fn named(requirement: &str) -> Option<ManifestDependency> {
    let end = requirement
        .find(|c: char| !(c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.')))
        .unwrap_or(requirement.len());
    let name = requirement[..end].trim_end_matches(['.', '-', '_']);
    let rest = requirement[end..].trim_start();
    if name.is_empty()
        || !name.as_bytes()[0].is_ascii_alphanumeric()
        || rest.starts_with([':', '/', '\\'])
        || !rest.starts_with('@') && [".whl", ".zip", ".tar.gz", ".tgz"].iter().any(|ext| requirement.ends_with(ext))
        || requirement.contains("://") && !rest.starts_with(['@', '['])
    {
        return None;
    }
    Some(ManifestDependency { package: name.to_owned(), requirement: requirement.to_owned(), from: 0, to: 0 })
}

fn utf16(text: &str, byte: usize) -> u32 {
    text[..byte].encode_utf16().count() as u32
}

fn requirements_txt(text: &str) -> Vec<ManifestDependency> {
    let mut out = Vec::new();
    let mut start = 0;
    for line in text.split_inclusive('\n') {
        let line_start = start;
        start += line.len();
        let body = line.trim_end_matches(['\n', '\r']);
        // A comment starts the line or follows whitespace; per-requirement options (`--hash`) follow ` -`.
        let cut = [" #", "\t#", " --", "\t--", " \\"].iter().filter_map(|m| body.find(m)).min().unwrap_or(body.len());
        let content = body[..cut].trim_end();
        let lead = content.len() - content.trim_start().len();
        let requirement = content.trim_start();
        if requirement.is_empty() || requirement.starts_with(['#', '-']) || is_continuation(text, line_start) {
            continue;
        }
        if let Some(mut dep) = named(requirement) {
            dep.from = utf16(text, line_start + lead);
            dep.to = utf16(text, line_start + lead + requirement.len());
            out.push(dep);
        }
    }
    out
}

/// The previous physical line ends with `\`: this one continues it (its options).
fn is_continuation(text: &str, line_start: usize) -> bool {
    text[..line_start].trim_end_matches(['\n', '\r']).ends_with('\\')
}

fn pyproject(text: &str) -> Vec<ManifestDependency> {
    let Ok(doc) = text.parse::<Document<String>>() else { return Vec::new() };
    let mut arrays = Vec::new();
    if let Some(project) = doc.get("project").and_then(Item::as_table_like) {
        arrays.extend(project.get("dependencies"));
        if let Some(extras) = project.get("optional-dependencies").and_then(Item::as_table_like) {
            arrays.extend(extras.iter().map(|(_, item)| item));
        }
    }
    // PEP 735 groups; `{ include-group = "…" }` entries aren't strings and are skipped.
    if let Some(groups) = doc.get("dependency-groups").and_then(Item::as_table_like) {
        arrays.extend(groups.iter().map(|(_, item)| item));
    }
    let mut out = Vec::new();
    for value in arrays.into_iter().filter_map(Item::as_array).flat_map(|a| a.iter()) {
        let (Some(requirement), Some(span)) = (value.as_str(), value.span()) else { continue };
        let Some(raw) = text.get(span.clone()) else { continue };
        let delimiter = if raw.starts_with("\"\"\"") || raw.starts_with("'''") { 3 } else { 1 };
        if let Some(mut dep) = named(requirement.trim()) {
            dep.from = utf16(text, span.start + delimiter);
            dep.to = utf16(text, span.end - delimiter);
            out.push(dep);
        }
    }
    out.sort_unstable_by_key(|d| d.from);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(deps: &[ManifestDependency], text: &str) -> Vec<(String, String)> {
        let units: Vec<u16> = text.encode_utf16().collect();
        deps.iter()
            .map(|d| {
                let span = String::from_utf16(&units[d.from as usize..d.to as usize]).unwrap();
                assert_eq!(span, d.requirement, "span matches the requirement");
                (d.package.clone(), d.requirement.clone())
            })
            .collect()
    }

    #[test]
    fn requirements_txt_keeps_named_requirements_only() {
        let text = "# 中文 😀 comment\n\
            Django>=4.2,<5 # web\n\
            typing_extensions\n\
            requests[socks]==2.31.0 ; python_version >= \"3.8\"\n\
            -r base.txt\n\
            --index-url https://pypi.org/simple\n\
            -e ./local\n\
            ./pkg\n\
            /abs/path\n\
            https://example.com/x.tar.gz\n\
            foo-1.0-py3-none-any.whl\n\
            pkg @ https://example.com/pkg.zip\n\
            numpy==1.26.4 \\\n    --hash=sha256:abc \\\n    --hash=sha256:def\n\
            \n   \n\
            black --config-settings=x=y\n";
        let deps = requirements("requirements.txt", text);
        assert_eq!(
            names(&deps, text),
            [
                ("Django", "Django>=4.2,<5"),
                ("typing_extensions", "typing_extensions"),
                ("requests", "requests[socks]==2.31.0 ; python_version >= \"3.8\""),
                ("pkg", "pkg @ https://example.com/pkg.zip"),
                ("numpy", "numpy==1.26.4"),
                ("black", "black"),
            ]
            .map(|(a, b)| (a.to_owned(), b.to_owned()))
        );
    }

    #[test]
    fn requirements_files_by_name() {
        assert!(is_requirements_file("requirements.txt"));
        assert!(is_requirements_file("requirements-dev.txt"));
        assert!(!is_requirements_file("constraints.txt"));
        assert!(requirements("notes.txt", "django\n").is_empty());
    }

    #[test]
    fn pyproject_project_extras_and_groups() {
        let text = r#"[build-system]
requires = ["setuptools"]

[project]
name = "demo"
dependencies = [
  "flask>=3",   # 注释
  'PyYAML',
  "local @ file:///tmp/x",
]

[project.optional-dependencies]
test = ["pytest>=8; python_version>='3.9'"]

[dependency-groups]
dev = ["ruff", { include-group = "test" }]

[tool.poetry.dependencies]
ignored = "^1"
"#;
        let deps = requirements("pyproject.toml", text);
        assert_eq!(
            names(&deps, text),
            [
                ("flask", "flask>=3"),
                ("PyYAML", "PyYAML"),
                ("local", "local @ file:///tmp/x"),
                ("pytest", "pytest>=8; python_version>='3.9'"),
                ("ruff", "ruff"),
            ]
            .map(|(a, b)| (a.to_owned(), b.to_owned()))
        );
        assert!(requirements("pyproject.toml", "[project\n").is_empty());
    }
}
