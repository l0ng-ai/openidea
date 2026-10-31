// Ported from JetBrains intellij-community plugins/mcp-server (mcpserver.toolsets/src/general/CallHierarchyAnalysisSupport.kt, AnalysisToolset.kt), Apache-2.0.
//! `analyze_calls`: the Call Hierarchy tree of a callable, as text.
//!
//! IntelliJ resolves `symbolFqn` with its qualified-name providers and Go to Symbol and
//! walks its call hierarchy tree structure. Here the symbol index (then the language
//! servers' workspace symbols) resolves the name, and the language server's call
//! hierarchy gives each level. Signatures are `module.Container.name(params)`: the
//! module is the file's project-relative path without extension, dotted, and the
//! parameters are the declaration's as written, so they round-trip as `symbolFqn` and as
//! `treePath` components.

use super::{Docs, INDEXING_PARTIAL_RESULT_REASON, TIMEOUT_DESCRIPTION, blocking, indexing, is_word, name_position};
use crate::tool::{Call, Output, Param, ParamType, Tool};
use futures::future::BoxFuture;
use ide_core::mcp::McpToolKind;
use ide_core::{IdeError, IdeResult, Pos, Range, SymbolKind};
use ide_lsp::types::{HierarchyDirection, HierarchyItem};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

/// JetBrains' `Constants.MEDIUM_TIMEOUT_MILLISECONDS_VALUE`.
const DEFAULT_TIMEOUT_MS: u64 = 10_000;
/// JetBrains' `SYMBOL_SEARCH_LIMIT`.
const SYMBOL_SEARCH_LIMIT: usize = 500;
/// Longest parameter list kept in a signature.
const MAX_PARAMS_CHARS: usize = 300;

const SYMBOL_FQN: &str = "symbolFqn";
const TREE_PATH: &str = "treePath";
const CHILD_OFFSET: &str = "childOffset";

pub(super) fn analyze_calls() -> Tool {
    Tool::new(
        "analyze_calls",
        McpToolKind::Read,
        "Builds the IDE Call Hierarchy tree for a method, function, constructor, or supported type target.
Use it to see who calls a symbol (`INCOMING_CALLS`) or what the symbol calls (`OUTGOING_CALLS`).
Strongly prefer this tool over usage search, text search, or regex search when evaluating dependencies by actual calls.
It uses the language server's call hierarchy, so it provides more precise call relationships with less noise and fewer \
follow-up calls than primitive searches.

Pass `symbolFqn` as a qualified name, for example `com.example.Service.run`, `crate::net::connect` or \
`src/util.format`: the name qualified by package / module / file path / class as far as needed.
If the name is ambiguous, the tool returns exact signatures; pass one of them back as `symbolFqn`.
If you only know a short name or fragment, use `search_symbol` first to find the target.

The result is an expandable text tree. Each node includes `filePath` and `treePath`; `filePath` is project-relative when \
possible.
Pass `treePath` back to render the subtree.
Use `childOffset` to continue after a truncated `… and n more` line.
`depth`, `maxChildren`, and `maxNodes` bound the rendered tree.
Calls into libraries are listed when the language server reports them; they are not expanded further.",
        |call| async move {
            let request = Request::parse(&call)?;
            let project = call.project().clone();
            let indexing_before = indexing(&project);
            let budget = Duration::from_millis(request.timeout_ms);
            let analyzer = Analyzer::new(&call, &request);
            let text = match tokio::time::timeout(budget, analyzer.analyze()).await {
                Ok(text) => text?,
                Err(_) => format!("Timed out while analyzing calls for `{}`.", request.symbol_fqn),
            };
            if indexing_before || indexing(&project) {
                return Ok(Output::text(format!("> Note: {INDEXING_PARTIAL_RESULT_REASON}\n\n{text}")));
            }
            Ok(Output::text(text))
        },
    )
    .param(Param::required(
        SYMBOL_FQN,
        ParamType::String,
        "Plain qualified symbol name, or an exact signature returned by an ambiguity error or copied from a rendered \
child node. If you only know a short name or fragment, use `search_symbol` first and pass the best qualified callable \
name here. Examples: `com.example.Service.run`, `com.example.Service.run(String)`, `crate::net::connect`. Do not pass \
file path, line, column, or a separate target signature.",
    ))
    .param(Param::required(
        "analysisKind",
        ParamType::Enum(&["INCOMING_CALLS", "OUTGOING_CALLS"]),
        "Call analysis direction. Use `INCOMING_CALLS` to show callers of `symbolFqn`, or `OUTGOING_CALLS` to show \
symbols called from `symbolFqn`.",
    ))
    .param(Param::optional(
        "depth",
        ParamType::Integer,
        "Maximum number of call levels to render below the requested subtree root. Default: 5. Use 0 to render only \
the subtree root.",
    ))
    .param(Param::optional(
        "maxChildren",
        ParamType::Integer,
        "Maximum number of direct children rendered for each node. Default: 50.",
    ))
    .param(Param::optional("maxNodes", ParamType::Integer, "Maximum total number of rendered call nodes. Default: 1000."))
    .param(Param::optional(
        TREE_PATH,
        ParamType::StringList,
        "Optional path to a subtree root, copied exactly from a previous `analyze_calls` result. Null or omitted means \
the root path `[]`. Each component is an exact signature, not a display name.",
    ))
    .param(Param::optional(
        CHILD_OFFSET,
        ParamType::Integer,
        "Offset for paging direct children of the node addressed by `treePath`. Default: 0.",
    ))
    .param(Param::optional("timeout", ParamType::Integer, TIMEOUT_DESCRIPTION))
}

struct Request {
    symbol_fqn: String,
    direction: HierarchyDirection,
    depth: usize,
    max_children: usize,
    max_nodes: usize,
    tree_path: Vec<String>,
    child_offset: usize,
    timeout_ms: u64,
}

impl Request {
    fn parse(call: &Call) -> IdeResult<Self> {
        let int = |name: &str, default: i64| -> IdeResult<i64> { Ok(call.opt_i64(name)?.unwrap_or(default)) };
        let non_negative = |name: &str, default: i64| -> IdeResult<usize> {
            match int(name, default)? {
                v if v < 0 => Err(IdeError::invalid(format!("{name} must not be negative"))),
                v => Ok(v as usize),
            }
        };
        let positive = |name: &str, default: i64| -> IdeResult<usize> {
            match int(name, default)? {
                v if v <= 0 => Err(IdeError::invalid(format!("{name} must be positive"))),
                v => Ok(v as usize),
            }
        };
        let direction = match call.str("analysisKind")?.trim().to_ascii_uppercase().as_str() {
            "INCOMING_CALLS" => HierarchyDirection::Incoming,
            "OUTGOING_CALLS" => HierarchyDirection::Outgoing,
            other => {
                return Err(IdeError::invalid(format!(
                    "analysisKind must be one of: INCOMING_CALLS, OUTGOING_CALLS (got `{other}`)"
                )));
            }
        };
        let request = Self {
            symbol_fqn: call.str(SYMBOL_FQN)?.trim().to_owned(),
            direction,
            depth: non_negative("depth", 5)?,
            max_children: positive("maxChildren", 50)?,
            max_nodes: positive("maxNodes", 1000)?,
            tree_path: call.str_list(TREE_PATH)?,
            child_offset: non_negative(CHILD_OFFSET, 0)?,
            timeout_ms: super::timeout_ms(call, DEFAULT_TIMEOUT_MS)?,
        };
        if request.symbol_fqn.is_empty() {
            return Err(IdeError::invalid(format!("{SYMBOL_FQN} must not be blank")));
        }
        Ok(request)
    }
}

// --- signatures ------------------------------------------------------------------

/// `text` from the end of `name` on: its value parameters `(...)` (generic parameters
/// skipped), whitespace collapsed (JetBrains' `valueParameters`).
fn value_parameters(text: &str, name: &str) -> Option<String> {
    let mut search = 0;
    while let Some(i) = text[search..].find(name) {
        let at = search + i;
        let before_ok = !text[..at].chars().next_back().is_some_and(is_word);
        let rest = &text[at + name.len()..];
        if before_ok && !rest.chars().next().is_some_and(is_word) {
            let mut rest = rest.trim_start();
            if rest.starts_with('<') {
                rest = rest[balanced(rest, '<', '>')?..].trim_start();
            }
            if rest.starts_with('(') {
                let end = balanced(rest, '(', ')')?;
                let params = collapse_whitespace(&rest[..end]);
                return (params.chars().count() <= MAX_PARAMS_CHARS).then_some(params);
            }
        }
        search = at + name.len();
    }
    None
}

/// The byte length of the balanced `open … close` group `s` starts with.
fn balanced(s: &str, open: char, close: char) -> Option<usize> {
    let mut depth = 0i32;
    for (i, c) in s.char_indices() {
        if c == open {
            depth += 1;
        } else if c == close {
            depth -= 1;
            if depth == 0 {
                return Some(i + c.len_utf8());
            }
        }
    }
    None
}

fn collapse_whitespace(s: &str) -> String {
    let s = s.split_whitespace().collect::<Vec<_>>().join(" ");
    s.replace("( ", "(").replace(" )", ")")
}

/// `name(params)` → `(name, Some(params))`.
fn split_parameters(fqn: &str) -> (&str, Option<&str>) {
    match fqn.find('(') {
        Some(i) => (fqn[..i].trim_end(), Some(&fqn[i..])),
        None => (fqn, None),
    }
}

/// `a::b.C#m` → `[a, b, C, m]`.
fn split_fqn(fqn: &str) -> Vec<String> {
    fqn.split(['.', '#', '/', '\\', ':']).map(str::trim).filter(|p| !p.is_empty()).map(str::to_owned).collect()
}

/// Whether parameters someone wrote (`(String)`) describe the declared ones (`(String s)`).
fn parameters_match(requested: &str, declared: &str) -> bool {
    let list = |s: &str| -> Vec<String> {
        let inner = s.trim().trim_start_matches('(').trim_end_matches(')');
        let mut out = Vec::new();
        let (mut depth, mut current) = (0i32, String::new());
        for c in inner.chars() {
            match c {
                '(' | '<' | '[' | '{' => depth += 1,
                ')' | '>' | ']' | '}' => depth -= 1,
                ',' if depth == 0 => {
                    out.push(std::mem::take(&mut current));
                    continue;
                }
                _ => {}
            }
            current.push(c);
        }
        out.push(current);
        out.into_iter().map(|p| collapse_whitespace(&p)).filter(|p| !p.is_empty()).collect()
    };
    let (requested, declared) = (list(requested), list(declared));
    requested.len() == declared.len()
        && requested.iter().zip(&declared).all(|(r, d)| {
            let squash = |s: &str| s.chars().filter(|c| !c.is_whitespace()).collect::<String>();
            let (r, d) = (squash(r), squash(d));
            // `String` for `String s` (Java), `s: str` or `str` for `s: str` (Rust, TS, Python).
            r == d || d.starts_with(&r) || d.ends_with(&r) || d.ends_with(&format!(":{r}"))
        })
}

/// The dotted module of a project-relative file: `src/net/client.rs` → `[src, net, client]`.
fn module_segments(rel: &str) -> Vec<String> {
    let (dir, file) = rel.rsplit_once('/').unwrap_or(("", rel));
    let stem = file.split_once('.').map_or(file, |(stem, _)| stem);
    let mut out = split_fqn(dir);
    if !stem.is_empty() {
        out.push(stem.to_owned());
    }
    out
}

/// A rendered (or resolved) callable.
#[derive(Clone)]
struct Symbol {
    name: String,
    /// Shown in the tree: the name and its parameters.
    display: String,
    signature: String,
    file_path: Option<String>,
    path: PathBuf,
    /// Library code only a language server can show (`jdt://…`); never expanded.
    uri: Option<String>,
    /// Where call hierarchy is asked for this symbol.
    pos: Pos,
}

fn signature(module: &[String], container: Option<&str>, name: &str, params: Option<&str>) -> String {
    let mut segments: Vec<String> = module.to_vec();
    for s in container.map(split_fqn).unwrap_or_default() {
        // `CallGraph.java` holding class `CallGraph`: `calls.CallGraph.run`, not `calls.CallGraph.CallGraph.run`.
        if segments.last() != Some(&s) {
            segments.push(s);
        }
    }
    segments.push(name.to_owned());
    format!("{}{}", segments.join("."), params.unwrap_or(""))
}

// --- resolving symbolFqn ---------------------------------------------------------

/// A declaration `symbolFqn` may mean.
struct Candidate {
    name: String,
    kind: SymbolKind,
    container: Option<String>,
    path: PathBuf,
    rel: String,
    range: Range,
}

impl Candidate {
    fn segments(&self) -> Vec<String> {
        let mut out = module_segments(&self.rel);
        out.extend(self.container.as_deref().map(split_fqn).unwrap_or_default());
        out
    }

    fn callable(&self) -> bool {
        matches!(self.kind, SymbolKind::Function | SymbolKind::Method | SymbolKind::Constructor)
    }

    fn type_like(&self) -> bool {
        matches!(self.kind, SymbolKind::Class | SymbolKind::Struct | SymbolKind::Enum | SymbolKind::Interface)
    }
}

/// Whether `qualifiers` appear in `segments` in order.
fn subsequence(qualifiers: &[String], segments: &[String]) -> bool {
    let mut it = segments.iter();
    qualifiers.iter().all(|q| it.any(|s| s == q))
}

/// Narrows symbols named like the last segment to those `qualifiers` describe, callables
/// first (types only when no callable matches: the server may map them to a constructor).
fn narrow(mut found: Vec<Candidate>, qualifiers: &[String]) -> Vec<Candidate> {
    found.retain(|c| subsequence(qualifiers, &c.segments()));
    let container_is =
        |c: &Candidate, last: &String| c.container.as_deref().and_then(|k| split_fqn(k).pop()).as_ref() == Some(last);
    if let Some(last) = qualifiers.last()
        && found.iter().any(|c| container_is(c, last))
    {
        found.retain(|c| container_is(c, last));
    }
    if found.iter().any(Candidate::callable) {
        found.retain(Candidate::callable);
    } else {
        found.retain(Candidate::type_like);
    }
    found
}

// --- the analyzer ----------------------------------------------------------------

#[derive(Clone)]
struct CallNode {
    symbol: Symbol,
    usages: usize,
}

struct Analyzer<'a> {
    call: &'a Call,
    request: &'a Request,
    docs: Docs,
    /// Children by `signature@path:line:col`.
    children: HashMap<String, Arc<Vec<CallNode>>>,
    texts: HashMap<PathBuf, Option<Arc<String>>>,
    rendered: usize,
}

impl<'a> Analyzer<'a> {
    fn new(call: &'a Call, request: &'a Request) -> Self {
        Self {
            call,
            request,
            docs: Docs::new(call.project().clone()),
            children: HashMap::new(),
            texts: HashMap::new(),
            rendered: 0,
        }
    }

    async fn analyze(mut self) -> IdeResult<String> {
        let root = self.resolve_target().await?;
        let served = {
            let (project, path) = (self.call.project().clone(), root.path.clone());
            blocking(move || Ok(project.documents.by_path(&path).is_some() || project.lsp.serves_path(&path))).await?
        };
        if !served {
            return Err(IdeError::unavailable(format!(
                "No installed language server serves {}; call hierarchy needs one.",
                root.file_path.as_deref().unwrap_or_default()
            )));
        }
        let root = CallNode { symbol: root, usages: 1 };
        let mut current = root.clone();
        let mut ancestors = vec![root.symbol.signature.clone()];
        let mut consumed: Vec<String> = Vec::new();
        for component in &self.request.tree_path {
            let children = self.children_of(&current, consumed.is_empty()).await?;
            let Some(next) = children.iter().find(|c| c.symbol.signature == *component) else {
                return Err(IdeError::not_found(format!(
                    "{TREE_PATH} component not found under {}. Copy {TREE_PATH} values exactly from a previous \
analyze_calls result.",
                    format_tree_path(&consumed)
                )));
            };
            consumed.push(component.clone());
            ancestors.push(next.symbol.signature.clone());
            current = next.clone();
        }
        let mut out = String::new();
        let tree_path = self.request.tree_path.clone();
        let (depth, offset) = (self.request.depth, self.request.child_offset);
        self.render(&current, tree_path, ancestors, String::new(), true, depth, offset, &mut out).await?;
        Ok(out.trim_end().to_owned())
    }

    /// JetBrains' `resolveTargetSymbol`, on the symbol index (then workspace symbols).
    async fn resolve_target(&mut self) -> IdeResult<Symbol> {
        let fqn = self.request.symbol_fqn.clone();
        let (name_part, params) = split_parameters(&fqn);
        let mut segments = split_fqn(name_part);
        let Some(name) = segments.pop() else {
            return Err(no_callable(&fqn));
        };
        // Rust paths start at the crate, not at a directory.
        let qualifiers: Vec<String> =
            segments.into_iter().filter(|s| !matches!(s.as_str(), "crate" | "self" | "super")).collect();
        let project = self.call.project().clone();
        let from_index: Vec<Candidate> = project
            .index
            .symbols_named(&name, None, SYMBOL_SEARCH_LIMIT)
            .into_iter()
            .map(|m| Candidate {
                name: m.name,
                kind: m.kind,
                container: m.container,
                path: m.path.to_path_buf(),
                rel: m.rel_path,
                range: m.range,
            })
            .collect();
        let mut found = narrow(from_index, &qualifiers);
        // Symbols the tree-sitter index does not know (macros, generated code): ask the running servers.
        if found.is_empty() && !project.lsp.servers().is_empty() {
            let symbols = project.lsp.workspace_symbols(&name, self.call.cancel.clone()).await.unwrap_or_default();
            let from_lsp = symbols
                .into_iter()
                .filter(|s| s.name == name && s.location.uri.is_none())
                .map(|s| Candidate {
                    rel: self.call.display(&s.location.path),
                    name: s.name,
                    kind: s.kind,
                    container: s.container,
                    path: s.location.path.to_path_buf(),
                    range: s.location.range,
                })
                .collect();
            found = narrow(from_lsp, &qualifiers);
        }
        let mut symbols: Vec<(Symbol, Option<String>)> = Vec::new();
        for c in found {
            let text = self.text(&c.path).await;
            let pos = text.as_deref().map_or(c.range.start, |t| name_position(t, &c.name, c.range));
            let declared = text.as_deref().and_then(|t| declared_parameters(t, &c.name, pos));
            if let Some(requested) = params
                && !declared.as_deref().is_some_and(|d| parameters_match(requested, d))
            {
                continue;
            }
            let sig = signature(&module_segments(&c.rel), c.container.as_deref(), &c.name, declared.as_deref());
            if symbols.iter().any(|(s, _)| s.signature == sig) {
                continue;
            }
            let display = format!("{}{}", c.name, declared.as_deref().unwrap_or(""));
            let detail = format!(
                "{:?}{}, {}:{}",
                c.kind,
                c.container.as_deref().map(|k| format!(" in {k}")).unwrap_or_default(),
                c.rel,
                pos.line + 1
            );
            let symbol =
                Symbol { name: c.name, display, signature: sig, file_path: Some(c.rel), path: c.path, uri: None, pos };
            symbols.push((symbol, Some(detail)));
        }
        // An exact signature wins over the declarations it is a prefix of.
        if symbols.len() > 1
            && let Some(i) = symbols.iter().position(|(s, _)| s.signature == fqn)
        {
            return Ok(symbols.swap_remove(i).0);
        }
        match symbols.len() {
            0 => Err(no_callable(&fqn)),
            1 => Ok(symbols.pop().expect("one").0),
            _ => {
                let rendered: Vec<String> = symbols
                    .iter()
                    .map(|(s, detail)| {
                        let display = match detail {
                            Some(d) => format!("{} ({d})", s.display),
                            None => s.display.clone(),
                        };
                        format!("- {display}\n  {SYMBOL_FQN}: {}", s.signature)
                    })
                    .collect();
                Err(IdeError::invalid(format!(
                    "Ambiguous {SYMBOL_FQN} `{fqn}`. Pass one exact signature as `{SYMBOL_FQN}`:\n{}",
                    rendered.join("\n")
                )))
            }
        }
    }

    async fn text(&mut self, path: &Path) -> Option<Arc<String>> {
        if let Some(t) = self.texts.get(path) {
            return t.clone();
        }
        let (project, p) = (self.call.project().clone(), path.to_path_buf());
        let text = blocking(move || Ok(project.text_of(&p).ok())).await.ok().flatten();
        let text = text.map(|t| Arc::new(t.replace("\r\n", "\n")));
        self.texts.insert(path.to_path_buf(), text.clone());
        text
    }

    /// The node for one call hierarchy item: qualified by the index symbol declared there.
    async fn symbol_of(&mut self, item: &HierarchyItem) -> Symbol {
        let params_from_detail = item.detail.as_deref().and_then(|d| value_parameters(d, &item.name));
        if let Some(uri) = &item.uri {
            let module = uri.rsplit(['/', '\\']).next().map(module_segments).unwrap_or_default();
            let params = params_from_detail;
            return Symbol {
                name: item.name.clone(),
                display: format!("{}{}", item.name, params.as_deref().unwrap_or("")),
                signature: signature(&module, None, &item.name, params.as_deref()),
                file_path: Some(uri.clone()),
                path: item.path.to_path_buf(),
                uri: Some(uri.clone()),
                pos: item.selection_range.start,
            };
        }
        let path = item.path.to_path_buf();
        let rel = self.call.display(&path);
        let pos = item.selection_range.start;
        let container = self
            .call
            .project()
            .index
            .symbols_named(&item.name, None, SYMBOL_SEARCH_LIMIT)
            .into_iter()
            .filter(|m| *m.path == *path)
            .min_by_key(|m| m.range.start.line.abs_diff(pos.line))
            .and_then(|m| m.container);
        let params = match params_from_detail {
            Some(p) => Some(p),
            None => self.text(&path).await.and_then(|t| declared_parameters(&t, &item.name, pos)),
        };
        Symbol {
            name: item.name.clone(),
            display: format!("{}{}", item.name, params.as_deref().unwrap_or("")),
            signature: signature(&module_segments(&rel), container.as_deref(), &item.name, params.as_deref()),
            file_path: Some(rel),
            path,
            uri: None,
            pos,
        }
    }

    /// One level of calls, merged by signature (usages summed) and sorted by display name.
    async fn children_of(&mut self, node: &CallNode, root: bool) -> IdeResult<Arc<Vec<CallNode>>> {
        let s = &node.symbol;
        let key = format!("{}@{}:{}:{}", s.signature, s.path.display(), s.pos.line, s.pos.col);
        if let Some(c) = self.children.get(&key) {
            return Ok(c.clone());
        }
        let items = if s.uri.is_some() {
            Vec::new()
        } else {
            match self.calls(&s.path, s.pos, root).await {
                Ok(items) => items,
                Err(e) if root || e.kind == ide_core::error::ErrorKind::Cancelled => {
                    return Err(IdeError::new(e.kind, format!("call hierarchy of {}: {}", s.name, e.message)));
                }
                // A node the server cannot expand is a leaf.
                Err(_) => Vec::new(),
            }
        };
        let mut merged: Vec<CallNode> = Vec::new();
        for item in &items {
            let usages = item.from_ranges.len().max(1);
            let symbol = self.symbol_of(item).await;
            match merged.iter_mut().find(|c| c.symbol.signature == symbol.signature) {
                Some(existing) => existing.usages += usages,
                None => merged.push(CallNode { symbol, usages }),
            }
        }
        merged.sort_by(|a, b| {
            a.symbol.display.cmp(&b.symbol.display).then_with(|| a.symbol.signature.cmp(&b.symbol.signature))
        });
        let merged = Arc::new(merged);
        self.children.insert(key, merged.clone());
        Ok(merged)
    }

    /// The server's calls of the symbol at `pos`; a server still loading the project
    /// fails the first requests, so the root retries a few times.
    async fn calls(&self, path: &Path, pos: Pos, retry: bool) -> IdeResult<Vec<HierarchyItem>> {
        let project = self.call.project();
        let mut attempt = 0;
        loop {
            let work = async {
                let doc = self.docs.open(path).await?;
                project.lsp.call_hierarchy(doc, pos, self.request.direction, self.call.cancel.clone()).await
            };
            match work.await {
                Ok(h) => return Ok(h.items),
                Err(e)
                    if retry
                        && attempt < 3
                        && matches!(e.kind, ide_core::error::ErrorKind::Protocol | ide_core::error::ErrorKind::Io) =>
                {
                    attempt += 1;
                    tokio::time::sleep(Duration::from_secs(1)).await;
                }
                Err(e) => return Err(e),
            }
        }
    }

    /// JetBrains' `renderNode`.
    #[allow(clippy::too_many_arguments)]
    fn render<'s>(
        &'s mut self,
        node: &'s CallNode,
        tree_path: Vec<String>,
        ancestors: Vec<String>,
        prefix: String,
        is_last: bool,
        remaining_depth: usize,
        child_offset: usize,
        out: &'s mut String,
    ) -> BoxFuture<'s, IdeResult<()>> {
        Box::pin(async move {
            if self.call.cancel.is_cancelled() {
                return Err(IdeError::cancelled());
            }
            self.rendered += 1;
            // Errors of the requested node itself are the answer; deeper nodes just stay leaves.
            let root = ancestors.len() == self.request.tree_path.len() + 1;
            // A call back into a node above is shown, not expanded again.
            let recursive = ancestors[..ancestors.len() - 1].contains(&node.symbol.signature);
            let expanded = if remaining_depth > 0 && !recursive {
                self.children_of(node, root).await?
            } else {
                Arc::new(Vec::new())
            };
            let marker = if !expanded.is_empty() || remaining_depth == 0 { "+ " } else { "" };
            out.push_str(&format!(
                "{prefix}{} {marker}{} {}\n",
                if is_last { "└─" } else { "├─" },
                node.symbol.display,
                metadata(node, &tree_path)
            ));
            if remaining_depth == 0 {
                return Ok(());
            }
            let child_prefix = format!("{prefix}{}", if is_last { "   " } else { "│  " });
            if child_offset > 0 && child_offset >= expanded.len() {
                out.push_str(&format!(
                    "{child_prefix}└─ … no more children [{TREE_PATH}={}, {CHILD_OFFSET}={child_offset}, \
totalChildren={}]\n",
                    format_tree_path(&tree_path),
                    expanded.len()
                ));
                return Ok(());
            }
            let to_render: Vec<&CallNode> =
                expanded.iter().skip(child_offset).take(self.request.max_children).collect();
            let more_line = expanded.len() > child_offset + to_render.len();
            let mut rendered_children = 0;
            for (i, child) in to_render.iter().enumerate() {
                if self.rendered >= self.request.max_nodes {
                    more(
                        out,
                        &child_prefix,
                        expanded.len() - child_offset - rendered_children,
                        &tree_path,
                        child_offset + rendered_children,
                    );
                    return Ok(());
                }
                let mut child_path = tree_path.clone();
                child_path.push(child.symbol.signature.clone());
                let mut child_ancestors = ancestors.clone();
                child_ancestors.push(child.symbol.signature.clone());
                let last = i + 1 == to_render.len() && !more_line;
                self.render(
                    child,
                    child_path,
                    child_ancestors,
                    child_prefix.clone(),
                    last,
                    remaining_depth - 1,
                    0,
                    out,
                )
                .await?;
                rendered_children += 1;
            }
            let next = child_offset + rendered_children;
            if expanded.len() > next {
                more(out, &child_prefix, expanded.len() - next, &tree_path, next);
            }
            Ok(())
        })
    }
}

/// JetBrains' `appendMoreLine`.
fn more(out: &mut String, prefix: &str, remaining: usize, tree_path: &[String], child_offset: usize) {
    if remaining > 0 {
        out.push_str(&format!(
            "{prefix}└─ … and {remaining} more [{TREE_PATH}={}, {CHILD_OFFSET}={child_offset}]\n",
            format_tree_path(tree_path)
        ));
    }
}

/// JetBrains' `formatNodeMetadata`.
fn metadata(node: &CallNode, tree_path: &[String]) -> String {
    let mut parts = Vec::new();
    if node.usages > 1 {
        parts.push(format!("{} usages", node.usages));
    }
    if let Some(f) = &node.symbol.file_path {
        parts.push(format!("filePath={}", serde_json::to_string(f).unwrap_or_default()));
    }
    parts.push(format!("{TREE_PATH}={}", format_tree_path(tree_path)));
    format!("[{}]", parts.join(", "))
}

fn format_tree_path(tree_path: &[String]) -> String {
    serde_json::to_string(tree_path).unwrap_or_default()
}

fn no_callable(fqn: &str) -> IdeError {
    IdeError::not_found(format!(
        "No callable symbol found for {SYMBOL_FQN} `{fqn}`.\nPass a callable FQN such as `com.example.Service.run` or \
`com.example.Service.run(String)`.\nType roots are supported only when the language call hierarchy provider maps them \
to a callable target; use `search_symbol` to find callable symbols when needed."
    ))
}

/// The parameters written after the name declared at `pos` (spanning a few lines at most).
fn declared_parameters(text: &str, name: &str, pos: Pos) -> Option<String> {
    let lines: Vec<&str> = text.split('\n').skip(pos.line as usize).take(12).collect();
    let first = lines.first()?;
    let from = super::utf16_to_byte(first, pos.col);
    let mut window = first[from..].to_owned();
    for l in &lines[1..] {
        window.push('\n');
        window.push_str(l);
    }
    // Only the declaration itself: its name must come first.
    window.starts_with(name).then(|| value_parameters(&window, name)).flatten()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_parameters() {
        assert_eq!(value_parameters("void run(int a, String b) {", "run").as_deref(), Some("(int a, String b)"));
        assert_eq!(value_parameters("fn map<T: Fn(u8)>(\n    f: T,\n) -> u8", "map").as_deref(), Some("(f: T,)"));
        assert_eq!(value_parameters("runner(x)", "run"), None);
        assert_eq!(value_parameters("class Foo {", "Foo"), None);
        assert_eq!(declared_parameters("x\n  def go(self, n):\n", "go", Pos::new(1, 6)).as_deref(), Some("(self, n)"));
        assert_eq!(declared_parameters("go(1)", "go", Pos::new(0, 1)), None);
    }

    #[test]
    fn matches_parameters_loosely() {
        assert!(parameters_match("(String)", "(String s)"));
        assert!(parameters_match("()", "()"));
        assert!(parameters_match("(u8, &str)", "(a: u8, b: &str)"));
        assert!(parameters_match("(Map<K, V>)", "(Map<K, V> m)"));
        assert!(!parameters_match("(String)", "()"));
        assert!(!parameters_match("(int)", "(String s)"));
    }

    #[test]
    fn builds_signatures() {
        let module = module_segments("src/calls/CallGraph.java");
        assert_eq!(module, ["src", "calls", "CallGraph"]);
        assert_eq!(signature(&module, Some("CallGraph"), "first", Some("()")), "src.calls.CallGraph.first()");
        assert_eq!(
            signature(&module_segments("src/net.rs"), Some("Client"), "connect", None),
            "src.net.Client.connect"
        );
        assert_eq!(signature(&module_segments("a/one.js"), None, "run", None), "a.one.run");
        // A constructor named like its class keeps both.
        assert_eq!(signature(&module, Some("CallGraph"), "CallGraph", Some("()")), "src.calls.CallGraph.CallGraph()");
        assert_eq!(split_parameters("a.b(String)"), ("a.b", Some("(String)")));
        assert_eq!(split_fqn("crate::net::connect"), ["crate", "net", "connect"]);
        assert!(subsequence(&["a".into(), "c".into()], &["a".into(), "b".into(), "c".into()]));
        assert!(!subsequence(&["c".into(), "a".into()], &["a".into(), "b".into(), "c".into()]));
    }
}
