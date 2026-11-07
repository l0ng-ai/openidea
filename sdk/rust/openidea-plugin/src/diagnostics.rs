//! Diagnostics for unsaved documents. Declare `kinds = ["diagnostics"]` and
//! register with `register_plugin!(MyPlugin, diagnostics)` (API 1.3).
pub use crate::providers::Document;
pub use crate::types::Diagnostic;

pub trait DiagnosticsProvider {
    fn diagnostics(&mut self, doc: &Document) -> Vec<Diagnostic>;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Range, Severity, host, mock::MockHost};

    struct Provider;
    impl DiagnosticsProvider for Provider {
        fn diagnostics(&mut self, doc: &Document) -> Vec<Diagnostic> {
            vec![Diagnostic::new(
                Range::default(),
                Severity::Warning,
                format!("{}:{}:{}", doc.language, doc.version, doc.text),
            )]
        }
    }

    #[test]
    fn the_mock_uses_unsaved_versioned_text_and_keeps_manual_problems() {
        let mock = MockHost::install();
        mock.open_editor("/project/a.txt", "text", "a", &[]);
        host::publish_diagnostics("/project/a.txt", &[Diagnostic::new(Range::default(), Severity::Info, "manual")])
            .unwrap();
        mock.type_in_editor("😀");
        mock.refresh_diagnostics(&mut Provider);
        assert_eq!(mock.provider_diagnostics()["/project/a.txt"][0].message, "text:2:a😀");
        assert_eq!(mock.diagnostics()["/project/a.txt"][0].message, "manual");
    }

    #[test]
    fn a_provider_needs_no_extra_capability_but_publishing_still_does() {
        let mock = MockHost::install().with_capabilities(&[]);
        mock.open_editor("/project/a.txt", "text", "unsaved", &[]);
        mock.refresh_diagnostics(&mut Provider);
        assert_eq!(mock.provider_diagnostics()["/project/a.txt"][0].message, "text:1:unsaved");
        assert!(host::publish_diagnostics("/project/a.txt", &[]).is_err());
    }
}
