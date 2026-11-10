use openidea_plugin::language_features::*;
use openidea_plugin::{
    Diagnostic, Error, Invocation, Location, Plugin, Position, Range, Severity, TextEdit, register_plugin, text,
};
#[derive(Default)]
struct Fixture {
    last: Option<String>,
}
fn range(a: u32, b: u32) -> Range {
    Range { start: Position { line: 0, character: a }, end: Position { line: 0, character: b } }
}
impl Plugin for Fixture {
    fn run_command(&mut self, id: &str, _: &Invocation, arg: Option<&str>) -> Result<Option<String>, Error> {
        match id {
            "run" => {
                self.last = arg.map(str::to_owned);
                Ok(self.last.clone())
            }
            "state" => Ok(self.last.clone()),
            _ => Err(Error::NotFound(id.into())),
        }
    }
}
impl LanguageFeatures for Fixture {
    fn format(&mut self, d: &Document, r: Option<Range>, _: FormatOptions) -> Result<Vec<TextEdit>, Error> {
        Ok(vec![TextEdit {
            range: r.unwrap_or(Range { start: Position::default(), end: text::position(&d.text, d.text.len()) }),
            text: "formatted".into(),
        }])
    }
    fn signature_help(&mut self, _: &Document, _: Position) -> Option<SignatureHelp> {
        Some(SignatureHelp {
            signatures: vec![Signature {
                label: "query(value)".into(),
                documentation: Some("Query".into()),
                parameters: vec![Parameter { label: ParameterLabel::Text("value".into()), documentation: None }],
            }],
            active_signature: 0,
            active_parameter: 0,
        })
    }
    fn document_highlights(&mut self, _: &Document, _: Position) -> Vec<Highlight> {
        vec![Highlight { range: range(0, 1), kind: "read".into() }]
    }
    fn document_links(&mut self, _: &Document) -> Vec<DocumentLink> {
        vec![
            DocumentLink { range: range(0, 1), target: "next.txt".into() },
            DocumentLink { range: range(1, 2), target: "https://example.com".into() },
        ]
    }
    fn code_lenses(&mut self, _: &Document) -> Vec<CodeLens> {
        vec![
            CodeLens { range: range(0, 1), title: "Run".into(), command: "run".into(), argument: Some("lens".into()) },
            CodeLens { range: range(0, 1), title: "Foreign".into(), command: "foreign".into(), argument: None },
        ]
    }
    fn selection_ranges(&mut self, _: &Document, _: Position) -> Vec<Range> {
        vec![range(0, 1), range(0, 5)]
    }
    fn folding(&mut self, _: &Document) -> Vec<FoldRange> {
        vec![FoldRange { start_line: 0, end_line: 2, kind: "region".into() }]
    }
    fn colors(&mut self, _: &Document) -> Vec<ColorInfo> {
        vec![ColorInfo { range: range(0, 1), red: 1.0, green: 0.0, blue: 0.0, alpha: 1.0 }]
    }
    fn color_presentations(&mut self, d: &Document, _: ColorInfo) -> Vec<String> {
        vec![format!("red-{}", d.language), "#ff0000".into()]
    }
    fn document_symbols(&mut self, _: &Document) -> Vec<DocumentSymbol> {
        vec![
            DocumentSymbol {
                name: "Outer".into(),
                detail: "module".into(),
                kind: "module".into(),
                range: range(0, 5),
                selection_range: range(0, 1),
                parent: None,
            },
            DocumentSymbol {
                name: "Inner".into(),
                detail: "value".into(),
                kind: "variable".into(),
                range: range(1, 2),
                selection_range: range(1, 2),
                parent: Some(0),
            },
        ]
    }
    fn implementation(&mut self, d: &Document, _: Position) -> Vec<Location> {
        vec![Location { path: d.path.clone(), range: range(1, 2) }]
    }
    fn type_definition(&mut self, d: &Document, _: Position) -> Vec<Location> {
        vec![Location { path: d.path.clone(), range: range(2, 3) }]
    }
    fn gutter_actions(&mut self, _: &Document) -> Vec<GutterAction> {
        vec![GutterAction {
            line: 0,
            icon: Some("run".into()),
            tooltip: "Run fixture".into(),
            command: "run".into(),
            argument: Some("gutter".into()),
        }]
    }
}
impl Injections for Fixture {
    fn injections(&mut self, d: &Document) -> Vec<Injection> {
        if d.language == "sql" {
            return vec![];
        }
        let Some(start) = d.text.find("[[") else { return vec![] };
        let Some(end) = d.text[start + 2..].find("]]") else { return vec![] };
        vec![Injection {
            range: Range { start: text::position(&d.text, start + 2), end: text::position(&d.text, start + 2 + end) },
            language: "sql".into(),
        }]
    }
}
impl openidea_plugin::providers::Providers for Fixture {
    fn completion(
        &mut self,
        d: &Document,
        _: Position,
        _: Option<&str>,
    ) -> Vec<openidea_plugin::providers::CompletionItem> {
        vec![openidea_plugin::providers::CompletionItem::new(
            &format!("{}:{}", d.language, d.text),
            openidea_plugin::providers::CompletionKind::Text,
        )]
    }
}
impl openidea_plugin::hover::HoverProvider for Fixture {
    fn hover(&mut self, d: &Document, _: Position) -> Option<openidea_plugin::hover::Hover> {
        Some(openidea_plugin::hover::Hover::new(format!("{}:{}", d.language, d.text)))
    }
}
impl openidea_plugin::diagnostics::DiagnosticsProvider for Fixture {
    fn diagnostics(&mut self, d: &Document) -> Vec<Diagnostic> {
        vec![
            Diagnostic::new(range(0, 1), Severity::Warning, "outside"),
            Diagnostic::new(range(4, 7), Severity::Warning, format!("{}:{}", d.language, d.text)),
        ]
    }
}
register_plugin!(Fixture, language_features, injections, providers, hover, diagnostics);
