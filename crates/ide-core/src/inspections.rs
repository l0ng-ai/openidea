//! First-class inspections: a small, language-agnostic contract for checks that
//! run inside the IDE (not via a language server), plus suppression.
//!
//! An [`Inspection`] is identified by a stable id, declares a default
//! severity, and produces [`Diagnostic`]s for a single file's text. The
//! [`InspectionRegistry`] runs every registered inspection and merges the
//! results. Suppression comments (`// noinspection ID` / `//noinspection ID`
//! on the preceding line, or `@SuppressWarnings("ID")` on the declaration)
//! drop matching diagnostics before they reach the Problems view.
//!
//! This is the contract `ide-analysis` and plugins build on; it intentionally
//! carries no language-specific knowledge.

use crate::{Diagnostic, Range, Severity};
use std::collections::BTreeSet;

/// A check that runs inside the IDE.
pub trait Inspection: Send + Sync {
    /// Stable id, e.g. `unused-variable`.
    fn id(&self) -> &'static str;
    /// Default severity when the profile does not override it.
    fn default_severity(&self) -> Severity;
    /// Run the check over `text`, returning diagnostics (0-based LSP ranges).
    fn check(&self, text: &str) -> Vec<Diagnostic>;
}

/// Registry of inspections for one language/scope.
#[derive(Default)]
pub struct InspectionRegistry {
    inspections: Vec<Box<dyn Inspection>>,
}

impl InspectionRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(&mut self, inspection: Box<dyn Inspection>) {
        self.inspections.push(inspection);
    }

    pub fn ids(&self) -> Vec<&'static str> {
        self.inspections.iter().map(|i| i.id()).collect()
    }

    /// Runs every inspection and applies `suppressed` ids.
    pub fn run(&self, text: &str, suppressed: &BTreeSet<String>) -> Vec<Diagnostic> {
        let mut out = Vec::new();
        for insp in &self.inspections {
            if suppressed.contains(insp.id()) {
                continue;
            }
            for mut d in insp.check(text) {
                if d.source.is_none() {
                    d.source = Some(insp.id().to_owned());
                }
                if d.code.is_none() {
                    d.code = Some(insp.id().to_owned());
                }
                out.push(d);
            }
        }
        out
    }
}

/// Collects inspection ids suppressed on the line preceding `line_index` (0-based)
/// via `// noinspection ID` / `//noinspection ID`, and via `@SuppressWarnings`
/// annotations anywhere in `text` for the given id.
pub fn suppressed_ids(text: &str, line_index: usize) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    let lines: Vec<&str> = text.lines().collect();
    // Preceding-line comment form.
    if line_index > 0
        && let Some(prev) = lines.get(line_index - 1)
    {
        for form in ["noinspection", "noinspection"] {
            if let Some(rest) = prev.trim().strip_prefix("//") {
                let rest = rest.trim();
                if let Some(rest) = rest.strip_prefix(form) {
                    for id in rest.split_whitespace() {
                        out.insert(id.trim_matches(',').to_owned());
                    }
                }
            }
        }
    }
    // @SuppressWarnings("a, b") anywhere in the file suppresses globally for v1.
    for line in &lines {
        if let Some(idx) = line.find("@SuppressWarnings") {
            let rest = &line[idx..];
            if let Some(start) = rest.find('(') {
                let inner = &rest[start + 1..];
                if let Some(end) = inner.find(')') {
                    let inner = &inner[..end];
                    for part in inner.split(',') {
                        let id = part.trim().trim_matches('"').trim();
                        if !id.is_empty() {
                            out.insert(id.to_owned());
                        }
                    }
                }
            }
        }
    }
    out
}

/// Convenience: filter a diagnostic list by a per-diagnostic suppression set.
/// A diagnostic is dropped when its `code` is in `suppressed`.
pub fn apply_suppressions(diagnostics: Vec<Diagnostic>, suppressed: &BTreeSet<String>) -> Vec<Diagnostic> {
    diagnostics
        .into_iter()
        .filter(|d| d.code.as_ref().map(|c| !suppressed.contains(c)).unwrap_or(true))
        .collect()
}

/// A no-op inspection useful as a placeholder in tests and registries.
pub struct NoopInspection {
    pub id: &'static str,
}

impl Inspection for NoopInspection {
    fn id(&self) -> &'static str {
        self.id
    }
    fn default_severity(&self) -> Severity {
        Severity::Info
    }
    fn check(&self, _text: &str) -> Vec<Diagnostic> {
        Vec::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct AlwaysWarn {
        id: &'static str,
    }
    impl Inspection for AlwaysWarn {
        fn id(&self) -> &'static str {
            self.id
        }
        fn default_severity(&self) -> Severity {
            Severity::Warning
        }
        fn check(&self, text: &str) -> Vec<Diagnostic> {
            if text.contains("bad") {
                vec![Diagnostic {
                    range: Range { start: crate::Pos { line: 0, col: 0 }, end: crate::Pos { line: 0, col: 3 } },
                    severity: Severity::Warning,
                    message: "found bad".into(),
                    source: None,
                    code: None,
                    unnecessary: false,
                    deprecated: false,
                    server: None,
                }]
            } else {
                Vec::new()
            }
        }
    }

    #[test]
    fn registry_runs_registered_inspections() {
        let mut reg = InspectionRegistry::new();
        reg.register(Box::new(AlwaysWarn { id: "always-warn" }));
        let d = reg.run("this is bad", &BTreeSet::new());
        assert_eq!(d.len(), 1);
        assert_eq!(d[0].code.as_deref(), Some("always-warn"));
        assert!(reg.run("all good", &BTreeSet::new()).is_empty());
    }

    #[test]
    fn suppressed_inspection_is_skipped() {
        let mut reg = InspectionRegistry::new();
        reg.register(Box::new(AlwaysWarn { id: "always-warn" }));
        let mut suppressed = BTreeSet::new();
        suppressed.insert("always-warn".into());
        assert!(reg.run("bad", &suppressed).is_empty());
    }

    #[test]
    fn per_diagnostic_suppression_filters_by_code() {
        let d = vec![Diagnostic {
            range: Range { start: crate::Pos { line: 0, col: 0 }, end: crate::Pos { line: 0, col: 1 } },
            severity: Severity::Warning,
            message: "x".into(),
            source: None,
            code: Some("foo".into()),
            unnecessary: false,
            deprecated: false,
            server: None,
        }];
        let mut s = BTreeSet::new();
        s.insert("foo".into());
        assert!(apply_suppressions(d, &s).is_empty());
    }

    #[test]
    fn noinspection_comment_on_preceding_line_suppresses() {
        let text = "// noinspection always-warn\nbad code";
        let s = suppressed_ids(text, 1);
        assert!(s.contains("always-warn"));
    }

    #[test]
    fn suppresswarnings_annotation_is_parsed() {
        let text = "@SuppressWarnings(\"always-warn, other\")\nclass X {}";
        let s = suppressed_ids(text, 1);
        assert!(s.contains("always-warn"));
        assert!(s.contains("other"));
    }
}
