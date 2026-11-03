//! Client capabilities we advertise and the server capabilities we consult.

use crate::text::Encoding;
use serde_json::{Value, json};

pub fn client_capabilities() -> Value {
    let symbol_kinds: Vec<u32> = (1..=26).collect();
    let completion_kinds: Vec<u32> = (1..=25).collect();
    json!({
        "general": {
            "positionEncodings": ["utf-16"],
            "staleRequestSupport": {
                "cancel": true,
                "retryOnContentModified": [
                    "textDocument/semanticTokens/full",
                    "textDocument/inlayHint",
                    "textDocument/codeLens"
                ]
            },
            "markdown": { "parser": "marked", "version": "1.1.0" }
        },
        "window": {
            "workDoneProgress": true,
            "showMessage": { "messageActionItem": { "additionalPropertiesSupport": false } },
            "showDocument": { "support": false }
        },
        "workspace": {
            "applyEdit": true,
            "workspaceEdit": {
                "documentChanges": true,
                "resourceOperations": ["create", "rename", "delete"],
                "failureHandling": "abort",
                "normalizesLineEndings": true,
                "changeAnnotationSupport": { "groupsOnLabel": false }
            },
            "workspaceFolders": true,
            "fileOperations": { "dynamicRegistration": true, "willRename": true, "didRename": true },
            "configuration": true,
            "didChangeConfiguration": { "dynamicRegistration": false },
            "didChangeWatchedFiles": { "dynamicRegistration": false, "relativePatternSupport": false },
            "symbol": {
                "dynamicRegistration": false,
                "symbolKind": { "valueSet": symbol_kinds },
                "tagSupport": { "valueSet": [1] },
                "resolveSupport": { "properties": ["location.range"] }
            },
            "executeCommand": { "dynamicRegistration": false },
            "semanticTokens": { "refreshSupport": true },
            "codeLens": { "refreshSupport": true },
            "inlayHint": { "refreshSupport": true },
            "diagnostics": { "refreshSupport": false },
            "textDocumentContent": { "dynamicRegistration": true }
        },
        "textDocument": {
            "synchronization": {
                "dynamicRegistration": false,
                "willSave": false,
                "willSaveWaitUntil": false,
                "didSave": true
            },
            "completion": {
                "dynamicRegistration": false,
                "contextSupport": true,
                "insertTextMode": 1,
                "completionItem": {
                    "snippetSupport": true,
                    "commitCharactersSupport": true,
                    "documentationFormat": ["markdown", "plaintext"],
                    "deprecatedSupport": true,
                    "preselectSupport": true,
                    "tagSupport": { "valueSet": [1] },
                    "insertReplaceSupport": true,
                    "resolveSupport": {
                        "properties": ["documentation", "detail", "additionalTextEdits", "command"]
                    },
                    "insertTextModeSupport": { "valueSet": [1] },
                    "labelDetailsSupport": true
                },
                "completionItemKind": { "valueSet": completion_kinds },
                "completionList": {
                    "itemDefaults": ["commitCharacters", "editRange", "insertTextFormat", "insertTextMode", "data"]
                }
            },
            "hover": { "dynamicRegistration": false, "contentFormat": ["markdown", "plaintext"] },
            "signatureHelp": {
                "dynamicRegistration": false,
                "contextSupport": true,
                "signatureInformation": {
                    "documentationFormat": ["markdown", "plaintext"],
                    "parameterInformation": { "labelOffsetSupport": true },
                    "activeParameterSupport": true
                }
            },
            "declaration": { "dynamicRegistration": false, "linkSupport": true },
            "definition": { "dynamicRegistration": false, "linkSupport": true },
            "typeDefinition": { "dynamicRegistration": false, "linkSupport": true },
            "implementation": { "dynamicRegistration": false, "linkSupport": true },
            "references": { "dynamicRegistration": false },
            "documentHighlight": { "dynamicRegistration": false },
            "documentSymbol": {
                "dynamicRegistration": false,
                "symbolKind": { "valueSet": symbol_kinds },
                "hierarchicalDocumentSymbolSupport": true,
                "tagSupport": { "valueSet": [1] },
                "labelSupport": true
            },
            "codeAction": {
                "dynamicRegistration": false,
                "codeActionLiteralSupport": {
                    "codeActionKind": {
                        "valueSet": [
                            "", "quickfix", "refactor", "refactor.extract", "refactor.inline",
                            "refactor.rewrite", "source", "source.organizeImports", "source.fixAll"
                        ]
                    }
                },
                "isPreferredSupport": true,
                "disabledSupport": true,
                "dataSupport": true,
                "resolveSupport": { "properties": ["edit", "command"] },
                "honorsChangeAnnotations": false
            },
            "codeLens": { "dynamicRegistration": false },
            "documentLink": { "dynamicRegistration": false, "tooltipSupport": true },
            "formatting": { "dynamicRegistration": false },
            "rangeFormatting": { "dynamicRegistration": false },
            "rename": {
                "dynamicRegistration": false,
                "prepareSupport": true,
                "prepareSupportDefaultBehavior": 1,
                "honorsChangeAnnotations": false
            },
            "publishDiagnostics": {
                "relatedInformation": true,
                "tagSupport": { "valueSet": [1, 2] },
                "versionSupport": true,
                "codeDescriptionSupport": true,
                "dataSupport": true
            },
            "semanticTokens": {
                "dynamicRegistration": false,
                "requests": { "range": false, "full": true },
                "tokenTypes": [
                    "namespace", "type", "class", "enum", "interface", "struct", "typeParameter",
                    "parameter", "variable", "property", "enumMember", "event", "function", "method",
                    "macro", "keyword", "modifier", "comment", "string", "number", "regexp",
                    "operator", "decorator"
                ],
                "tokenModifiers": [
                    "declaration", "definition", "readonly", "static", "deprecated", "abstract",
                    "async", "modification", "documentation", "defaultLibrary"
                ],
                "formats": ["relative"],
                "overlappingTokenSupport": false,
                "multilineTokenSupport": false,
                "serverCancelSupport": true,
                "augmentsSyntaxTokens": true
            },
            "inlayHint": { "dynamicRegistration": false },
            "inlineCompletion": { "dynamicRegistration": true },
            "callHierarchy": { "dynamicRegistration": false },
            "typeHierarchy": { "dynamicRegistration": false }
        },
        "experimental": {}
    })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SyncKind {
    None,
    Full,
    Incremental,
}

/// Parsed view of `InitializeResult.capabilities`, kept as raw JSON so unusual
/// server payloads never fail deserialization.
#[derive(Clone, Debug)]
pub struct ServerCaps {
    pub raw: Value,
    pub encoding: Encoding,
    pub open_close: bool,
    pub sync: SyncKind,
    /// `Some(include_text)` when the server wants `didSave`.
    pub save: Option<bool>,
    pub semantic_legend: Option<(Vec<String>, Vec<String>)>,
    /// Applied to what the server announces, now and in later registrations.
    pub restriction: Restriction,
}

/// LSP request method → server capability key, for features and dynamic registration.
pub fn capability_key(method: &str) -> Option<&'static str> {
    Some(match method {
        "textDocument/completion" => "completionProvider",
        "textDocument/hover" => "hoverProvider",
        "textDocument/signatureHelp" => "signatureHelpProvider",
        "textDocument/definition" => "definitionProvider",
        "textDocument/declaration" => "declarationProvider",
        "textDocument/typeDefinition" => "typeDefinitionProvider",
        "textDocument/implementation" => "implementationProvider",
        "textDocument/references" => "referencesProvider",
        "textDocument/documentHighlight" => "documentHighlightProvider",
        "textDocument/documentSymbol" => "documentSymbolProvider",
        "workspace/symbol" => "workspaceSymbolProvider",
        "textDocument/codeAction" => "codeActionProvider",
        "workspace/executeCommand" => "executeCommandProvider",
        "textDocument/rename" => "renameProvider",
        "textDocument/formatting" => "documentFormattingProvider",
        "textDocument/rangeFormatting" => "documentRangeFormattingProvider",
        "textDocument/inlayHint" => "inlayHintProvider",
        "textDocument/inlineCompletion" => "inlineCompletionProvider",
        "textDocument/semanticTokens" | "textDocument/semanticTokens/full" => "semanticTokensProvider",
        "textDocument/codeLens" => "codeLensProvider",
        "textDocument/documentLink" => "documentLinkProvider",
        "textDocument/prepareCallHierarchy" => "callHierarchyProvider",
        "textDocument/prepareTypeHierarchy" => "typeHierarchyProvider",
        _ => return None,
    })
}

/// Names for a server's `features` → the capability keys each one keeps.
pub const FEATURES: &[(&str, &[&str])] = &[
    ("completion", &["completionProvider"]),
    ("inline-completion", &["inlineCompletionProvider"]),
    ("hover", &["hoverProvider"]),
    ("signature-help", &["signatureHelpProvider"]),
    ("definition", &["definitionProvider"]),
    ("declaration", &["declarationProvider"]),
    ("type-definition", &["typeDefinitionProvider"]),
    ("implementation", &["implementationProvider"]),
    ("references", &["referencesProvider"]),
    ("document-highlight", &["documentHighlightProvider"]),
    ("document-symbol", &["documentSymbolProvider"]),
    ("workspace-symbol", &["workspaceSymbolProvider"]),
    ("code-action", &["codeActionProvider", "executeCommandProvider"]),
    ("code-lens", &["codeLensProvider", "executeCommandProvider"]),
    ("rename", &["renameProvider"]),
    (
        "formatting",
        &["documentFormattingProvider", "documentRangeFormattingProvider", "documentOnTypeFormattingProvider"],
    ),
    ("inlay-hint", &["inlayHintProvider"]),
    ("semantic-tokens", &["semanticTokensProvider"]),
    ("document-link", &["documentLinkProvider"]),
    ("call-hierarchy", &["callHierarchyProvider"]),
    ("type-hierarchy", &["typeHierarchyProvider"]),
    ("folding-range", &["foldingRangeProvider"]),
    ("selection-range", &["selectionRangeProvider"]),
    ("diagnostics", &["diagnosticProvider"]),
];

/// A server's `features` and `code-action-kinds`: the part of its capabilities
/// the IDE uses.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Restriction {
    /// Allowed `*Provider` keys; `None` allows all.
    keys: Option<Vec<&'static str>>,
    /// Code action kind prefixes kept; empty keeps all.
    action_kinds: Vec<String>,
}

impl Restriction {
    /// Unknown feature names are logged and ignored.
    pub fn new(server: &str, features: &[String], action_kinds: &[String]) -> Self {
        let keys = (!features.is_empty()).then(|| {
            let mut keys = Vec::new();
            for name in features {
                match FEATURES.iter().find(|(n, _)| n == name) {
                    Some((_, k)) => keys.extend_from_slice(k),
                    None => tracing::warn!("{server}: unknown feature `{name}` in `features`"),
                }
            }
            keys
        });
        Self { keys, action_kinds: action_kinds.to_vec() }
    }

    fn allows(&self, key: &str) -> bool {
        self.keys.as_ref().is_none_or(|k| k.contains(&key))
    }

    /// Whether the server's `publishDiagnostics` are shown.
    pub fn diagnostics(&self) -> bool {
        self.allows("diagnosticProvider")
    }

    /// Whether a code action of `kind` is kept; one without a kind only when
    /// every kind is.
    pub fn keeps_action(&self, kind: Option<&str>) -> bool {
        self.action_kinds.is_empty() || kind.is_some_and(|k| self.action_kinds.iter().any(|p| kind_within(k, p)))
    }

    /// The kinds the server can still return: those it lists that are kept,
    /// narrowed to the kept prefixes below them (`refactor` → `refactor.extract`).
    fn advertised_kinds(&self, listed: Option<Vec<String>>) -> Vec<String> {
        let Some(listed) = listed else { return self.action_kinds.clone() };
        let mut out = Vec::new();
        for k in &listed {
            let narrowed: Vec<&String> = if self.keeps_action(Some(k)) {
                vec![k]
            } else {
                self.action_kinds.iter().filter(|p| kind_within(p, k)).collect()
            };
            for k in narrowed {
                if !out.contains(k) {
                    out.push(k.clone());
                }
            }
        }
        out
    }
}

/// `kind` is `prefix` or below it (`refactor.extract` within `refactor`).
fn kind_within(kind: &str, prefix: &str) -> bool {
    kind.strip_prefix(prefix).is_some_and(|rest| rest.is_empty() || rest.starts_with('.'))
}

fn truthy(v: Option<&Value>) -> bool {
    !matches!(v, None | Some(Value::Null) | Some(Value::Bool(false)))
}

impl ServerCaps {
    pub fn parse(raw: Value) -> Self {
        let encoding = Encoding::parse(raw.get("positionEncoding").and_then(Value::as_str));
        let (open_close, sync, save) = match raw.get("textDocumentSync") {
            Some(Value::Number(n)) => (true, sync_kind(n.as_u64()), None),
            Some(Value::Object(o)) => {
                let save = match o.get("save") {
                    Some(Value::Bool(true)) => Some(false),
                    Some(Value::Object(s)) => Some(s.get("includeText").and_then(Value::as_bool).unwrap_or(false)),
                    _ => None,
                };
                let sync = sync_kind(o.get("change").and_then(Value::as_u64));
                (o.get("openClose").and_then(Value::as_bool).unwrap_or(false), sync, save)
            }
            _ => (false, SyncKind::None, None),
        };
        let semantic_legend = raw.pointer("/semanticTokensProvider/legend").map(|l| {
            let strings = |key: &str| -> Vec<String> {
                l.get(key)
                    .and_then(Value::as_array)
                    .map(|a| a.iter().filter_map(|s| s.as_str().map(str::to_owned)).collect())
                    .unwrap_or_default()
            };
            (strings("tokenTypes"), strings("tokenModifiers"))
        });
        Self { raw, encoding, open_close, sync, save, semantic_legend, restriction: Restriction::default() }
    }

    /// Drops the capabilities outside the server's `features`, and code action
    /// kinds outside its `code-action-kinds`. Document sync, workspace options
    /// and `experimental` stay.
    pub fn restrict(&mut self, restriction: Restriction) {
        if let Some(o) = self.raw.as_object_mut() {
            o.retain(|key, _| !key.ends_with("Provider") || restriction.allows(key));
        }
        if self.has("codeActionProvider") && !restriction.action_kinds.is_empty() {
            let kinds = restriction.advertised_kinds(self.code_action_kinds());
            if kinds.is_empty() {
                // It lists only kinds that aren't kept: nothing to ask it for.
                if let Some(o) = self.raw.as_object_mut() {
                    o.remove("codeActionProvider");
                }
            } else {
                if !self.raw["codeActionProvider"].is_object() {
                    self.raw["codeActionProvider"] = json!({});
                }
                self.raw["codeActionProvider"]["codeActionKinds"] = json!(kinds);
            }
        }
        if !restriction.allows("semanticTokensProvider") {
            self.semantic_legend = None;
        }
        self.restriction = restriction;
    }

    /// Whether the server statically advertises the capability under `key`.
    pub fn has(&self, key: &str) -> bool {
        truthy(self.raw.get(key))
    }

    /// `provider.sub == true`, e.g. `completionProvider.resolveProvider`.
    pub fn has_sub(&self, key: &str, sub: &str) -> bool {
        self.raw.get(key).and_then(|v| v.get(sub)).and_then(Value::as_bool).unwrap_or(false)
    }

    pub fn semantic_tokens_full(&self) -> bool {
        match self.raw.get("semanticTokensProvider") {
            Some(Value::Object(o)) => truthy(o.get("full")),
            _ => false,
        }
    }

    pub fn completion_triggers(&self) -> Vec<String> {
        self.raw
            .pointer("/completionProvider/triggerCharacters")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(|s| s.as_str().map(str::to_owned)).collect())
            .unwrap_or_default()
    }

    /// `codeActionProvider.codeActionKinds`; `None` when the server does not list them.
    pub fn code_action_kinds(&self) -> Option<Vec<String>> {
        self.raw
            .pointer("/codeActionProvider/codeActionKinds")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(|s| s.as_str().map(str::to_owned)).collect())
    }

    pub fn commands(&self) -> Vec<String> {
        self.raw
            .pointer("/executeCommandProvider/commands")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(|s| s.as_str().map(str::to_owned)).collect())
            .unwrap_or_default()
    }

    /// URI schemes served by `workspace/textDocumentContent` (LSP 3.18).
    pub fn content_schemes(&self) -> Vec<String> {
        self.raw
            .pointer("/workspace/textDocumentContent/schemes")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(|s| s.as_str().map(str::to_owned)).collect())
            .unwrap_or_default()
    }

    /// `workspace.fileOperations.<op>` registration options (`op`: `willRename`, `didRename`).
    pub fn file_operation(&self, op: &str) -> Option<&Value> {
        self.raw.pointer(&format!("/workspace/fileOperations/{op}")).filter(|v| v.is_object())
    }

    /// Applies a `client/registerCapability` registration (best effort).
    pub fn register(&mut self, method: &str, options: Option<&Value>) {
        if let Some(op) = file_operation_key(method)
            && let Some(opts) = options
        {
            if !self.raw.get("workspace").is_some_and(Value::is_object) {
                self.raw["workspace"] = json!({});
            }
            if !self.raw["workspace"].get("fileOperations").is_some_and(Value::is_object) {
                self.raw["workspace"]["fileOperations"] = json!({});
            }
            self.raw["workspace"]["fileOperations"][op] = opts.clone();
            return;
        }
        if method == "workspace/textDocumentContent"
            && let Some(opts) = options
        {
            if !self.raw.get("workspace").is_some_and(Value::is_object) {
                self.raw["workspace"] = json!({});
            }
            self.raw["workspace"]["textDocumentContent"] = opts.clone();
            return;
        }
        if let Some(key) = capability_key(method)
            && !self.restriction.allows(key)
        {
            return;
        }
        if method == "textDocument/semanticTokens"
            && let Some(opts) = options
        {
            self.raw["semanticTokensProvider"] = opts.clone();
            let restriction = std::mem::take(&mut self.restriction);
            *self = Self::parse(std::mem::take(&mut self.raw));
            self.restriction = restriction;
            return;
        }
        if method == "textDocument/didSave" {
            let include = options.and_then(|o| o.get("includeText")).and_then(Value::as_bool).unwrap_or(false);
            self.save = Some(include);
            return;
        }
        if method == "textDocument/didChange" {
            self.sync = sync_kind(options.and_then(|o| o.get("syncKind")).and_then(Value::as_u64));
            return;
        }
        if method == "textDocument/didOpen" || method == "textDocument/didClose" {
            self.open_close = true;
            return;
        }
        if let Some(key) = capability_key(method)
            && !self.has(key)
        {
            self.raw[key] = options.cloned().filter(|o| o.is_object()).unwrap_or(Value::Bool(true));
            if key == "codeActionProvider" {
                // Registered kinds go through the same narrowing as announced ones.
                let restriction = std::mem::take(&mut self.restriction);
                self.restrict(restriction);
            }
        }
    }

    pub fn unregister(&mut self, method: &str) {
        if let Some(op) = file_operation_key(method) {
            if let Some(ops) = self.raw.pointer_mut("/workspace/fileOperations").and_then(Value::as_object_mut) {
                ops.remove(op);
            }
            return;
        }
        if let Some(key) = capability_key(method)
            && let Some(o) = self.raw.as_object_mut()
        {
            o.remove(key);
        }
    }
}

fn file_operation_key(method: &str) -> Option<&'static str> {
    match method {
        "workspace/willRenameFiles" => Some("willRename"),
        "workspace/didRenameFiles" => Some("didRename"),
        _ => None,
    }
}

fn sync_kind(n: Option<u64>) -> SyncKind {
    match n {
        Some(1) => SyncKind::Full,
        Some(2) => SyncKind::Incremental,
        _ => SyncKind::None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_sync_and_features() {
        let c = ServerCaps::parse(json!({
            "positionEncoding": "utf-8",
            "textDocumentSync": { "openClose": true, "change": 2, "save": { "includeText": true } },
            "completionProvider": { "resolveProvider": true, "triggerCharacters": [".", ":"] },
            "hoverProvider": true,
            "definitionProvider": false,
            "semanticTokensProvider": { "legend": { "tokenTypes": ["a"], "tokenModifiers": ["m"] }, "full": { "delta": true } }
        }));
        assert_eq!(c.encoding, Encoding::Utf8);
        assert_eq!(c.sync, SyncKind::Incremental);
        assert!(c.open_close);
        assert_eq!(c.save, Some(true));
        assert!(c.has("hoverProvider") && !c.has("definitionProvider") && !c.has("renameProvider"));
        assert!(c.has_sub("completionProvider", "resolveProvider"));
        assert_eq!(c.completion_triggers(), vec![".", ":"]);
        assert!(c.semantic_tokens_full());
        assert_eq!(c.semantic_legend, Some((vec!["a".into()], vec!["m".into()])));

        let c = ServerCaps::parse(json!({ "textDocumentSync": 1 }));
        assert_eq!((c.sync, c.open_close, c.save), (SyncKind::Full, true, None));
    }

    #[test]
    fn dynamic_registration() {
        let mut c = ServerCaps::parse(json!({}));
        c.register("textDocument/formatting", None);
        assert!(c.has("documentFormattingProvider"));
        c.unregister("textDocument/formatting");
        assert!(!c.has("documentFormattingProvider"));
        c.register("textDocument/didChange", Some(&json!({ "syncKind": 2 })));
        assert_eq!(c.sync, SyncKind::Incremental);
        assert!(c.file_operation("willRename").is_none());
        c.register("workspace/willRenameFiles", Some(&json!({ "filters": [] })));
        assert!(c.file_operation("willRename").is_some());
        c.unregister("workspace/willRenameFiles");
        assert!(c.file_operation("willRename").is_none());
    }

    fn restriction(features: &[&str], kinds: &[&str]) -> Restriction {
        let owned = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        Restriction::new("test", &owned(features), &owned(kinds))
    }

    #[test]
    fn features_drop_other_capabilities() {
        let mut c = ServerCaps::parse(json!({
            "textDocumentSync": 2,
            "completionProvider": {},
            "hoverProvider": true,
            "documentFormattingProvider": true,
            "foldingRangeProvider": true,
            "codeActionProvider": { "resolveProvider": true },
            "executeCommandProvider": { "commands": ["rope.extract"] },
            "semanticTokensProvider": { "legend": { "tokenTypes": [], "tokenModifiers": [] }, "full": true },
            "workspace": { "fileOperations": { "willRename": { "filters": [] } } },
            "experimental": { "x": true }
        }));
        c.restrict(restriction(&["code-action", "nope"], &[]));
        assert!(c.has("codeActionProvider") && c.has_sub("codeActionProvider", "resolveProvider"));
        assert_eq!(c.commands(), ["rope.extract"]);
        for key in ["completionProvider", "hoverProvider", "documentFormattingProvider", "foldingRangeProvider"] {
            assert!(!c.has(key), "{key}");
        }
        assert!(c.semantic_legend.is_none() && !c.semantic_tokens_full());
        assert_eq!((c.sync, c.open_close), (SyncKind::Incremental, true));
        assert!(c.file_operation("willRename").is_some() && c.raw["experimental"]["x"] == true);
        assert!(!c.restriction.diagnostics());
        assert_eq!(c.code_action_kinds(), None, "no kind filter: the server may return any kind");

        // Later registrations go through the same filter.
        c.register("textDocument/hover", None);
        c.register("textDocument/semanticTokens", Some(&json!({ "legend": {}, "full": true })));
        assert!(!c.has("hoverProvider") && !c.has("semanticTokensProvider"));
        c.register("textDocument/didSave", None);
        assert_eq!(c.save, Some(false));

        let mut c = ServerCaps::parse(json!({ "hoverProvider": true, "semanticTokensProvider": { "full": true } }));
        c.restrict(Restriction::default());
        assert!(c.has("hoverProvider") && c.restriction.diagnostics(), "no `features`: everything");
        c.restrict(restriction(&["semantic-tokens", "diagnostics"], &[]));
        c.register("textDocument/semanticTokens", Some(&json!({ "legend": {}, "full": true })));
        assert!(!c.has("hoverProvider") && c.semantic_tokens_full() && c.restriction.diagnostics());
        c.register("textDocument/hover", None);
        assert!(!c.has("hoverProvider"), "the restriction survives re-parsing semantic tokens");
    }

    #[test]
    fn code_action_kinds_narrow_what_is_asked_and_kept() {
        let r = restriction(&[], &["refactor", "source.fixAll"]);
        assert!(r.keeps_action(Some("refactor")) && r.keeps_action(Some("refactor.extract.function")));
        assert!(r.keeps_action(Some("source.fixAll.ruff")));
        assert!(!r.keeps_action(Some("refactorx")) && !r.keeps_action(Some("source")) && !r.keeps_action(None));
        assert!(Restriction::default().keeps_action(None));

        let kinds = |provider: Value| {
            let mut c = ServerCaps::parse(json!({ "codeActionProvider": provider }));
            c.restrict(r.clone());
            c.has("codeActionProvider").then(|| c.code_action_kinds().unwrap())
        };
        assert_eq!(kinds(json!(true)), Some(vec!["refactor".into(), "source.fixAll".into()]));
        assert_eq!(
            kinds(json!({ "codeActionKinds": ["quickfix", "refactor.extract", "source"] })),
            Some(vec!["refactor.extract".into(), "source.fixAll".into()]),
        );
        assert_eq!(kinds(json!({ "codeActionKinds": ["quickfix"] })), None, "nothing it lists is kept");

        let mut c = ServerCaps::parse(json!({}));
        c.restrict(r.clone());
        c.register("textDocument/codeAction", Some(&json!({ "codeActionKinds": ["quickfix", "refactor.inline"] })));
        assert_eq!(c.code_action_kinds(), Some(vec!["refactor.inline".into()]));
    }

    #[test]
    fn language_definitions_use_known_feature_names() {
        for lang in ide_language::LanguageRegistry::load(None).unwrap().all() {
            for server in &lang.language_servers {
                for name in &server.features {
                    assert!(FEATURES.iter().any(|(n, _)| n == name), "{}: unknown feature `{name}`", server.name);
                }
            }
        }
    }

    #[test]
    fn feature_names_cover_every_capability_the_ide_asks_for() {
        let named: Vec<&str> = FEATURES.iter().flat_map(|(_, keys)| keys.iter().copied()).collect();
        for method in [
            "textDocument/completion",
            "textDocument/hover",
            "textDocument/signatureHelp",
            "textDocument/definition",
            "textDocument/declaration",
            "textDocument/typeDefinition",
            "textDocument/implementation",
            "textDocument/references",
            "textDocument/documentHighlight",
            "textDocument/documentSymbol",
            "workspace/symbol",
            "textDocument/codeAction",
            "workspace/executeCommand",
            "textDocument/rename",
            "textDocument/formatting",
            "textDocument/rangeFormatting",
            "textDocument/inlayHint",
            "textDocument/inlineCompletion",
            "textDocument/semanticTokens",
            "textDocument/codeLens",
            "textDocument/documentLink",
            "textDocument/prepareCallHierarchy",
            "textDocument/prepareTypeHierarchy",
        ] {
            let key = capability_key(method).unwrap();
            assert!(named.contains(&key), "{method} ({key}) has no feature name");
        }
    }
}
