//! Dotted directories holding a whole package: `com.abc.mall/OrderService.java` declaring
//! `package com.abc.mall;`.
//!
//! javac and IntelliJ accept such projects, and IDEA reads the package by joining directory
//! names with `.`. JDT only walks directories whose names are valid identifiers
//! (`PackageFragmentRoot.computeFolderChildren`), so the dotted folder never becomes a
//! package fragment and jdtls reports
//! `The declared package "com.abc.mall" does not match the expected package ""`. That
//! diagnostic is a false positive when the declared package is exactly the dotted-aware
//! reading of the folders above the file; mapping such directories into JDT's package model
//! stays open (#4405).

use lsp_types::{Diagnostic, NumberOrString};
use std::path::Path;

/// `IProblem.PackageIsNotExpectedPackage` (`Internal + 328`), which jdtls reports as the
/// diagnostic code.
const NOT_EXPECTED_PACKAGE: &str = "536871240";

/// Whether `diagnostic` blames `path` for a package that the dotted-aware reading of the
/// folders above it spells out exactly.
pub(crate) fn false_positive(path: &Path, diagnostic: &Diagnostic) -> bool {
    matches!(&diagnostic.code, Some(NumberOrString::String(code)) if code == NOT_EXPECTED_PACKAGE)
        && declared_package(&diagnostic.message).is_some_and(|declared| suffix_matches(&declared, path))
}

/// The declared package of `The declared package "…" does not match …`, split into segments.
fn declared_package(message: &str) -> Option<Vec<&str>> {
    let declared = message.strip_prefix("The declared package \"")?;
    let (name, _) = declared.split_once('"')?;
    let segments: Vec<&str> = name.split('.').collect();
    (!name.is_empty() && segments.iter().all(|s| identifier(s))).then_some(segments)
}

/// Whether walking up from `file`, each folder reads as the next package segments of
/// `declared` until the declared package is complete: a dotted folder counts as all of its
/// `.`-separated names at once (`com.abc.mall` is `com.abc.mall`, never `com` under `abc`).
/// A plain run of folders cannot spell the declaration, so a real mismatch keeps its
/// diagnostic.
fn suffix_matches(declared: &[&str], file: &Path) -> bool {
    let mut segments: Vec<&str> = Vec::new();
    let mut dotted = false;
    let mut dir = file.parent();
    while let Some(folder) = dir {
        let Some(name) = folder.file_name().and_then(|name| name.to_str()) else { return false };
        let parts: Vec<&str> = name.split('.').collect();
        if !parts.iter().all(|part| identifier(part)) {
            return false;
        }
        dotted |= parts.len() > 1;
        segments.splice(..0, parts);
        if segments.len() >= declared.len() {
            return dotted && segments.iter().eq(declared.iter());
        }
        dir = folder.parent();
    }
    false
}

fn identifier(segment: &str) -> bool {
    let mut chars = segment.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphabetic() || c == '_' || c == '$')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$')
}

#[cfg(test)]
mod tests {
    use super::*;
    use lsp_types::{DiagnosticSeverity, Range};
    use std::path::PathBuf;

    fn diagnostic(code: &str, message: &str) -> Diagnostic {
        Diagnostic {
            range: Range::default(),
            severity: Some(DiagnosticSeverity::ERROR),
            code: Some(NumberOrString::String(code.into())),
            source: Some("jdtls".into()),
            message: message.into(),
            ..Default::default()
        }
    }

    fn source_file(root: &Path, folders: &[&str], name: &str) -> PathBuf {
        let mut path = root.to_path_buf();
        path.extend(folders);
        path.join(name)
    }

    fn mismatch(declared: &str, expected: &str) -> Diagnostic {
        diagnostic(
            NOT_EXPECTED_PACKAGE,
            &format!("The declared package \"{declared}\" does not match the expected package \"{expected}\""),
        )
    }

    #[test]
    fn a_dotted_directory_reads_as_the_whole_package() {
        let root = tempfile::tempdir().unwrap();
        let file = source_file(root.path(), &["com.abc.mall"], "OrderService.java");
        assert!(false_positive(&file, &mismatch("com.abc.mall", "")));
        let file = source_file(root.path(), &["com.abc.mall", "order"], "OrderService.java");
        assert!(false_positive(&file, &mismatch("com.abc.mall.order", "")));
    }

    #[test]
    fn dotted_and_plain_folders_mix_like_idea_reads_them() {
        let root = tempfile::tempdir().unwrap();
        let file = source_file(root.path(), &["com", "abc", "x.y"], "Foo.java");
        assert!(false_positive(&file, &mismatch("com.abc.x.y", "")));
        let file = source_file(root.path(), &["lib", "com.abc.mall"], "OrderService.java");
        assert!(false_positive(&file, &mismatch("com.abc.mall", "")));
    }

    #[test]
    fn real_mismatches_keep_their_diagnostic() {
        let root = tempfile::tempdir().unwrap();
        let wrong = source_file(root.path(), &["com.abc.mall"], "Wrong.java");
        assert!(!false_positive(&wrong, &mismatch("com.other", "")));
        let deeper = source_file(root.path(), &["com.abc.mall", "sub"], "Foo.java");
        assert!(!false_positive(&deeper, &mismatch("com.abc.mall", "")));
        let plain = source_file(root.path(), &["src", "main", "java", "com", "abc"], "Foo.java");
        assert!(!false_positive(&plain, &mismatch("com.abc", "")));
        let wider = source_file(root.path(), &["com.abc.mall.wide"], "Foo.java");
        assert!(!false_positive(&wider, &mismatch("com.abc.mall", "")));
        let hidden = source_file(root.path(), &[".abc"], "Foo.java");
        assert!(!false_positive(&hidden, &mismatch("com.abc", "")));
    }

    #[test]
    fn other_problems_and_other_codes_are_not_ours() {
        let root = tempfile::tempdir().unwrap();
        let file = source_file(root.path(), &["com.abc.mall"], "OrderService.java");
        assert!(!false_positive(
            &file,
            &diagnostic("1", "The declared package \"com.abc.mall\" does not match the expected package \"\"")
        ));
        assert!(!false_positive(&file, &diagnostic(NOT_EXPECTED_PACKAGE, "Syntax error on token \"package\"")));
        assert!(!false_positive(
            &file,
            &diagnostic(NOT_EXPECTED_PACKAGE, "The declared package \"\" does not match the expected package \"\"")
        ));
    }
}
