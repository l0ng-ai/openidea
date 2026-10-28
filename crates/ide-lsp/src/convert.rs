//! `lsp-types` ⇄ IDE type mapping, including position-encoding conversion.

use crate::text::{DocText, Encoding, convert_offsets};
use crate::types::*;
use crate::uri::{uri_target, uri_to_path};
use ide_core::{
    Diagnostic, FileEdit, Location, OutlineItem, Pos, Range, ServerId, Severity, SymbolKind, TextEdit, WorkspaceEdit,
};
use lsp_types as lsp;
use parking_lot::Mutex;
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

pub type Lookup<'a> = Box<dyn Fn(&Path) -> Option<Arc<DocText>> + Send + Sync + 'a>;

/// Converts server positions to IDE coordinates. For UTF-16 servers this is
/// the identity; otherwise line text comes from open documents or disk.
pub struct Conv<'a> {
    pub enc: Encoding,
    lookup: Lookup<'a>,
    cache: Mutex<HashMap<PathBuf, Option<Arc<DocText>>>>,
}

impl<'a> Conv<'a> {
    pub fn new(enc: Encoding, lookup: impl Fn(&Path) -> Option<Arc<DocText>> + Send + Sync + 'a) -> Self {
        Self { enc, lookup: Box::new(lookup), cache: Mutex::new(HashMap::new()) }
    }

    #[cfg(test)]
    pub fn utf16() -> Conv<'static> {
        Conv::new(Encoding::Utf16, |_| None)
    }

    fn text(&self, path: &Path) -> Option<Arc<DocText>> {
        let mut cache = self.cache.lock();
        cache
            .entry(path.to_owned())
            .or_insert_with(|| {
                (self.lookup)(path).or_else(|| std::fs::read_to_string(path).ok().map(|t| Arc::new(DocText::new(&t))))
            })
            .clone()
    }

    pub fn pos(&self, path: &Path, p: lsp::Position) -> Pos {
        if self.enc == Encoding::Utf16 {
            return Pos::new(p.line, p.character);
        }
        match self.text(path) {
            Some(text) => text.lsp_to_ide(self.enc, p),
            None => Pos::new(p.line, p.character),
        }
    }

    pub fn range(&self, path: &Path, r: lsp::Range) -> Range {
        Range::new(self.pos(path, r.start), self.pos(path, r.end))
    }

    /// Non-`file:` targets (library classes from `jdt://` and the like) are
    /// kept as virtual locations rather than dropped.
    pub fn location(&self, loc: &lsp::Location) -> Option<Location> {
        let (path, uri) = uri_target(loc.uri.as_str());
        let range = self.range(&path, loc.range);
        Some(Location { path: path.into(), range, uri })
    }

    pub fn text_edit(&self, path: &Path, e: lsp::TextEdit) -> TextEdit {
        TextEdit { range: self.range(path, e.range), new_text: e.new_text }
    }

    pub fn text_edits(&self, path: &Path, edits: Vec<lsp::TextEdit>) -> Vec<TextEdit> {
        edits.into_iter().map(|e| self.text_edit(path, e)).collect()
    }
}

/// IDE → server for positions inside an open document.
pub fn lsp_range(text: &DocText, enc: Encoding, r: Range) -> lsp::Range {
    lsp::Range::new(text.ide_to_lsp(enc, r.start), text.ide_to_lsp(enc, r.end))
}

pub fn lsp_text_edit(text: &DocText, enc: Encoding, e: &TextEdit) -> lsp::TextEdit {
    lsp::TextEdit { range: lsp_range(text, enc, e.range), new_text: e.new_text.clone() }
}

// ---------------------------------------------------------------- kinds

pub fn symbol_kind(k: lsp::SymbolKind) -> SymbolKind {
    use lsp::SymbolKind as L;
    match k {
        L::FILE => SymbolKind::File,
        L::MODULE => SymbolKind::Module,
        L::NAMESPACE => SymbolKind::Namespace,
        L::PACKAGE => SymbolKind::Package,
        L::CLASS => SymbolKind::Class,
        L::METHOD => SymbolKind::Method,
        L::PROPERTY => SymbolKind::Property,
        L::FIELD => SymbolKind::Field,
        L::CONSTRUCTOR => SymbolKind::Constructor,
        L::ENUM => SymbolKind::Enum,
        L::INTERFACE => SymbolKind::Interface,
        L::FUNCTION => SymbolKind::Function,
        L::VARIABLE | L::ARRAY | L::OBJECT => SymbolKind::Variable,
        L::CONSTANT | L::STRING | L::NUMBER | L::BOOLEAN | L::NULL => SymbolKind::Constant,
        L::KEY => SymbolKind::Key,
        L::ENUM_MEMBER => SymbolKind::EnumMember,
        L::STRUCT => SymbolKind::Struct,
        L::EVENT => SymbolKind::Event,
        L::OPERATOR => SymbolKind::Operator,
        L::TYPE_PARAMETER => SymbolKind::TypeParameter,
        _ => SymbolKind::Unknown,
    }
}

pub fn completion_kind(k: lsp::CompletionItemKind) -> Option<CompletionKind> {
    use CompletionKind as C;
    use lsp::CompletionItemKind as L;
    Some(match k {
        L::TEXT => C::Text,
        L::METHOD => C::Method,
        L::FUNCTION => C::Function,
        L::CONSTRUCTOR => C::Constructor,
        L::FIELD => C::Field,
        L::VARIABLE => C::Variable,
        L::CLASS => C::Class,
        L::INTERFACE => C::Interface,
        L::MODULE => C::Module,
        L::PROPERTY => C::Property,
        L::UNIT => C::Unit,
        L::VALUE => C::Value,
        L::ENUM => C::Enum,
        L::KEYWORD => C::Keyword,
        L::SNIPPET => C::Snippet,
        L::COLOR => C::Color,
        L::FILE => C::File,
        L::REFERENCE => C::Reference,
        L::FOLDER => C::Folder,
        L::ENUM_MEMBER => C::EnumMember,
        L::CONSTANT => C::Constant,
        L::STRUCT => C::Struct,
        L::EVENT => C::Event,
        L::OPERATOR => C::Operator,
        L::TYPE_PARAMETER => C::TypeParameter,
        _ => return None,
    })
}

pub fn lsp_completion_kind(k: CompletionKind) -> lsp::CompletionItemKind {
    use CompletionKind as C;
    use lsp::CompletionItemKind as L;
    match k {
        C::Text => L::TEXT,
        C::Method => L::METHOD,
        C::Function => L::FUNCTION,
        C::Constructor => L::CONSTRUCTOR,
        C::Field => L::FIELD,
        C::Variable => L::VARIABLE,
        C::Class => L::CLASS,
        C::Interface => L::INTERFACE,
        C::Module => L::MODULE,
        C::Property => L::PROPERTY,
        C::Unit => L::UNIT,
        C::Value => L::VALUE,
        C::Enum => L::ENUM,
        C::Keyword => L::KEYWORD,
        C::Snippet => L::SNIPPET,
        C::Color => L::COLOR,
        C::File => L::FILE,
        C::Reference => L::REFERENCE,
        C::Folder => L::FOLDER,
        C::EnumMember => L::ENUM_MEMBER,
        C::Constant => L::CONSTANT,
        C::Struct => L::STRUCT,
        C::Event => L::EVENT,
        C::Operator => L::OPERATOR,
        C::TypeParameter => L::TYPE_PARAMETER,
    }
}

// ---------------------------------------------------------------- markup

pub fn markup_content(m: lsp::MarkupContent) -> Markup {
    let kind = match m.kind {
        lsp::MarkupKind::Markdown => "markdown",
        lsp::MarkupKind::PlainText => "plaintext",
    };
    Markup { kind: kind.into(), value: m.value }
}

pub fn documentation(d: lsp::Documentation) -> Option<Markup> {
    let m = match d {
        lsp::Documentation::String(s) => Markup { kind: "plaintext".into(), value: s },
        lsp::Documentation::MarkupContent(m) => markup_content(m),
    };
    (!m.value.trim().is_empty()).then_some(m)
}

fn lsp_documentation(m: &Markup) -> lsp::Documentation {
    lsp::Documentation::MarkupContent(lsp::MarkupContent {
        kind: if m.kind == "markdown" { lsp::MarkupKind::Markdown } else { lsp::MarkupKind::PlainText },
        value: m.value.clone(),
    })
}

fn marked_string(m: lsp::MarkedString) -> String {
    match m {
        lsp::MarkedString::String(s) => s,
        lsp::MarkedString::LanguageString(ls) => format!("```{}\n{}\n```", ls.language, ls.value),
    }
}

pub fn hover(conv: &Conv, path: &Path, h: lsp::Hover) -> Option<Hover> {
    let contents = match h.contents {
        lsp::HoverContents::Scalar(m) => Markup { kind: "markdown".into(), value: marked_string(m) },
        lsp::HoverContents::Array(ms) => Markup {
            kind: "markdown".into(),
            value: ms.into_iter().map(marked_string).filter(|s| !s.trim().is_empty()).collect::<Vec<_>>().join("\n\n"),
        },
        lsp::HoverContents::Markup(m) => markup_content(m),
    };
    if contents.value.trim().is_empty() {
        return None;
    }
    Some(Hover { contents, range: h.range.map(|r| conv.range(path, r)) })
}

// ---------------------------------------------------------------- completion

/// Applies `CompletionList.itemDefaults` (LSP 3.17) to a raw item.
pub fn apply_item_defaults(item: &mut Value, defaults: Option<&Value>) {
    let (Some(defaults), Some(obj)) = (defaults.and_then(Value::as_object), item.as_object_mut()) else { return };
    for key in ["commitCharacters", "insertTextFormat", "insertTextMode", "data"] {
        if let Some(v) = defaults.get(key)
            && !obj.contains_key(key)
        {
            obj.insert(key.into(), v.clone());
        }
    }
    if let Some(range) = defaults.get("editRange")
        && !obj.contains_key("textEdit")
    {
        let new_text = obj
            .get("textEditText")
            .or_else(|| obj.get("insertText"))
            .or_else(|| obj.get("label"))
            .cloned()
            .unwrap_or_default();
        let edit = if range.get("insert").is_some() {
            serde_json::json!({ "newText": new_text, "insert": range["insert"], "replace": range["replace"] })
        } else {
            serde_json::json!({ "newText": new_text, "range": range })
        };
        obj.insert("textEdit".into(), edit);
    }
}

/// Parses a `textDocument/completion` result (array, list, or null).
pub fn parse_completion_response(v: Value) -> (bool, Vec<lsp::CompletionItem>) {
    let (incomplete, items, defaults) = match v {
        Value::Array(items) => (false, items, None),
        Value::Object(mut o) => {
            let incomplete = o.get("isIncomplete").and_then(Value::as_bool).unwrap_or(false);
            let items = match o.remove("items") {
                Some(Value::Array(a)) => a,
                _ => Vec::new(),
            };
            (incomplete, items, o.remove("itemDefaults"))
        }
        _ => (false, Vec::new(), None),
    };
    let items = items
        .into_iter()
        .filter_map(|mut item| {
            apply_item_defaults(&mut item, defaults.as_ref());
            serde_json::from_value(item).map_err(|e| tracing::debug!("skipping completion item: {e}")).ok()
        })
        .collect();
    (incomplete, items)
}

pub fn completion_item(conv: &Conv, path: &Path, item: lsp::CompletionItem, server: ServerId) -> CompletionItem {
    let mut out = CompletionItem {
        label: item.label.clone(),
        label_detail: None,
        detail: None,
        kind: None,
        documentation: None,
        sort_text: None,
        filter_text: None,
        preselect: false,
        deprecated: false,
        insert_text: String::new(),
        is_snippet: false,
        replace_range: None,
        replace_range_tab: None,
        additional_edits: Vec::new(),
        commit_characters: Vec::new(),
        command: None,
        data: None,
        server,
    };
    overlay_completion(conv, path, &mut out, item, true);
    out
}

/// Writes the fields present in `item` onto `out`. With `full`, absent fields
/// reset to defaults (fresh items); otherwise they keep `out`'s values (resolve).
pub fn overlay_completion(conv: &Conv, path: &Path, out: &mut CompletionItem, item: lsp::CompletionItem, full: bool) {
    let lsp::CompletionItem {
        label,
        label_details,
        kind,
        detail,
        documentation: docs,
        deprecated,
        preselect,
        sort_text,
        filter_text,
        insert_text,
        insert_text_format,
        text_edit,
        additional_text_edits,
        command: cmd,
        commit_characters,
        data,
        tags,
        ..
    } = item;
    let description = label_details.as_ref().and_then(|d| d.description.clone());
    if let Some(d) = label_details.and_then(|d| d.detail) {
        out.label_detail = Some(d);
    }
    if let Some(d) = detail.or(description) {
        out.detail = Some(d);
    }
    if let Some(k) = kind.and_then(completion_kind) {
        out.kind = Some(k);
    }
    if let Some(d) = docs.and_then(documentation) {
        out.documentation = Some(d);
    }
    if sort_text.is_some() || full {
        out.sort_text = sort_text;
    }
    if filter_text.is_some() || full {
        out.filter_text = filter_text;
    }
    if let Some(p) = preselect {
        out.preselect = p;
    }
    let tagged_deprecated = tags.is_some_and(|t| t.contains(&lsp::CompletionItemTag::DEPRECATED));
    if deprecated.is_some() || tagged_deprecated || full {
        out.deprecated = deprecated.unwrap_or(false) || tagged_deprecated;
    }
    let has_insert = text_edit.is_some() || insert_text.is_some();
    if has_insert || full {
        out.is_snippet = insert_text_format == Some(lsp::InsertTextFormat::SNIPPET);
        match text_edit {
            Some(lsp::CompletionTextEdit::Edit(e)) => {
                out.replace_range = Some(conv.range(path, e.range));
                out.replace_range_tab = None;
                out.insert_text = e.new_text;
            }
            Some(lsp::CompletionTextEdit::InsertAndReplace(e)) => {
                let insert = conv.range(path, e.insert);
                let replace = conv.range(path, e.replace);
                out.replace_range = Some(insert);
                out.replace_range_tab = (replace != insert).then_some(replace);
                out.insert_text = e.new_text;
            }
            None => {
                out.replace_range = None;
                out.replace_range_tab = None;
                out.insert_text = insert_text.unwrap_or(label);
            }
        }
    }
    if let Some(edits) = additional_text_edits {
        out.additional_edits = conv.text_edits(path, edits);
    } else if full {
        out.additional_edits.clear();
    }
    if let Some(c) = commit_characters {
        out.commit_characters = c;
    }
    if let Some(c) = cmd {
        out.command = Some(command(c));
    }
    if data.is_some() || full {
        out.data = data;
    }
}

/// Rebuilds the server-side item for `completionItem/resolve`.
pub fn lsp_completion_item(text: &DocText, enc: Encoding, item: &CompletionItem) -> lsp::CompletionItem {
    let text_edit = item.replace_range.map(|insert| match item.replace_range_tab {
        Some(replace) => lsp::CompletionTextEdit::InsertAndReplace(lsp::InsertReplaceEdit {
            new_text: item.insert_text.clone(),
            insert: lsp_range(text, enc, insert),
            replace: lsp_range(text, enc, replace),
        }),
        None => lsp::CompletionTextEdit::Edit(lsp::TextEdit {
            range: lsp_range(text, enc, insert),
            new_text: item.insert_text.clone(),
        }),
    });
    lsp::CompletionItem {
        label: item.label.clone(),
        label_details: item
            .label_detail
            .clone()
            .map(|detail| lsp::CompletionItemLabelDetails { detail: Some(detail), description: None }),
        kind: item.kind.map(lsp_completion_kind),
        detail: item.detail.clone(),
        documentation: item.documentation.as_ref().map(lsp_documentation),
        deprecated: item.deprecated.then_some(true),
        preselect: item.preselect.then_some(true),
        sort_text: item.sort_text.clone(),
        filter_text: item.filter_text.clone(),
        insert_text: text_edit.is_none().then(|| item.insert_text.clone()),
        insert_text_format: Some(if item.is_snippet {
            lsp::InsertTextFormat::SNIPPET
        } else {
            lsp::InsertTextFormat::PLAIN_TEXT
        }),
        insert_text_mode: None,
        text_edit,
        additional_text_edits: (!item.additional_edits.is_empty())
            .then(|| item.additional_edits.iter().map(|e| lsp_text_edit(text, enc, e)).collect()),
        command: item.command.as_ref().map(lsp_command),
        commit_characters: (!item.commit_characters.is_empty()).then(|| item.commit_characters.clone()),
        data: item.data.clone(),
        tags: None,
    }
}

// ---------------------------------------------------------------- inline completion

/// `InlineCompletionList | InlineCompletionItem[] | null` → items (malformed ones skipped).
pub fn inline_completion_items(conv: &Conv, path: &Path, v: Value, server: ServerId) -> Vec<InlineCompletionItem> {
    let items = match v {
        Value::Array(a) => a,
        Value::Object(mut o) => match o.remove("items") {
            Some(Value::Array(a)) => a,
            _ => Vec::new(),
        },
        _ => Vec::new(),
    };
    items
        .into_iter()
        .filter_map(|it| {
            let insert_text = match it.get("insertText")? {
                Value::String(s) => s.clone(),
                Value::Object(o) if o.get("kind").and_then(Value::as_str) == Some("snippet") => {
                    snippet_text(o.get("value")?.as_str()?)
                }
                _ => return None,
            };
            let range = it
                .get("range")
                .and_then(|r| serde_json::from_value::<lsp::Range>(r.clone()).ok())
                .map(|r| conv.range(path, r));
            let filter_text = it.get("filterText").and_then(Value::as_str).map(str::to_owned);
            let cmd = it.get("command").and_then(|c| serde_json::from_value::<lsp::Command>(c.clone()).ok());
            Some(InlineCompletionItem { insert_text, range, filter_text, command: cmd.map(command), server })
        })
        .filter(|i| !i.insert_text.is_empty())
        .collect()
}

/// The text a snippet inserts with every placeholder at its default:
/// `foo(${1:a}, $2)$0` → `foo(a, )`; a choice takes its first option.
pub fn snippet_text(snippet: &str) -> String {
    fn parse(chars: &[char], i: &mut usize, out: &mut String, nested: bool) {
        while let Some(&ch) = chars.get(*i) {
            let next = chars.get(*i + 1).copied();
            match ch {
                '\\' if next.is_some() => {
                    out.extend(next);
                    *i += 2;
                }
                '}' if nested => {
                    *i += 1;
                    return;
                }
                '$' if next.is_some_and(|c| c.is_ascii_digit()) => {
                    *i += 1;
                    while chars.get(*i).is_some_and(char::is_ascii_digit) {
                        *i += 1;
                    }
                }
                '$' if next == Some('{') => {
                    *i += 2;
                    while chars.get(*i).is_some_and(|c| c.is_ascii_alphanumeric() || *c == '_') {
                        *i += 1;
                    }
                    match chars.get(*i) {
                        Some(':') => {
                            *i += 1;
                            parse(chars, i, out, true);
                        }
                        Some('|') => {
                            *i += 1;
                            let mut first = true;
                            while let Some(&c) = chars.get(*i).filter(|c| **c != '|') {
                                first &= c != ',';
                                if first {
                                    out.push(c);
                                }
                                *i += 1;
                            }
                            *i = (*i + 2).min(chars.len());
                        }
                        // `${1}`, or a variable without a default.
                        Some('}') => *i += 1,
                        _ => {}
                    }
                }
                _ => {
                    out.push(ch);
                    *i += 1;
                }
            }
        }
    }
    let chars: Vec<char> = snippet.chars().collect();
    let mut out = String::new();
    parse(&chars, &mut 0, &mut out, false);
    out
}

// ---------------------------------------------------------------- commands & actions

pub fn command(c: lsp::Command) -> Command {
    Command { title: c.title, command: c.command, arguments: c.arguments.unwrap_or_default() }
}

pub fn lsp_command(c: &Command) -> lsp::Command {
    lsp::Command {
        title: c.title.clone(),
        command: c.command.clone(),
        arguments: (!c.arguments.is_empty()).then(|| c.arguments.clone()),
    }
}

pub fn code_action(conv: &Conv, a: lsp::CodeActionOrCommand, server: ServerId) -> CodeAction {
    match a {
        lsp::CodeActionOrCommand::Command(c) => CodeAction {
            title: c.title.clone(),
            kind: None,
            is_preferred: false,
            disabled_reason: None,
            edit: None,
            command: Some(command(c)),
            data: None,
            server,
        },
        lsp::CodeActionOrCommand::CodeAction(a) => CodeAction {
            title: a.title,
            kind: a.kind.map(|k| k.as_str().to_owned()),
            is_preferred: a.is_preferred.unwrap_or(false),
            disabled_reason: a.disabled.map(|d| d.reason),
            edit: a.edit.map(|e| workspace_edit(conv, e)),
            command: a.command.map(command),
            data: a.data,
            server,
        },
    }
}

pub fn lsp_code_action(a: &CodeAction) -> lsp::CodeAction {
    lsp::CodeAction {
        title: a.title.clone(),
        kind: a.kind.clone().map(lsp::CodeActionKind::from),
        diagnostics: None,
        edit: None,
        command: a.command.as_ref().map(lsp_command),
        is_preferred: a.is_preferred.then_some(true),
        disabled: a.disabled_reason.clone().map(|reason| lsp::CodeActionDisabled { reason }),
        data: a.data.clone(),
    }
}

/// Merges a resolved action into the original, keeping fields the server omitted.
pub fn merge_code_action(conv: &Conv, mut original: CodeAction, resolved: lsp::CodeAction) -> CodeAction {
    if let Some(e) = resolved.edit {
        original.edit = Some(workspace_edit(conv, e));
    }
    if let Some(c) = resolved.command {
        original.command = Some(command(c));
    }
    if resolved.data.is_some() {
        original.data = resolved.data;
    }
    if let Some(d) = resolved.disabled {
        original.disabled_reason = Some(d.reason);
    }
    original
}

// ---------------------------------------------------------------- workspace edits

fn uri_path(uri: &lsp::Uri) -> Option<PathBuf> {
    let p = uri_to_path(uri.as_str());
    if p.is_none() {
        tracing::debug!("ignoring non-file URI {}", uri.as_str());
    }
    p
}

pub fn workspace_edit(conv: &Conv, e: lsp::WorkspaceEdit) -> WorkspaceEdit {
    let mut files = Vec::new();
    let doc_edit = |files: &mut Vec<FileEdit>, e: lsp::TextDocumentEdit| {
        let Some(path) = uri_path(&e.text_document.uri) else { return };
        let edits = e
            .edits
            .into_iter()
            .map(|e| match e {
                lsp::OneOf::Left(e) => e,
                lsp::OneOf::Right(a) => a.text_edit,
            })
            .map(|e| conv.text_edit(&path, e))
            .collect();
        files.push(FileEdit::Edit { path: path.into(), edits });
    };
    if let Some(changes) = e.document_changes {
        match changes {
            lsp::DocumentChanges::Edits(edits) => edits.into_iter().for_each(|e| doc_edit(&mut files, e)),
            lsp::DocumentChanges::Operations(ops) => {
                for op in ops {
                    match op {
                        lsp::DocumentChangeOperation::Edit(e) => doc_edit(&mut files, e),
                        lsp::DocumentChangeOperation::Op(lsp::ResourceOp::Create(c)) => {
                            if let Some(path) = uri_path(&c.uri) {
                                let overwrite = c.options.and_then(|o| o.overwrite).unwrap_or(false);
                                files.push(FileEdit::Create { path: path.into(), overwrite });
                            }
                        }
                        lsp::DocumentChangeOperation::Op(lsp::ResourceOp::Rename(r)) => {
                            if let (Some(from), Some(to)) = (uri_path(&r.old_uri), uri_path(&r.new_uri)) {
                                files.push(FileEdit::Rename { from: from.into(), to: to.into() });
                            }
                        }
                        lsp::DocumentChangeOperation::Op(lsp::ResourceOp::Delete(d)) => {
                            if let Some(path) = uri_path(&d.uri) {
                                let recursive = d.options.and_then(|o| o.recursive).unwrap_or(false);
                                files.push(FileEdit::Delete { path: path.into(), recursive });
                            }
                        }
                    }
                }
            }
        }
    } else if let Some(changes) = e.changes {
        let mut changes: Vec<_> = changes.into_iter().collect();
        changes.sort_by(|a, b| a.0.as_str().cmp(b.0.as_str()));
        for (uri, edits) in changes {
            if let Some(path) = uri_path(&uri) {
                let edits = conv.text_edits(&path, edits);
                files.push(FileEdit::Edit { path: path.into(), edits });
            }
        }
    }
    WorkspaceEdit { files }
}

/// Adds the changes of `extra`, another server's edit for the same request, to
/// `edit` where they leave its own alone: what only the other server sees
/// (Angular templates next to vtsls's TypeScript).
pub fn merge_workspace_edit(edit: &mut WorkspaceEdit, extra: WorkspaceEdit) {
    let overlap =
        |a: &TextEdit, b: &TextEdit| a.range == b.range || (a.range.start < b.range.end && b.range.start < a.range.end);
    for file in extra.files {
        let FileEdit::Edit { path, edits } = file else {
            if !edit.files.contains(&file) {
                edit.files.push(file);
            }
            continue;
        };
        let own = edit.files.iter_mut().find_map(|f| match f {
            FileEdit::Edit { path: p, edits } if *p == path => Some(edits),
            _ => None,
        });
        match own {
            Some(own) => {
                let added: Vec<TextEdit> = edits.into_iter().filter(|e| !own.iter().any(|o| overlap(o, e))).collect();
                if !added.is_empty() {
                    own.extend(added);
                    own.sort_by_key(|e| e.range.start);
                }
            }
            None => edit.files.push(FileEdit::Edit { path, edits }),
        }
    }
}

// ---------------------------------------------------------------- navigation

pub fn goto_response(conv: &Conv, r: lsp::GotoDefinitionResponse) -> Vec<Location> {
    let mut out: Vec<Location> = match r {
        lsp::GotoDefinitionResponse::Scalar(l) => conv.location(&l).into_iter().collect(),
        lsp::GotoDefinitionResponse::Array(ls) => ls.iter().filter_map(|l| conv.location(l)).collect(),
        lsp::GotoDefinitionResponse::Link(links) => links
            .into_iter()
            .filter_map(|l| conv.location(&lsp::Location::new(l.target_uri, l.target_selection_range)))
            .collect(),
    };
    dedup_locations(&mut out);
    out
}

pub fn dedup_locations(v: &mut Vec<Location>) {
    let mut seen = std::collections::HashSet::new();
    v.retain(|l| seen.insert(l.clone()));
}

pub fn highlight(conv: &Conv, path: &Path, h: lsp::DocumentHighlight) -> Highlight {
    let kind = match h.kind {
        Some(lsp::DocumentHighlightKind::READ) => HighlightKind::Read,
        Some(lsp::DocumentHighlightKind::WRITE) => HighlightKind::Write,
        _ => HighlightKind::Text,
    };
    Highlight { range: conv.range(path, h.range), kind }
}

pub fn document_symbols(conv: &Conv, path: &Path, r: lsp::DocumentSymbolResponse) -> Vec<OutlineItem> {
    match r {
        lsp::DocumentSymbolResponse::Nested(syms) => syms.into_iter().map(|s| document_symbol(conv, path, s)).collect(),
        lsp::DocumentSymbolResponse::Flat(syms) => {
            let mut flat: Vec<OutlineItem> = syms
                .into_iter()
                .filter(|s| uri_target(s.location.uri.as_str()).0 == path)
                .map(|s| {
                    let range = conv.range(path, s.location.range);
                    OutlineItem {
                        name: s.name,
                        detail: s.container_name,
                        kind: symbol_kind(s.kind),
                        range,
                        selection_range: range,
                        children: Vec::new(),
                        visibility: None,
                    }
                })
                .collect();
            // Containers first: by start, then larger extent first.
            flat.sort_by(|a, b| a.range.start.cmp(&b.range.start).then(b.range.end.cmp(&a.range.end)));
            nest(flat)
        }
    }
}

fn document_symbol(conv: &Conv, path: &Path, s: lsp::DocumentSymbol) -> OutlineItem {
    OutlineItem {
        name: s.name,
        detail: s.detail.filter(|d| !d.is_empty()),
        kind: symbol_kind(s.kind),
        range: conv.range(path, s.range),
        selection_range: conv.range(path, s.selection_range),
        children: s.children.unwrap_or_default().into_iter().map(|c| document_symbol(conv, path, c)).collect(),
        visibility: None,
    }
}

/// Builds a tree from flat items sorted by (start asc, end desc) using range containment.
fn nest(sorted: Vec<OutlineItem>) -> Vec<OutlineItem> {
    fn contains(outer: &Range, inner: &Range) -> bool {
        outer.start <= inner.start && inner.end <= outer.end && outer != inner
    }
    let mut roots: Vec<OutlineItem> = Vec::new();
    let mut stack: Vec<OutlineItem> = Vec::new();
    for item in sorted {
        while let Some(top) = stack.last() {
            if contains(&top.range, &item.range) {
                break;
            }
            let done = stack.pop().expect("non-empty");
            match stack.last_mut() {
                Some(parent) => parent.children.push(done),
                None => roots.push(done),
            }
        }
        stack.push(item);
    }
    while let Some(done) = stack.pop() {
        match stack.last_mut() {
            Some(parent) => parent.children.push(done),
            None => roots.push(done),
        }
    }
    roots
}

pub fn workspace_symbols(conv: &Conv, r: lsp::WorkspaceSymbolResponse) -> Vec<WorkspaceSymbol> {
    match r {
        lsp::WorkspaceSymbolResponse::Flat(syms) => syms
            .into_iter()
            .filter_map(|s| {
                Some(WorkspaceSymbol {
                    location: conv.location(&s.location)?,
                    name: s.name,
                    kind: symbol_kind(s.kind),
                    container: s.container_name,
                })
            })
            .collect(),
        lsp::WorkspaceSymbolResponse::Nested(syms) => syms
            .into_iter()
            .filter_map(|s| {
                let location = match s.location {
                    lsp::OneOf::Left(l) => conv.location(&l)?,
                    lsp::OneOf::Right(w) => {
                        let (path, uri) = uri_target(w.uri.as_str());
                        Location { path: path.into(), range: Range::default(), uri }
                    }
                };
                Some(WorkspaceSymbol { name: s.name, kind: symbol_kind(s.kind), container: s.container_name, location })
            })
            .collect(),
    }
}

pub fn signature_help(conv_enc: Encoding, h: lsp::SignatureHelp) -> Option<SignatureHelp> {
    if h.signatures.is_empty() {
        return None;
    }
    let active_signature = h.active_signature.unwrap_or(0).min(h.signatures.len() as u32 - 1);
    let sig_active_param = h.signatures.get(active_signature as usize).and_then(|s| s.active_parameter);
    let active_parameter = sig_active_param.or(h.active_parameter).unwrap_or(0);
    let signatures = h
        .signatures
        .into_iter()
        .map(|s| {
            let mut search_from = 0usize; // byte offset in label
            let parameters = s
                .parameters
                .unwrap_or_default()
                .into_iter()
                .map(|p| match p.label {
                    lsp::ParameterLabel::LabelOffsets([a, b]) => {
                        convert_offsets(&s.label, a as usize, b as usize, conv_enc)
                    }
                    lsp::ParameterLabel::Simple(name) => match s.label[search_from..].find(&name) {
                        Some(i) => {
                            let start = search_from + i;
                            let end = start + name.len();
                            search_from = end;
                            convert_offsets(&s.label, start, end, Encoding::Utf8)
                        }
                        None => (0, 0),
                    },
                })
                .collect();
            Signature { label: s.label, documentation: s.documentation.and_then(documentation), parameters }
        })
        .collect();
    Some(SignatureHelp { signatures, active_signature, active_parameter })
}

// ---------------------------------------------------------------- decorations

pub fn inlay_hint(conv: &Conv, path: &Path, h: lsp::InlayHint) -> InlayHint {
    let tooltip_text = |t: lsp::InlayHintTooltip| match t {
        lsp::InlayHintTooltip::String(s) => s,
        lsp::InlayHintTooltip::MarkupContent(m) => m.value,
    };
    let (label, parts) = match h.label {
        lsp::InlayHintLabel::String(s) => (s, Vec::new()),
        lsp::InlayHintLabel::LabelParts(parts) => {
            let label = parts.iter().map(|p| p.value.as_str()).collect();
            let parts = parts
                .into_iter()
                .map(|p| InlayLabelPart {
                    value: p.value,
                    tooltip: p.tooltip.map(|t| match t {
                        lsp::InlayHintLabelPartTooltip::String(s) => s,
                        lsp::InlayHintLabelPartTooltip::MarkupContent(m) => m.value,
                    }),
                    location: p.location.as_ref().and_then(|l| conv.location(l)),
                })
                .collect();
            (label, parts)
        }
    };
    let kind = match h.kind {
        Some(lsp::InlayHintKind::TYPE) => InlayKind::Type,
        Some(lsp::InlayHintKind::PARAMETER) => InlayKind::Parameter,
        _ => InlayKind::Other,
    };
    let tooltip = h.tooltip.map(tooltip_text);
    InlayHint {
        position: conv.pos(path, h.position),
        label,
        kind,
        padding_left: h.padding_left.unwrap_or(false),
        padding_right: h.padding_right.unwrap_or(false),
        tooltip,
        parts,
    }
}

/// Decodes relative semantic token data into absolute UTF-16 quintuples.
pub fn decode_semantic_tokens(data: &[u32], enc: Encoding, text: Option<&DocText>) -> Vec<u32> {
    let mut out = Vec::with_capacity(data.len());
    let (mut line, mut start) = (0u32, 0u32);
    for &[dl, ds, len, ty, mods] in data.as_chunks::<5>().0 {
        if dl == 0 {
            start = start.saturating_add(ds);
        } else {
            line = line.saturating_add(dl);
            start = ds;
        }
        let (col, len16) = match (enc, text) {
            (Encoding::Utf16, _) | (_, None) => (start, len),
            (_, Some(t)) => {
                let (a, b) = convert_offsets(t.line(line as usize), start as usize, (start + len) as usize, enc);
                (a, b - a)
            }
        };
        out.extend_from_slice(&[line, col, len16, ty, mods]);
    }
    out
}

pub fn code_lens(conv: &Conv, path: &Path, l: lsp::CodeLens) -> CodeLens {
    CodeLens { range: conv.range(path, l.range), command: l.command.map(command) }
}

pub fn document_link(conv: &Conv, path: &Path, l: lsp::DocumentLink) -> Option<DocumentLink> {
    let target = l.target?;
    let target = target.as_str();
    let (file, url) = match uri_to_path(target) {
        Some(p) => (Some(p), None),
        None => (None, Some(target.to_owned())),
    };
    let fragment = file
        .as_ref()
        .and_then(|_| target.split_once('#'))
        .map(|(_, f)| percent_encoding::percent_decode_str(f).decode_utf8_lossy().into_owned())
        .filter(|f| !f.is_empty());
    Some(DocumentLink {
        range: conv.range(path, l.range),
        path: file.map(Into::into),
        fragment,
        url,
        tooltip: l.tooltip,
    })
}

pub fn call_item(conv: &Conv, item: &lsp::CallHierarchyItem, from_ranges: Vec<Range>) -> Option<HierarchyItem> {
    let (path, uri) = uri_target(item.uri.as_str());
    Some(HierarchyItem {
        name: item.name.clone(),
        kind: symbol_kind(item.kind),
        detail: item.detail.clone(),
        range: conv.range(&path, item.range),
        selection_range: conv.range(&path, item.selection_range),
        path: path.into(),
        uri,
        from_ranges,
    })
}

/// A `TypeHierarchyItem` from JSON; `tags` is dropped since lsp-types expects
/// a single tag where the protocol (and jdtls) sends an array.
pub fn type_item_from_json(value: &serde_json::Value) -> Option<lsp::TypeHierarchyItem> {
    let mut v = value.clone();
    if let Some(o) = v.as_object_mut() {
        o.remove("tags");
    }
    serde_json::from_value(v).ok()
}

pub fn type_item(conv: &Conv, item: &lsp::TypeHierarchyItem) -> Option<HierarchyItem> {
    let (path, uri) = uri_target(item.uri.as_str());
    Some(HierarchyItem {
        name: item.name.clone(),
        kind: symbol_kind(item.kind),
        detail: item.detail.clone(),
        range: conv.range(&path, item.range),
        selection_range: conv.range(&path, item.selection_range),
        path: path.into(),
        uri,
        from_ranges: Vec::new(),
    })
}

// ---------------------------------------------------------------- diagnostics

pub fn diagnostic(conv: &Conv, path: &Path, d: lsp::Diagnostic, server_name: &str) -> Diagnostic {
    let severity = match d.severity {
        Some(lsp::DiagnosticSeverity::WARNING) => Severity::Warning,
        Some(lsp::DiagnosticSeverity::INFORMATION) => Severity::Info,
        Some(lsp::DiagnosticSeverity::HINT) => Severity::Hint,
        _ => Severity::Error,
    };
    let tags = d.tags.unwrap_or_default();
    Diagnostic {
        range: conv.range(path, d.range),
        severity,
        message: d.message,
        source: Some(d.source.unwrap_or_else(|| server_name.to_owned())),
        code: d.code.map(|c| match c {
            lsp::NumberOrString::Number(n) => n.to_string(),
            lsp::NumberOrString::String(s) => s,
        }),
        unnecessary: tags.contains(&lsp::DiagnosticTag::UNNECESSARY),
        deprecated: tags.contains(&lsp::DiagnosticTag::DEPRECATED),
        server: Some(server_name.to_owned()),
    }
}

pub fn ranges_overlap(a: lsp::Range, b: lsp::Range) -> bool {
    let key = |p: lsp::Position| (p.line, p.character);
    key(a.start) <= key(b.end) && key(b.start) <= key(a.end)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn merged_rename_edits_keep_the_first_servers_ones() {
        let edit = |l: u32, c: u32, text: &str| TextEdit {
            range: Range::new(Pos::new(l, c), Pos::new(l, c + 5)),
            new_text: text.into(),
        };
        let file = |p: &str, edits: Vec<TextEdit>| FileEdit::Edit { path: PathBuf::from(p).into(), edits };
        // vtsls renames a shorthand property with an alias; the Angular server
        // renames it plainly and adds the template.
        let mut merged =
            WorkspaceEdit { files: vec![file("/a.ts", vec![edit(3, 2, "items: entries"), edit(9, 4, "entries")])] };
        let angular = WorkspaceEdit {
            files: vec![
                file("/a.ts", vec![edit(9, 4, "entries"), edit(3, 2, "entries"), edit(1, 14, "entries")]),
                file("/a.html", vec![edit(0, 7, "entries")]),
            ],
        };
        merge_workspace_edit(&mut merged, angular);
        assert_eq!(
            merged.files,
            [
                file("/a.ts", vec![edit(1, 14, "entries"), edit(3, 2, "items: entries"), edit(9, 4, "entries")]),
                file("/a.html", vec![edit(0, 7, "entries")]),
            ]
        );
    }

    #[test]
    fn snippet_text_takes_placeholder_defaults() {
        assert_eq!(snippet_text("foo(${1:a}, $2)$0"), "foo(a, )");
        assert_eq!(snippet_text("${1:outer ${2:inner}} \\$x ${3|one,two|}${TM_FILENAME}"), "outer inner $x one");
        assert_eq!(snippet_text("plain"), "plain");
    }

    #[test]
    fn inline_completion_shapes() {
        let conv = Conv::utf16();
        let path = Path::new("/a.rs");
        let list = inline_completion_items(&conv, path, json!([{ "insertText": "x" }]), ServerId(1));
        assert_eq!(list.len(), 1);
        assert!(inline_completion_items(&conv, path, Value::Null, ServerId(1)).is_empty());
        assert!(
            inline_completion_items(&conv, path, json!({ "items": [{ "label": "no text" }] }), ServerId(1)).is_empty()
        );
    }

    fn p(l: u32, c: u32) -> Pos {
        Pos::new(l, c)
    }

    #[test]
    fn type_hierarchy_items_accept_tag_arrays() {
        let r = json!({ "start": { "line": 2, "character": 13 }, "end": { "line": 2, "character": 16 } });
        let item = json!({
            "name": "Base", "kind": 5, "tags": [1], "uri": "file:///p/Base.java",
            "range": r, "selectionRange": r, "data": { "element": "=x" }
        });
        let parsed = type_item_from_json(&item).expect("parsed");
        assert_eq!(parsed.name, "Base");
        assert!(type_item_from_json(&json!({ "name": "x" })).is_none());
    }

    #[test]
    fn locations_keep_virtual_targets() {
        let conv = Conv::utf16();
        let jdt = "jdt://contents/a.jar/p/C.class?=x/%5C/a.jar%3Cp%28C.class";
        let range = lsp::Range::new(lsp::Position::new(1, 2), lsp::Position::new(1, 5));
        let links = lsp::GotoDefinitionResponse::Link(vec![lsp::LocationLink {
            origin_selection_range: None,
            target_uri: jdt.parse().unwrap(),
            target_range: range,
            target_selection_range: range,
        }]);
        let locs = goto_response(&conv, links);
        assert_eq!(
            locs,
            vec![Location { path: jdt.into(), range: Range::new(p(1, 2), p(1, 5)), uri: Some(jdt.into()) }]
        );

        #[cfg(unix)]
        {
            let file = conv.location(&lsp::Location::new("file:///src/a.rs".parse().unwrap(), range)).unwrap();
            assert_eq!(file, Location::file(PathBuf::from("/src/a.rs"), Range::new(p(1, 2), p(1, 5))));
        }

        let item = lsp::TypeHierarchyItem {
            name: "C".into(),
            kind: lsp::SymbolKind::CLASS,
            tags: None,
            detail: None,
            uri: jdt.parse().unwrap(),
            range,
            selection_range: range,
            data: None,
        };
        let h = type_item(&conv, &item).unwrap();
        assert_eq!((h.path.into_path_buf(), h.uri.as_deref()), (PathBuf::from(jdt), Some(jdt)));

        // Flat document symbols of a virtual document match by URI.
        let flat = lsp::DocumentSymbolResponse::Flat(vec![
            #[allow(deprecated)]
            lsp::SymbolInformation {
                name: "C".into(),
                kind: lsp::SymbolKind::CLASS,
                tags: None,
                deprecated: None,
                location: lsp::Location::new(jdt.parse().unwrap(), range),
                container_name: None,
            },
        ]);
        assert_eq!(document_symbols(&conv, Path::new(jdt), flat).len(), 1);
    }

    #[test]
    fn completion_with_defaults_and_insert_replace() {
        let (incomplete, items) = parse_completion_response(json!({
            "isIncomplete": true,
            "itemDefaults": {
                "editRange": { "insert": {"start": {"line":0,"character":4}, "end": {"line":0,"character":6}},
                               "replace": {"start": {"line":0,"character":4}, "end": {"line":0,"character":9}} },
                "insertTextFormat": 2,
                "data": {"k": 1}
            },
            "items": [
                { "label": "println!", "kind": 3, "insertText": "println!($0)", "labelDetails": {"detail": "(…)", "description": "std"} },
                { "label": "bad", "kind": "not-a-number" },
                { "label": "x", "textEdit": {"range": {"start": {"line":0,"character":0}, "end": {"line":0,"character":1}}, "newText": "xx"},
                  "insertTextFormat": 1, "tags": [1], "data": {"own": true} }
            ]
        }));
        assert!(incomplete);
        assert_eq!(items.len(), 2);
        let conv = Conv::utf16();
        let path = Path::new("/a.rs");
        let a = completion_item(&conv, path, items[0].clone(), ServerId(1));
        assert_eq!(a.insert_text, "println!($0)");
        assert!(a.is_snippet);
        assert_eq!(a.label_detail.as_deref(), Some("(…)"));
        assert_eq!(a.detail.as_deref(), Some("std"));
        assert_eq!(a.kind, Some(CompletionKind::Function));
        assert_eq!(a.replace_range, Some(Range::new(p(0, 4), p(0, 6))));
        assert_eq!(a.replace_range_tab, Some(Range::new(p(0, 4), p(0, 9))));
        assert_eq!(a.data, Some(json!({"k": 1})));
        let b = completion_item(&conv, path, items[1].clone(), ServerId(1));
        assert_eq!(b.insert_text, "xx");
        assert!(!b.is_snippet && b.deprecated);
        assert_eq!(b.replace_range_tab, None);
        assert_eq!(b.data, Some(json!({"own": true})));

        // Round trip for resolve.
        let text = DocText::new("let printl");
        let back = lsp_completion_item(&text, Encoding::Utf16, &a);
        assert_eq!(back.data, Some(json!({"k": 1})));
        assert!(matches!(back.text_edit, Some(lsp::CompletionTextEdit::InsertAndReplace(_))));
    }

    #[test]
    fn hover_normalisation() {
        let conv = Conv::utf16();
        let h: lsp::Hover = serde_json::from_value(json!({
            "contents": [ "plain *md*", { "language": "rust", "value": "fn f()" } ]
        }))
        .unwrap();
        let h = hover(&conv, Path::new("/a"), h).unwrap();
        assert_eq!(h.contents.kind, "markdown");
        assert_eq!(h.contents.value, "plain *md*\n\n```rust\nfn f()\n```");
        let empty: lsp::Hover =
            serde_json::from_value(json!({ "contents": { "kind": "markdown", "value": " " } })).unwrap();
        assert!(hover(&conv, Path::new("/a"), empty).is_none());
    }

    #[test]
    fn signature_parameters() {
        let h: lsp::SignatureHelp = serde_json::from_value(json!({
            "signatures": [
                { "label": "fn f(a: i32, b: 😀)", "parameters": [ { "label": "a: i32" }, { "label": "b: 😀" } ], "activeParameter": 1 },
                { "label": "g(x)", "parameters": [ { "label": [2, 3] } ] }
            ],
            "activeSignature": 0
        }))
        .unwrap();
        let s = signature_help(Encoding::Utf16, h).unwrap();
        assert_eq!(s.signatures[0].parameters, vec![(5, 11), (13, 18)]);
        assert_eq!(s.signatures[1].parameters, vec![(2, 3)]);
        assert_eq!(s.active_parameter, 1);
    }

    #[test]
    fn location_links_use_target_selection_range() {
        let conv = Conv::utf16();
        let r: lsp::GotoDefinitionResponse = serde_json::from_value(json!([{
            "targetUri": "file:///x/a.rs",
            "targetRange": {"start": {"line": 1, "character": 0}, "end": {"line": 5, "character": 1}},
            "targetSelectionRange": {"start": {"line": 1, "character": 3}, "end": {"line": 1, "character": 7}}
        }]))
        .unwrap();
        let locs = goto_response(&conv, r);
        assert_eq!(locs.len(), 1);
        assert_eq!(locs[0].range, Range::new(p(1, 3), p(1, 7)));
        assert_eq!(locs[0].path, PathBuf::from("/x/a.rs"));
    }

    #[test]
    fn flat_symbols_nest_by_range() {
        let conv = Conv::utf16();
        let sym = |name: &str, kind: u32, l0: u32, l1: u32| {
            json!({ "name": name, "kind": kind, "location": { "uri": "file:///a.ts",
                "range": {"start": {"line": l0, "character": 0}, "end": {"line": l1, "character": 0}} } })
        };
        let r: lsp::DocumentSymbolResponse = serde_json::from_value(json!([
            sym("m", 6, 2, 3),
            sym("C", 5, 1, 9),
            sym("f", 12, 10, 12),
            sym("n", 6, 4, 5)
        ]))
        .unwrap();
        let out = document_symbols(&conv, Path::new("/a.ts"), r);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].name, "C");
        assert_eq!(out[0].kind, SymbolKind::Class);
        assert_eq!(out[0].children.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), vec!["m", "n"]);
        assert_eq!(out[1].name, "f");
    }

    #[test]
    fn workspace_edit_document_changes() {
        let conv = Conv::utf16();
        let e: lsp::WorkspaceEdit = serde_json::from_value(json!({
            "documentChanges": [
                { "kind": "create", "uri": "file:///n.rs", "options": { "overwrite": true } },
                { "textDocument": { "uri": "file:///n.rs", "version": null },
                  "edits": [ { "range": {"start": {"line":0,"character":0}, "end": {"line":0,"character":0}}, "newText": "x" },
                             { "range": {"start": {"line":1,"character":0}, "end": {"line":1,"character":0}}, "newText": "y", "annotationId": "a" } ] },
                { "kind": "rename", "oldUri": "file:///a.rs", "newUri": "file:///b.rs" },
                { "kind": "delete", "uri": "file:///d", "options": { "recursive": true } }
            ]
        }))
        .unwrap();
        let w = workspace_edit(&conv, e);
        assert_eq!(w.files.len(), 4);
        assert_eq!(w.files[0], FileEdit::Create { path: "/n.rs".into(), overwrite: true });
        match &w.files[1] {
            FileEdit::Edit { path, edits } => {
                assert_eq!(path, Path::new("/n.rs"));
                assert_eq!(edits.len(), 2);
                assert_eq!(edits[1].new_text, "y");
            }
            other => panic!("{other:?}"),
        }
        assert_eq!(w.files[2], FileEdit::Rename { from: "/a.rs".into(), to: "/b.rs".into() });
        assert_eq!(w.files[3], FileEdit::Delete { path: "/d".into(), recursive: true });

        let e: lsp::WorkspaceEdit = serde_json::from_value(json!({ "changes": { "file:///z.rs": [
            { "range": {"start": {"line":0,"character":0}, "end": {"line":0,"character":1}}, "newText": "q" } ] } }))
        .unwrap();
        assert!(matches!(&workspace_edit(&conv, e).files[0], FileEdit::Edit { edits, .. } if edits[0].new_text == "q"));
    }

    #[test]
    fn semantic_token_decoding() {
        let data = [1, 2, 3, 0, 1, 0, 5, 2, 1, 0, 2, 0, 4, 2, 3];
        let out = decode_semantic_tokens(&data, Encoding::Utf16, None);
        assert_eq!(out, vec![1, 2, 3, 0, 1, 1, 7, 2, 1, 0, 3, 0, 4, 2, 3]);
        // UTF-8 server: "😀ab" token "ab" at byte 4 len 2 → utf16 col 2 len 2.
        let text = DocText::new("😀ab");
        assert_eq!(decode_semantic_tokens(&[0, 4, 2, 0, 0], Encoding::Utf8, Some(&text)), vec![0, 2, 2, 0, 0]);
    }

    #[test]
    fn diagnostics_mapping() {
        let conv = Conv::utf16();
        let d: lsp::Diagnostic = serde_json::from_value(json!({
            "range": {"start": {"line":0,"character":1}, "end": {"line":0,"character":2}},
            "severity": 2, "code": 42, "message": "unused", "tags": [1, 2]
        }))
        .unwrap();
        let d = diagnostic(&conv, Path::new("/a"), d, "srv");
        assert_eq!(d.severity, Severity::Warning);
        assert_eq!(d.code.as_deref(), Some("42"));
        assert_eq!(d.source.as_deref(), Some("srv"));
        assert!(d.unnecessary && d.deprecated);
    }

    #[test]
    fn utf8_conversion_uses_lookup() {
        let lookup = |_: &Path| Some(Arc::new(DocText::new("é = 1")));
        let conv = Conv::new(Encoding::Utf8, lookup);
        assert_eq!(conv.pos(Path::new("/a"), lsp::Position::new(0, 2)), p(0, 1));
    }

    #[test]
    fn inlay_label_parts_join() {
        let conv = Conv::utf16();
        let h: lsp::InlayHint = serde_json::from_value(json!({
            "position": {"line": 0, "character": 3}, "label": [{"value": ": "}, {"value": "Vec<u8>"}], "kind": 1,
            "paddingLeft": true
        }))
        .unwrap();
        let h = inlay_hint(&conv, Path::new("/a"), h);
        assert_eq!(h.label, ": Vec<u8>");
        assert_eq!(h.kind, InlayKind::Type);
        assert!(h.padding_left && !h.padding_right);
        assert_eq!(h.parts.len(), 2);
        assert!(h.parts.iter().all(|p| p.location.is_none()));
    }

    #[cfg(unix)]
    #[test]
    fn inlay_label_parts_keep_locations() {
        let conv = Conv::utf16();
        let h: lsp::InlayHint = serde_json::from_value(json!({
            "position": {"line": 0, "character": 3},
            "label": [
                {"value": ": "},
                {"value": "Foo", "tooltip": "struct Foo",
                 "location": {"uri": "file:///p/foo.rs", "range": {"start": {"line": 4, "character": 7}, "end": {"line": 4, "character": 10}}}}
            ]
        }))
        .unwrap();
        let h = inlay_hint(&conv, Path::new("/a"), h);
        assert_eq!(h.label, ": Foo");
        let part = &h.parts[1];
        assert_eq!(part.value, "Foo");
        assert_eq!(part.tooltip.as_deref(), Some("struct Foo"));
        let loc = part.location.as_ref().unwrap();
        assert_eq!(loc.path, PathBuf::from("/p/foo.rs"));
        assert_eq!(loc.range.start, p(4, 7));
        assert_eq!(h.kind, InlayKind::Other);
    }

    #[cfg(unix)]
    #[test]
    fn document_links_split_file_targets_and_urls() {
        let conv = Conv::utf16();
        let link = |target: Option<&str>| {
            serde_json::from_value::<lsp::DocumentLink>(json!({
                "range": { "start": { "line": 0, "character": 6 }, "end": { "line": 0, "character": 15 } },
                "target": target,
            }))
            .unwrap()
        };
        let here = Path::new("/p/index.html");
        let file = document_link(&conv, here, link(Some("file:///p/a%20b.md#L12"))).unwrap();
        assert_eq!(file.path.as_deref(), Some(Path::new("/p/a b.md")));
        assert_eq!(file.fragment.as_deref(), Some("L12"));
        assert_eq!(file.range, Range::new(p(0, 6), p(0, 15)));
        let web = document_link(&conv, here, link(Some("https://example.com/#top"))).unwrap();
        assert_eq!((web.path, web.url.as_deref(), web.fragment), (None, Some("https://example.com/#top"), None));
        assert!(document_link(&conv, here, link(None)).is_none());
    }
}
