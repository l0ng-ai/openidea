//! API 1.4 language features. Results are bounded and checked against the snapshot.
use super::{PluginHost, ProviderKind};
use ide_core::{IdeResult, Pos, Range};
use ide_plugin::{ProviderDocument, language_features::*};
use std::sync::Arc;

pub(crate) fn valid_range(doc: &ProviderDocument, range: Range) -> bool {
    valid_range_in(&ide_text::Document::new(&doc.text), range)
}
pub(super) fn valid_range_in(text: &ide_text::Document, range: Range) -> bool {
    if range.start > range.end {
        return false;
    }
    [range.start, range.end].iter().all(|p| text.offset_to_pos(text.pos_to_offset(*p)) == *p)
}

impl PluginHost {
    pub fn language_format(
        &self,
        id: &str,
        doc: &ProviderDocument,
        range: Option<Range>,
        options: FormatOptions,
    ) -> IdeResult<Vec<ide_core::TextEdit>> {
        let candidates = if let Some(r) = range {
            self.feature_documents(doc, Some(r.start))
        } else {
            vec![(doc.clone(), super::injections::Bounds::unrestricted())]
        };
        let (target, bounds) = candidates
            .into_iter()
            .find(|(d, b)| {
                range.is_none_or(|r| b.contains(r))
                    && self
                        .provider_plugins(ProviderKind::Formatting, &d.language)
                        .iter()
                        .any(|p| p.id() == id && p.dev_root.as_ref().is_none_or(|r| d.path.starts_with(r)))
            })
            .ok_or_else(|| ide_core::IdeError::not_found("The selected plugin formatter is unavailable"))?;
        let text = ide_text::Document::new(&target.text);
        let d = Arc::new(target);
        let edits = self.code_call(id, ide_plugin::Invocation::default(), "formatting", move |rt, _| {
            rt.language_format(&d, range, options.clone(), std::time::Duration::from_secs(5))
        })?;
        if edits.iter().any(|e| !valid_range_in(&text, e.range) || !bounds.contains(e.range)) {
            return Err(ide_core::IdeError::invalid("Plugin formatter returned an invalid range"));
        }
        let mut ranges: Vec<_> = edits.iter().map(|e| e.range).collect();
        ranges.sort();
        if ranges.windows(2).any(|p| p[0].end > p[1].start) {
            return Err(ide_core::IdeError::invalid("Plugin formatter returned overlapping edits"));
        }
        Ok(edits)
    }
    pub fn language_signature_help(&self, doc: &ProviderDocument, at: Pos) -> Option<SignatureHelp> {
        for (d, _bounds) in self.feature_documents(doc, Some(at)) {
            let snapshot = d.clone();
            let d = Arc::new(d);
            let results = self.document_calls(ProviderKind::SignatureHelp, &snapshot, move |rt, t| {
                rt.language_signature_help(&d, at, t)
            });
            for (_, v) in results {
                if let Some(v) = v.filter(|h| !h.signatures.is_empty()) {
                    return Some(v);
                }
            }
        }
        None
    }
    pub fn language_document_highlights(&self, doc: &ProviderDocument, at: Pos) -> Vec<Highlight> {
        let mut out = Vec::new();
        for (d, bounds) in self.feature_documents(doc, Some(at)) {
            let snapshot = d.clone();
            let text = ide_text::Document::new(&snapshot.text);
            let d = Arc::new(d);
            let results = self.document_calls(ProviderKind::DocumentHighlights, &snapshot, move |rt, t| {
                rt.language_document_highlights(&d, at, t)
            });
            for (p, items) in results {
                for i in items {
                    let _ = &p;
                    if valid_range_in(&text, i.range) && bounds.contains(i.range) {
                        out.push(i);
                    }
                }
            }
        }
        out
    }
    pub fn language_document_links(&self, doc: &ProviderDocument) -> Vec<DocumentLink> {
        let mut out = Vec::new();
        for (d, bounds) in self.feature_documents(doc, None) {
            let snapshot = d.clone();
            let text = ide_text::Document::new(&snapshot.text);
            let d = Arc::new(d);
            let results = self
                .document_calls(ProviderKind::DocumentLinks, &snapshot, move |rt, t| rt.language_document_links(&d, t));
            for (p, items) in results {
                for i in items {
                    let _ = &p;
                    if valid_range_in(&text, i.range) && bounds.contains(i.range) {
                        out.push(i);
                    }
                }
            }
        }
        out
    }
    pub fn language_code_lenses(&self, doc: &ProviderDocument) -> Vec<(String, CodeLens)> {
        let mut out = Vec::new();
        for (d, bounds) in self.feature_documents(doc, None) {
            let snapshot = d.clone();
            let text = ide_text::Document::new(&snapshot.text);
            let d = Arc::new(d);
            let results =
                self.document_calls(ProviderKind::CodeLenses, &snapshot, move |rt, t| rt.language_code_lenses(&d, t));
            for (p, items) in results {
                let commands: std::collections::HashSet<_> =
                    self.ui.items(super::COMMANDS, Some(p.id())).into_iter().map(|c| c.key).collect();
                for i in items {
                    if valid_range_in(&text, i.range) && bounds.contains(i.range) && commands.contains(&i.command) {
                        out.push((p.id().to_owned(), i));
                    }
                }
            }
        }
        out
    }
    pub fn language_selection_ranges(&self, doc: &ProviderDocument, at: Pos) -> Vec<Range> {
        let mut out = Vec::new();
        for (d, bounds) in self.feature_documents(doc, Some(at)) {
            let snapshot = d.clone();
            let text = ide_text::Document::new(&snapshot.text);
            let d = Arc::new(d);
            let results = self.document_calls(ProviderKind::SelectionRanges, &snapshot, move |rt, t| {
                rt.language_selection_ranges(&d, at, t)
            });
            for (p, items) in results {
                for i in items {
                    let _ = &p;
                    if valid_range_in(&text, i) && i.start <= at && at <= i.end && bounds.contains(i) {
                        out.push(i);
                    }
                }
            }
        }
        out.sort_by(|a, b| b.start.cmp(&a.start).then(a.end.cmp(&b.end)));
        out.dedup();
        let mut end = None;
        out.retain(|r| {
            let ok = end.is_none_or(|prev: Range| r.start <= prev.start && prev.end <= r.end);
            if ok {
                end = Some(*r);
            }
            ok
        });
        out
    }
    pub fn language_folding(&self, doc: &ProviderDocument) -> Vec<FoldRange> {
        let mut out = Vec::new();
        for (d, bounds) in self.feature_documents(doc, None) {
            let lines = d.text.split('\n').count() as u32;
            let snapshot = d.clone();
            let d = Arc::new(d);
            let results =
                self.document_calls(ProviderKind::Folding, &snapshot, move |rt, t| rt.language_folding(&d, t));
            for (p, items) in results {
                for i in items {
                    let _ = &p;
                    if i.start_line < i.end_line && i.end_line < lines && bounds.lines(i.start_line, i.end_line) {
                        out.push(i);
                    }
                }
            }
        }
        out
    }
    pub fn language_colors(&self, doc: &ProviderDocument) -> Vec<(String, ColorInfo)> {
        let mut out = Vec::new();
        for (d, bounds) in self.feature_documents(doc, None) {
            let snapshot = d.clone();
            let text = ide_text::Document::new(&snapshot.text);
            let d = Arc::new(d);
            let results = self.document_calls(ProviderKind::Colors, &snapshot, move |rt, t| rt.language_colors(&d, t));
            for (p, items) in results {
                for i in items {
                    if valid_range_in(&text, i.range)
                        && bounds.contains(i.range)
                        && [i.red, i.green, i.blue, i.alpha].iter().all(|c| c.is_finite() && (0.0..=1.0).contains(c))
                    {
                        out.push((p.id().to_owned(), i));
                    }
                }
            }
        }
        out
    }
    pub fn language_color_presentations(&self, id: &str, doc: &ProviderDocument, color: ColorInfo) -> Vec<String> {
        for (d, bounds) in self.feature_documents(doc, Some(color.range.start)) {
            if !bounds.contains(color.range)
                || !self.provider_plugins(ProviderKind::Colors, &d.language).iter().any(|p| p.id() == id)
            {
                continue;
            }
            let snapshot = d.clone();
            let d = Arc::new(d);
            let color = color.clone();
            let result = self.document_calls_for(ProviderKind::Colors, &snapshot, Some(id), move |rt, t| {
                rt.language_color_presentations(&d, color.clone(), t)
            });
            if let Some((_, items)) = result.into_iter().find(|(p, _)| p.id() == id) {
                return items.into_iter().take(100).collect();
            }
        }
        Vec::new()
    }
    pub fn language_document_symbols(&self, doc: &ProviderDocument) -> Vec<DocumentSymbol> {
        let mut out = Vec::new();
        for (d, bounds) in self.feature_documents(doc, None) {
            let snapshot = d.clone();
            let text = ide_text::Document::new(&snapshot.text);
            let d = Arc::new(d);
            let results = self.document_calls(ProviderKind::DocumentSymbols, &snapshot, move |rt, t| {
                rt.language_document_symbols(&d, t)
            });
            for (_, items) in results {
                let mut remap = std::collections::HashMap::new();
                for (index, mut i) in items.into_iter().enumerate() {
                    if !valid_range_in(&text, i.range)
                        || !valid_range_in(&text, i.selection_range)
                        || i.selection_range.start < i.range.start
                        || i.selection_range.end > i.range.end
                        || !bounds.contains(i.range)
                    {
                        continue;
                    }
                    i.parent = i.parent.and_then(|p| remap.get(&(p as usize)).copied());
                    remap.insert(index, out.len() as u32);
                    out.push(i);
                }
            }
        }
        out
    }
    pub fn language_implementation(&self, doc: &ProviderDocument, at: Pos) -> Vec<ide_plugin::Location> {
        let mut out = Vec::new();
        for (d, _bounds) in self.feature_documents(doc, Some(at)) {
            let snapshot = d.clone();
            let d = Arc::new(d);
            let results = self.document_calls(ProviderKind::Implementation, &snapshot, move |rt, t| {
                rt.language_implementation(&d, at, t)
            });
            for (p, items) in results {
                for i in items {
                    let _ = &p;
                    out.push(i);
                }
            }
        }
        out
    }
    pub fn language_type_definition(&self, doc: &ProviderDocument, at: Pos) -> Vec<ide_plugin::Location> {
        let mut out = Vec::new();
        for (d, _bounds) in self.feature_documents(doc, Some(at)) {
            let snapshot = d.clone();
            let d = Arc::new(d);
            let results = self.document_calls(ProviderKind::TypeDefinition, &snapshot, move |rt, t| {
                rt.language_type_definition(&d, at, t)
            });
            for (p, items) in results {
                for i in items {
                    let _ = &p;
                    out.push(i);
                }
            }
        }
        out
    }
    pub fn language_gutter_actions(&self, doc: &ProviderDocument) -> Vec<(String, GutterAction)> {
        let mut out = Vec::new();
        for (d, bounds) in self.feature_documents(doc, None) {
            let lines = d.text.split('\n').count() as u32;
            let snapshot = d.clone();
            let d = Arc::new(d);
            let results = self
                .document_calls(ProviderKind::GutterActions, &snapshot, move |rt, t| rt.language_gutter_actions(&d, t));
            for (p, items) in results {
                let commands: std::collections::HashSet<_> =
                    self.ui.items(super::COMMANDS, Some(p.id())).into_iter().map(|c| c.key).collect();
                for i in items {
                    if i.line < lines && bounds.lines(i.line, i.line) && commands.contains(&i.command) {
                        out.push((p.id().to_owned(), i));
                    }
                }
            }
        }
        out
    }
}

impl PluginHost {
    pub(crate) fn run_language_command(
        &self,
        plugin: &str,
        command: &str,
        argument: Option<&str>,
        invocation: ide_plugin::Invocation,
    ) -> IdeResult<()> {
        if !self.ui.items(super::COMMANDS, Some(plugin)).iter().any(|c| c.key == command) {
            return Err(ide_core::IdeError::not_found("The plugin did not declare this command"));
        }
        self.run_command(plugin, command, argument, invocation).map(|_| ())
    }
}

pub(crate) fn signature_help(h: SignatureHelp) -> ide_lsp::types::SignatureHelp {
    let signatures: Vec<_> = h
        .signatures
        .into_iter()
        .take(100)
        .map(|s| {
            let len = s.label.encode_utf16().count() as u32;
            let parameters = s
                .parameters
                .into_iter()
                .take(100)
                .map(|p| match p.label {
                    ParameterLabel::Offsets((a, b)) => (a.min(len), b.max(a).min(len)),
                    ParameterLabel::Text(t) => s
                        .label
                        .find(&t)
                        .map(|a| {
                            let start = s.label[..a].encode_utf16().count() as u32;
                            (start, start + t.encode_utf16().count() as u32)
                        })
                        .unwrap_or((0, 0)),
                })
                .collect();
            ide_lsp::types::Signature {
                label: s.label,
                documentation: s.documentation.map(|value| ide_lsp::types::Markup { kind: "markdown".into(), value }),
                parameters,
            }
        })
        .collect();
    let active_signature = h.active_signature.min(signatures.len().saturating_sub(1) as u32);
    let active_parameter =
        h.active_parameter
            .min(signatures.get(active_signature as usize).map(|s| s.parameters.len().saturating_sub(1)).unwrap_or(0)
                as u32);
    ide_lsp::types::SignatureHelp { signatures, active_signature, active_parameter }
}

pub(crate) fn outline(items: Vec<DocumentSymbol>) -> Vec<ide_core::OutlineItem> {
    // A parent must precede its child, ruling out cycles and unbounded recursion.
    let mut depths = vec![0usize; items.len()];
    let mut parents = vec![None; items.len()];
    for (idx, item) in items.iter().enumerate() {
        if let Some(parent) = item.parent.map(|p| p as usize).filter(|p| {
            *p < idx
                && depths[*p] < 63
                && items[*p].range.start <= item.range.start
                && item.range.end <= items[*p].range.end
        }) {
            parents[idx] = Some(parent);
            depths[idx] = depths[parent] + 1;
        }
    }
    let mut nodes: Vec<_> = items
        .into_iter()
        .map(|i| {
            Some(ide_core::OutlineItem {
                name: i.name,
                detail: Some(i.detail).filter(|s| !s.is_empty()),
                kind: serde_json::from_value(serde_json::Value::String(symbol_kind_name(&i.kind)))
                    .unwrap_or(ide_core::SymbolKind::Unknown),
                range: i.range,
                selection_range: i.selection_range,
                children: vec![],
                visibility: None,
            })
        })
        .collect();
    let mut roots = Vec::new();
    for idx in (0..nodes.len()).rev() {
        let mut node = nodes[idx].take().expect("once");
        node.children.reverse();
        if let Some(parent) = parents[idx] {
            nodes[parent].as_mut().expect("parent precedes child").children.push(node);
        } else {
            roots.push(node);
        }
    }
    roots.reverse();
    roots
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FormatterChoice {
    pub id: String,
    pub name: String,
    pub languages: Vec<String>,
}
impl PluginHost {
    pub fn formatter_choices(&self) -> Vec<FormatterChoice> {
        let mut out = std::collections::BTreeMap::<String, FormatterChoice>::new();
        for (id, languages) in self.providers.formatter_declarations() {
            let Ok(p) = self.get(&id) else {
                continue;
            };
            if !matches!(p.meta.lock().status, super::PluginStatus::Active | super::PluginStatus::Inactive) {
                continue;
            }
            out.entry(id.clone())
                .or_insert_with(|| FormatterChoice { id, name: p.pkg.manifest.name.clone(), languages: vec![] })
                .languages
                .extend(languages);
        }
        out.into_values()
            .map(|mut c| {
                c.languages.sort();
                c.languages.dedup();
                c
            })
            .collect()
    }
}

fn symbol_kind_name(kind: &str) -> String {
    let mut parts = kind.split('-');
    let mut out = parts.next().unwrap_or_default().to_owned();
    for part in parts {
        let mut chars = part.chars();
        if let Some(c) = chars.next() {
            out.extend(c.to_uppercase());
            out.extend(chars);
        }
    }
    out
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn outline_uses_parent_order_containment_and_string_kinds() {
        let range = Range::new(Pos::new(0, 0), Pos::new(0, 10));
        let item = |name: &str, parent| DocumentSymbol {
            name: name.into(),
            detail: String::new(),
            kind: "enum-member".into(),
            range,
            selection_range: range,
            parent,
        };
        let out =
            outline(vec![item("root", None), item("child", Some(0)), item("future", Some(3)), item("other", Some(2))]);
        assert_eq!(out[0].children[0].kind, ide_core::SymbolKind::EnumMember);
        assert_eq!(out[1].name, "future");
        assert_eq!(out[1].children[0].name, "other");
    }
}
