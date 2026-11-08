//! Optional API 1.4 language features and embedded language ranges.
pub use crate::providers::Document;
use crate::{Error, Location, Position, Range, TextEdit};
/// A parameter label, as text or UTF-16 offsets within the signature.
#[derive(Clone, Debug, PartialEq)]
pub enum ParameterLabel {
    Text(String),
    Offsets((u32, u32)),
}
/// FormatOptions data.
#[derive(Clone, Debug, PartialEq)]
pub struct FormatOptions {
    pub tab_size: u32,
    pub insert_spaces: bool,
}
/// Parameter data.
#[derive(Clone, Debug, PartialEq)]
pub struct Parameter {
    pub label: ParameterLabel,
    pub documentation: Option<String>,
}
/// Signature data.
#[derive(Clone, Debug, PartialEq)]
pub struct Signature {
    pub label: String,
    pub documentation: Option<String>,
    pub parameters: Vec<Parameter>,
}
/// SignatureHelp data.
#[derive(Clone, Debug, PartialEq)]
pub struct SignatureHelp {
    pub signatures: Vec<Signature>,
    pub active_signature: u32,
    pub active_parameter: u32,
}
/// Highlight data.
#[derive(Clone, Debug, PartialEq)]
pub struct Highlight {
    pub range: Range,
    pub kind: String,
}
/// DocumentLink data.
#[derive(Clone, Debug, PartialEq)]
pub struct DocumentLink {
    pub range: Range,
    pub target: String,
}
/// CodeLens data.
#[derive(Clone, Debug, PartialEq)]
pub struct CodeLens {
    pub range: Range,
    pub title: String,
    pub command: String,
    pub argument: Option<String>,
}
/// FoldRange data.
#[derive(Clone, Debug, PartialEq)]
pub struct FoldRange {
    pub start_line: u32,
    pub end_line: u32,
    pub kind: String,
}
/// ColorInfo data.
#[derive(Clone, Debug, PartialEq)]
pub struct ColorInfo {
    pub range: Range,
    pub red: f32,
    pub green: f32,
    pub blue: f32,
    pub alpha: f32,
}
/// DocumentSymbol data.
#[derive(Clone, Debug, PartialEq)]
pub struct DocumentSymbol {
    pub name: String,
    pub detail: String,
    pub kind: String,
    pub range: Range,
    pub selection_range: Range,
    pub parent: Option<u32>,
}
/// GutterAction data.
#[derive(Clone, Debug, PartialEq)]
pub struct GutterAction {
    pub line: u32,
    pub icon: Option<String>,
    pub tooltip: String,
    pub command: String,
    pub argument: Option<String>,
}
/// Injection data.
#[derive(Clone, Debug, PartialEq)]
pub struct Injection {
    pub range: Range,
    pub language: String,
}
/// Implement only the kinds declared under contributes.providers.
pub trait LanguageFeatures {
    fn format(
        &mut self,
        _doc: &Document,
        _range: Option<Range>,
        _options: FormatOptions,
    ) -> Result<Vec<TextEdit>, Error> {
        Ok(Vec::new())
    }
    fn signature_help(&mut self, _doc: &Document, _at: Position) -> Option<SignatureHelp> {
        None
    }
    fn document_highlights(&mut self, _doc: &Document, _at: Position) -> Vec<Highlight> {
        Vec::new()
    }
    fn document_links(&mut self, _doc: &Document) -> Vec<DocumentLink> {
        Vec::new()
    }
    fn code_lenses(&mut self, _doc: &Document) -> Vec<CodeLens> {
        Vec::new()
    }
    fn selection_ranges(&mut self, _doc: &Document, _at: Position) -> Vec<Range> {
        Vec::new()
    }
    fn folding(&mut self, _doc: &Document) -> Vec<FoldRange> {
        Vec::new()
    }
    fn colors(&mut self, _doc: &Document) -> Vec<ColorInfo> {
        Vec::new()
    }
    fn color_presentations(&mut self, _doc: &Document, _color: ColorInfo) -> Vec<String> {
        Vec::new()
    }
    fn document_symbols(&mut self, _doc: &Document) -> Vec<DocumentSymbol> {
        Vec::new()
    }
    fn implementation(&mut self, _doc: &Document, _at: Position) -> Vec<Location> {
        Vec::new()
    }
    fn type_definition(&mut self, _doc: &Document, _at: Position) -> Vec<Location> {
        Vec::new()
    }
    fn gutter_actions(&mut self, _doc: &Document) -> Vec<GutterAction> {
        Vec::new()
    }
}
/// Identifies embedded ranges in a host document.
pub trait Injections {
    fn injections(&mut self, doc: &Document) -> Vec<Injection>;
}

#[cfg(target_arch = "wasm32")]
#[doc(hidden)]
pub mod wasm {
    use super::*;
    use crate::bindings::openidea::plugin::types as b;
    use crate::injections_bindings::exports::openidea::plugin::injections as wi;
    use crate::language_features_bindings::exports::openidea::plugin::language_features as w;
    fn format_options_from(v: w::FormatOptions) -> FormatOptions {
        FormatOptions { tab_size: v.tab_size, insert_spaces: v.insert_spaces }
    }
    fn parameter_to(v: Parameter) -> w::Parameter {
        w::Parameter { label: parameter_label_to(v.label), documentation: v.documentation }
    }
    fn signature_to(v: Signature) -> w::Signature {
        w::Signature {
            label: v.label,
            documentation: v.documentation,
            parameters: v.parameters.into_iter().map(parameter_to).collect(),
        }
    }
    fn signature_help_to(v: SignatureHelp) -> w::SignatureHelpResult {
        w::SignatureHelpResult {
            signatures: v.signatures.into_iter().map(signature_to).collect(),
            active_signature: v.active_signature,
            active_parameter: v.active_parameter,
        }
    }
    fn highlight_to(v: Highlight) -> w::Highlight {
        w::Highlight { range: crate::host::__range_to(v.range), kind: v.kind }
    }
    fn document_link_to(v: DocumentLink) -> w::DocumentLink {
        w::DocumentLink { range: crate::host::__range_to(v.range), target: v.target }
    }
    fn code_lens_to(v: CodeLens) -> w::CodeLens {
        w::CodeLens {
            range: crate::host::__range_to(v.range),
            title: v.title,
            command: v.command,
            argument: v.argument,
        }
    }
    fn fold_range_to(v: FoldRange) -> w::FoldRange {
        w::FoldRange { start_line: v.start_line, end_line: v.end_line, kind: v.kind }
    }
    fn color_info_to(v: ColorInfo) -> w::ColorInfo {
        w::ColorInfo {
            range: crate::host::__range_to(v.range),
            red: v.red,
            green: v.green,
            blue: v.blue,
            alpha: v.alpha,
        }
    }
    fn color_info_from(v: w::ColorInfo) -> ColorInfo {
        ColorInfo {
            range: crate::host::__range_from(v.range),
            red: v.red,
            green: v.green,
            blue: v.blue,
            alpha: v.alpha,
        }
    }
    fn document_symbol_to(v: DocumentSymbol) -> w::DocumentSymbol {
        w::DocumentSymbol {
            name: v.name,
            detail: v.detail,
            kind: v.kind,
            range: crate::host::__range_to(v.range),
            selection_range: crate::host::__range_to(v.selection_range),
            parent: v.parent,
        }
    }
    fn gutter_action_to(v: GutterAction) -> w::GutterAction {
        w::GutterAction { line: v.line, icon: v.icon, tooltip: v.tooltip, command: v.command, argument: v.argument }
    }
    fn parameter_label_to(v: ParameterLabel) -> w::ParameterLabel {
        match v {
            ParameterLabel::Text(t) => w::ParameterLabel::Text(t),
            ParameterLabel::Offsets(t) => w::ParameterLabel::Offsets(t),
        }
    }
    pub fn format<T: crate::Plugin + LanguageFeatures + Default>(
        d: w::Document,
        range: Option<b::Range>,
        options: w::FormatOptions,
    ) -> Result<Vec<b::TextEdit>, b::Error> {
        let doc = Document { path: d.path, language: d.language, version: d.version, text: d.text };
        let result = crate::__rt::with::<T, _>(|p| {
            p.format(&doc, range.map(crate::host::__range_from), format_options_from(options))
        });
        result
            .map(|result| {
                result
                    .into_iter()
                    .map(|v| b::TextEdit { range: crate::host::__range_to(v.range), text: v.text })
                    .collect()
            })
            .map_err(|e| match e {
                Error::Denied(s) => b::Error::Denied(s),
                Error::Stale => b::Error::Stale,
                Error::NotFound(s) => b::Error::NotFound(s),
                Error::Invalid(s) => b::Error::Invalid(s),
                Error::Cancelled => b::Error::Cancelled,
                Error::Failed(s) => b::Error::Failed(s),
            })
    }
    pub fn signature_help<T: crate::Plugin + LanguageFeatures + Default>(
        d: w::Document,
        at: b::Position,
    ) -> Option<w::SignatureHelpResult> {
        let doc = Document { path: d.path, language: d.language, version: d.version, text: d.text };
        let result =
            crate::__rt::with::<T, _>(|p| p.signature_help(&doc, Position { line: at.line, character: at.character }));
        result.map(signature_help_to)
    }
    pub fn document_highlights<T: crate::Plugin + LanguageFeatures + Default>(
        d: w::Document,
        at: b::Position,
    ) -> Vec<w::Highlight> {
        let doc = Document { path: d.path, language: d.language, version: d.version, text: d.text };
        let result = crate::__rt::with::<T, _>(|p| {
            p.document_highlights(&doc, Position { line: at.line, character: at.character })
        });
        result.into_iter().map(highlight_to).collect()
    }
    pub fn document_links<T: crate::Plugin + LanguageFeatures + Default>(d: w::Document) -> Vec<w::DocumentLink> {
        let doc = Document { path: d.path, language: d.language, version: d.version, text: d.text };
        let result = crate::__rt::with::<T, _>(|p| p.document_links(&doc));
        result.into_iter().map(document_link_to).collect()
    }
    pub fn code_lenses<T: crate::Plugin + LanguageFeatures + Default>(d: w::Document) -> Vec<w::CodeLens> {
        let doc = Document { path: d.path, language: d.language, version: d.version, text: d.text };
        let result = crate::__rt::with::<T, _>(|p| p.code_lenses(&doc));
        result.into_iter().map(code_lens_to).collect()
    }
    pub fn selection_ranges<T: crate::Plugin + LanguageFeatures + Default>(
        d: w::Document,
        at: b::Position,
    ) -> Vec<b::Range> {
        let doc = Document { path: d.path, language: d.language, version: d.version, text: d.text };
        let result = crate::__rt::with::<T, _>(|p| {
            p.selection_ranges(&doc, Position { line: at.line, character: at.character })
        });
        result.into_iter().map(crate::host::__range_to).collect()
    }
    pub fn folding<T: crate::Plugin + LanguageFeatures + Default>(d: w::Document) -> Vec<w::FoldRange> {
        let doc = Document { path: d.path, language: d.language, version: d.version, text: d.text };
        let result = crate::__rt::with::<T, _>(|p| p.folding(&doc));
        result.into_iter().map(fold_range_to).collect()
    }
    pub fn colors<T: crate::Plugin + LanguageFeatures + Default>(d: w::Document) -> Vec<w::ColorInfo> {
        let doc = Document { path: d.path, language: d.language, version: d.version, text: d.text };
        let result = crate::__rt::with::<T, _>(|p| p.colors(&doc));
        result.into_iter().map(color_info_to).collect()
    }
    pub fn color_presentations<T: crate::Plugin + LanguageFeatures + Default>(
        d: w::Document,
        color: w::ColorInfo,
    ) -> Vec<String> {
        let doc = Document { path: d.path, language: d.language, version: d.version, text: d.text };
        let result = crate::__rt::with::<T, _>(|p| p.color_presentations(&doc, color_info_from(color)));
        result.into_iter().collect()
    }
    pub fn document_symbols<T: crate::Plugin + LanguageFeatures + Default>(d: w::Document) -> Vec<w::DocumentSymbol> {
        let doc = Document { path: d.path, language: d.language, version: d.version, text: d.text };
        let result = crate::__rt::with::<T, _>(|p| p.document_symbols(&doc));
        result.into_iter().map(document_symbol_to).collect()
    }
    pub fn implementation<T: crate::Plugin + LanguageFeatures + Default>(
        d: w::Document,
        at: b::Position,
    ) -> Vec<b::Location> {
        let doc = Document { path: d.path, language: d.language, version: d.version, text: d.text };
        let result =
            crate::__rt::with::<T, _>(|p| p.implementation(&doc, Position { line: at.line, character: at.character }));
        result.into_iter().map(|v| b::Location { path: v.path, range: crate::host::__range_to(v.range) }).collect()
    }
    pub fn type_definition<T: crate::Plugin + LanguageFeatures + Default>(
        d: w::Document,
        at: b::Position,
    ) -> Vec<b::Location> {
        let doc = Document { path: d.path, language: d.language, version: d.version, text: d.text };
        let result =
            crate::__rt::with::<T, _>(|p| p.type_definition(&doc, Position { line: at.line, character: at.character }));
        result.into_iter().map(|v| b::Location { path: v.path, range: crate::host::__range_to(v.range) }).collect()
    }
    pub fn gutter_actions<T: crate::Plugin + LanguageFeatures + Default>(d: w::Document) -> Vec<w::GutterAction> {
        let doc = Document { path: d.path, language: d.language, version: d.version, text: d.text };
        let result = crate::__rt::with::<T, _>(|p| p.gutter_actions(&doc));
        result.into_iter().map(gutter_action_to).collect()
    }
    pub fn injections<T: crate::Plugin + Injections + Default>(d: wi::Document) -> Vec<wi::Injection> {
        let doc = Document { path: d.path, language: d.language, version: d.version, text: d.text };
        crate::__rt::with::<T, _>(|p| p.injections(&doc))
            .into_iter()
            .map(|i| wi::Injection { range: crate::host::__range_to(i.range), language: i.language })
            .collect()
    }
}
