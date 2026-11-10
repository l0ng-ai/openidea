use openidea_plugin::{Position, Range, language_features::*, mock::MockHost};
struct Features;
impl LanguageFeatures for Features {
    fn signature_help(&mut self, d: &Document, _: Position) -> Option<SignatureHelp> {
        Some(SignatureHelp {
            signatures: vec![Signature {
                label: d.text.clone(),
                documentation: None,
                parameters: vec![Parameter {
                    label: ParameterLabel::Offsets((0, 2)),
                    documentation: Some(d.language.clone()),
                }],
            }],
            active_signature: 0,
            active_parameter: 0,
        })
    }
}
impl Injections for Features {
    fn injections(&mut self, _: &Document) -> Vec<Injection> {
        vec![Injection {
            range: Range { start: Position::default(), end: Position { line: 0, character: 2 } },
            language: "sql".into(),
        }]
    }
}
#[test]
fn optional_traits_use_the_unsaved_mock_snapshot_without_extra_capabilities() {
    let host = MockHost::install().with_capabilities(&[]);
    host.open_editor("/project/a.txt", "text", "😀", &[]);
    host.type_in_editor(" SELECT");
    let doc = host.provider_document().unwrap();
    assert_eq!(doc.version, 2);
    let mut provider = Features;
    assert_eq!(provider.signature_help(&doc, Position::default()).unwrap().signatures[0].label, "😀 SELECT");
    assert_eq!(provider.injections(&doc)[0].range.end.character, 2);
    assert!(provider.document_links(&doc).is_empty());
    assert!(provider.format(&doc, None, FormatOptions { tab_size: 4, insert_spaces: true }).unwrap().is_empty());
}
