//! Quick Documentation through the project's language services.
use super::tool::{Call, Output, Param, ParamType, Tool};
use ide_core::error::ErrorKind;
use ide_core::{DocId, IdeError, IdeResult, OutlineItem, Pos, Range, RequestId, SymbolKind};
use ide_lsp::types::{CallHierarchy, GotoKind, HierarchyDirection, HierarchyItem, ReferencesIncomplete};
use serde::Serialize;
use serde_json::json;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

pub fn get_symbol_info() -> Tool {
    Tool::new("get_symbol_info", "Retrieves information about the symbol at the specified position in the specified file.
Provides the same information as the Quick Documentation feature of the IDE does (the language server's hover).

This tool is useful for getting information about the symbol at the specified position in the specified file.
The information may include the symbol's name, signature, type, documentation, etc. It depends on a particular language.

If the position has a reference to a symbol the tool will return a piece of code with the declaration of the symbol if possible.

Use this tool to understand symbols declaration, semantics, where it's declared, etc.", get_info)
    .param(Param::required("filePath", ParamType::String, "Path relative to the project root"))
    .param(Param::required("line", ParamType::Integer, "1-based line number"))
    .param(Param::required("column", ParamType::Integer, "1-based UTF-16 column number"))
}

async fn get_info(call: Call) -> IdeResult<Output> {
    let path = call.resolve_readable(&call.str("filePath")?).await?;
    let line = call.opt_i64("line")?.ok_or_else(|| IdeError::invalid("missing line"))?;
    let col = call.opt_i64("column")?.ok_or_else(|| IdeError::invalid("missing column"))?;
    let project = call.project.clone();
    let p = path.clone();
    struct Document(std::sync::Arc<crate::Project>, ide_core::DocId);
    impl Drop for Document {
        fn drop(&mut self) {
            self.0.documents.close(self.1);
        }
    }
    let (text, document) = call
        .host
        .blocking(move || {
            let text = project.text_of(&p)?;
            let doc = project.documents.open(&p)?;
            Ok((text, Document(project, doc.id)))
        })
        .await?;
    let doc = document.1;
    if line < 1 || line > u32::MAX as i64 {
        return Err(IdeError::invalid("line is out of bounds"));
    }
    let line_text = usize::try_from(line.saturating_sub(1))
        .ok()
        .and_then(|l| text.split('\n').nth(l))
        .ok_or_else(|| IdeError::invalid("Line number is out of bounds of the document"))?;
    if col < 1 || col as usize > line_text.encode_utf16().count() + 1 {
        return Err(IdeError::invalid("Column number is out of bounds of the document"));
    }
    let pos = Pos::new((line - 1) as u32, (col - 1) as u32);
    let word = word_at(line_text, char_column(line_text, col as u32));
    let mut output = json!({"documentation":""});
    let work = async {
        let hover = call.project.lsp.hover(doc, pos, call.cancel.clone()).await;
        let definitions = call.project.lsp.goto(doc, pos, GotoKind::Definition).await;
        Ok::<_, IdeError>((hover, definitions))
    };
    let result = tokio::select! {
        result = tokio::time::timeout(std::time::Duration::from_secs(20), work) => result,
        _ = call.cancel.cancelled() => return Err(IdeError::cancelled()),
    };
    match result {
        Ok(Ok((hover, definitions))) => {
            if let Ok(Some(hover)) = hover {
                output["documentation"] = hover.contents.value.into();
            }
            if let Ok(definitions) = definitions
                && let Some(location) = definitions.iter().find(|l| l.uri.is_none())
                && let Some(info) = symbol_info(&call, &location.path, word.clone(), location.range, 1)
            {
                output["symbolInfo"] = serde_json::to_value(info).map_err(|e| IdeError::internal(e.to_string()))?;
            }
        }
        Ok(Err(e)) => {
            output["partialResultReason"] = e.message.into();
        }
        Err(_) => {
            output["partialResultReason"] = "The language server did not answer in time; retry later.".into();
        }
    }
    if output.get("symbolInfo").is_none()
        && let Some(word) = word
    {
        let project = call.project.clone();
        let path = path.clone();
        let found = call
            .host
            .blocking(move || {
                let mut symbols = project.index.symbols_named(&word, None, 50);
                symbols.sort_by_key(|s| s.path != path);
                Ok(symbols.into_iter().next())
            })
            .await?;
        if let Some(symbol) = found
            && let Some(info) = symbol_info(&call, &symbol.path, Some(symbol.name), symbol.range, 1)
        {
            output["symbolInfo"] = serde_json::to_value(info).map_err(|e| IdeError::internal(e.to_string()))?;
        }
    }
    if call.project.index.status().indexing {
        output["partialResultReason"] = super::util::INDEXING_PARTIAL_RESULT_REASON.into();
    }
    Ok(Output::text(output.to_string()))
}

/// The 1-based character index of 1-based UTF-16 `column` in `line`.
fn char_column(line: &str, column: u32) -> u32 {
    let mut units = 0u32;
    let mut chars = 0u32;
    for c in line.chars() {
        if units + 1 >= column {
            break;
        }
        units += c.len_utf16() as u32;
        chars += 1;
    }
    chars + 1
}

fn is_word(c: char) -> bool {
    c.is_alphanumeric() || c == '_' || c == '$'
}

/// The identifier at (or just before) 1-based character `column` of `line`.
fn word_at(line: &str, column: u32) -> Option<String> {
    let chars: Vec<char> = line.chars().collect();
    let mut at = (column as usize).saturating_sub(1).min(chars.len());
    if !chars.get(at).is_some_and(|c| is_word(*c)) {
        if at > 0 && is_word(chars[at - 1]) {
            at -= 1;
        } else {
            return None;
        }
    }
    let start = (0..=at).rev().take_while(|i| is_word(chars[*i])).last()?;
    let end = (at..chars.len()).take_while(|i| is_word(chars[*i])).last()? + 1;
    Some(chars[start..end].iter().collect())
}

/// Lines of comments and annotations above a declaration that count as part of it.
const MAX_LEADING_LINES: usize = 30;

/// JetBrains' `SymbolInfo`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SymbolInfo {
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    declaration_text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    declaration_file: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    declaration_line: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    language: Option<String>,
}

/// JetBrains' `getElementSymbolInfo` over a declaration's name range: from the comments and
/// annotations right above it to the line where the name ends, plus `extra_lines`.
fn symbol_info(
    call: &Call,
    path: &Path,
    name: Option<String>,
    name_range: Range,
    extra_lines: u32,
) -> Option<SymbolInfo> {
    let project = call.project();
    let text = project.text_of(path).ok()?;
    let text = text.replace("\r\n", "\n");
    let lines: Vec<&str> = text.split('\n').collect();
    let name_line = name_range.start.line as usize;
    if name_line >= lines.len() {
        return None;
    }
    let language = project.languages.detect(path, lines.first().copied());
    let config = project.languages.get(&language);
    let line_comment = config.as_ref().and_then(|c| c.line_comment.clone());
    let mut start = name_line;
    while start > 0
        && name_line - start < MAX_LEADING_LINES
        && leads_declaration(lines[start - 1], line_comment.as_deref())
    {
        start -= 1;
    }
    let end = (name_range.end.line.max(name_range.start.line) as usize + extra_lines as usize).min(lines.len() - 1);
    Some(SymbolInfo {
        name,
        declaration_text: format!("<…>\n{}\n<…>", lines[start..=end].join("\n")),
        declaration_file: Some(call.display(path)),
        declaration_line: Some(name_line as u32 + 1),
        language: config.map(|c| c.name),
    })
}

/// Doc comments, comments and annotations / attributes / decorators belong to the declaration below.
fn leads_declaration(line: &str, line_comment: Option<&str>) -> bool {
    let t = line.trim_start();
    if t.is_empty() {
        return false;
    }
    ["//", "/*", "*", "#[", "#![", "@"].iter().any(|p| t.starts_with(p))
        || line_comment.is_some_and(|c| !c.is_empty() && t.starts_with(c))
}

pub fn find_references() -> Tool {
    Tool::new("find_references", "Find references using the language service and the IDE's project index. Positions are 1-based UTF-16. Reports incomplete results when analysis is still running.", |call| async move {
        let path = call.resolve_readable(&call.str("filePath")?).await?;
        let page = super::page::Page::of(&call, REFERENCES_LIMIT)?;
        let dir = super::scope::Scope::of(&call)?;
        let opened = open_at(&call, path).await?;
        let request = super::tool::request_id();
        let work = crate::ops::lsp::lsp_references(&call.host, &call.window, request, opened.doc, opened.pos, call.flag("includeDeclaration", true)?, true, false, crate::ops::Channel::new(|_| {}));
        let result = race(&call, request, work, "references timed out; retry when analysis finishes").await?;
        let mut value = serde_json::to_value(&result).map_err(|e| IdeError::internal(e.to_string()))?;
        // Convert every Location range at this boundary, including declarations.
        fn positions(value: &mut serde_json::Value) {
            match value {
                serde_json::Value::Object(map) => {
                    if let (Some(line), Some(col)) = (map.get("line").and_then(|v| v.as_u64()), map.get("col").and_then(|v| v.as_u64())) {
                        map.insert("line".into(), (line + 1).into()); map.insert("col".into(), (col + 1).into());
                    } else { for v in map.values_mut() { positions(v); } }
                }
                serde_json::Value::Array(items) => { for v in items { positions(v); } }
                _ => {}
            }
        }
        positions(&mut value);
        // `classified`, when there, goes with `locations` one to one.
        if let serde_json::Value::Object(map) = &mut value {
            let mut list = |key: &str| match map.remove(key) { Some(serde_json::Value::Array(items)) => items, _ => Vec::new() };
            let (mut locations, mut classified) = (list("locations"), list("classified"));
            if dir.dir().is_some() {
                let inside = |l: &serde_json::Value| l["path"].as_str().is_some_and(|p| dir.contains(std::path::Path::new(p)));
                locations.retain(inside);
                classified.retain(|c| inside(&c["location"]));
            }
            let classified = page.take(classified, &mut serde_json::Map::new());
            let locations = page.take(locations, map);
            map.insert("locations".into(), locations.into());
            map.insert("classified".into(), classified.into());
        }
        Output::json(value)
    })
    .param(Param::required("filePath", ParamType::String, "Path relative to the project root"))
    .param(Param::required("line", ParamType::Integer, "1-based line"))
    .param(Param::required("column", ParamType::Integer, "1-based UTF-16 column"))
    .param(Param::optional("includeDeclaration", ParamType::Boolean, "Include declarations (default true)"))
    .param(super::scope::param())
    .param(Param::optional("limit", ParamType::Integer, "References to return at most (default 100)"))
    .param(Param::optional("offset", ParamType::Integer, super::page::OFFSET))
}

/// References `find_references` lists by default.
const REFERENCES_LIMIT: usize = 100;

/// A document a tool opened for the language services and the position it asked about;
/// dropping it closes the document.
#[must_use]
struct Opened {
    project: Arc<crate::Project>,
    doc: DocId,
    pos: Pos,
}

impl Drop for Opened {
    fn drop(&mut self) {
        self.project.documents.close(self.doc);
    }
}

/// Opens `path` at the call's 1-based `line` and `column`.
async fn open_at(call: &Call, path: PathBuf) -> IdeResult<Opened> {
    let line = call.opt_i64("line")?.ok_or_else(|| IdeError::invalid("missing line"))?;
    let column = call.opt_i64("column")?.ok_or_else(|| IdeError::invalid("missing column"))?;
    let project = call.project.clone();
    let (doc, text) = call
        .host
        .blocking(move || {
            let text = project.text_of(&path)?;
            let doc = project.documents.open(&path)?;
            Ok((doc.id, text))
        })
        .await?;
    let mut opened = Opened { project: call.project.clone(), doc, pos: Pos::default() };
    opened.pos = mcp_position(&text, line, column)?;
    Ok(opened)
}

/// How long a tool waits for a language service request.
const LANGUAGE_SERVICE_TIMEOUT: Duration = Duration::from_secs(60);

/// `work`, the language service `request`, until it ends; when the client cancels or
/// [`LANGUAGE_SERVICE_TIMEOUT`] passes first, the request is cancelled and `work` runs to its end.
async fn race<T>(
    call: &Call,
    request: RequestId,
    work: impl Future<Output = IdeResult<T>>,
    timed_out: &'static str,
) -> IdeResult<T> {
    tokio::pin!(work);
    tokio::select! {
        result = &mut work => result,
        _ = call.cancel.cancelled() => {
            call.host.cancel_request(request);
            let _ = work.await;
            Err(IdeError::cancelled())
        }
        _ = tokio::time::sleep(LANGUAGE_SERVICE_TIMEOUT) => {
            call.host.cancel_request(request);
            let _ = work.await;
            Err(IdeError::unavailable(timed_out))
        }
    }
}

pub fn get_call_hierarchy() -> Tool {
    Tool::new(
        "get_call_hierarchy",
        "Callers (incoming) or callees (outgoing) of the function or method at the position, from \
         the language server's call hierarchy. A position inside a function body means that function. \
         One level per call: to go deeper, call again with an item's filePath, startLine and startColumn \
         (items in libraries show a URI as filePath and cannot be expanded). \
         Positions are 1-based UTF-16. `root` is the symbol the hierarchy is for; each item's callSites \
         are where the call happens. Reports incomplete results when analysis is still running.",
        call_hierarchy,
    )
    .param(Param::required("filePath", ParamType::String, "Path relative to the project root"))
    .param(Param::required("line", ParamType::Integer, "1-based line"))
    .param(Param::required("column", ParamType::Integer, "1-based UTF-16 column"))
    .param(Param::optional("direction", ParamType::String, "incoming (callers, default) or outgoing (callees)"))
    .param(super::scope::param())
    .param(Param::optional("limit", ParamType::Integer, "Items to return at most (default 100)"))
    .param(Param::optional("offset", ParamType::Integer, super::page::OFFSET))
}

/// Items `get_call_hierarchy` lists by default.
const CALLS_LIMIT: usize = 100;
/// Call sites shown per item; `callSiteCount` gives the total when there are more.
const MAX_CALL_SITES: usize = 20;
const CALLS_TIMED_OUT: &str = "call hierarchy timed out; retry when analysis finishes";

async fn call_hierarchy(call: Call) -> IdeResult<Output> {
    let direction = match call.opt_str("direction")?.as_deref() {
        None | Some("incoming") => HierarchyDirection::Incoming,
        Some("outgoing") => HierarchyDirection::Outgoing,
        Some(_) => return Err(IdeError::invalid("direction must be incoming or outgoing")),
    };
    let page = super::page::Page::of(&call, CALLS_LIMIT)?;
    let scope = super::scope::Scope::of(&call)?;
    let path = call.resolve_readable(&call.str("filePath")?).await?;
    let opened = open_at(&call, path).await?;
    let hierarchy_at = |pos| {
        let request = super::tool::request_id();
        let work = crate::ops::lsp::lsp_call_hierarchy(&call.host, &call.window, request, opened.doc, pos, direction);
        race(&call, request, work, CALLS_TIMED_OUT)
    };
    let mut found = match hierarchy_at(opened.pos).await {
        // IDEA: inside a function body the hierarchy is the enclosing function's.
        Err(e) if e.kind == ErrorKind::NotFound => {
            let outline = tokio::select! {
                outline = crate::ops::doc::doc_outline(&call.host, &call.window, opened.doc) => outline?,
                _ = call.cancel.cancelled() => return Err(IdeError::cancelled()),
            };
            let at = enclosing_callable(&outline, opened.pos).map(|f| f.selection_range.start);
            let Some(at) = at.filter(|at| *at != opened.pos) else {
                let Pos { line, col } = opened.pos;
                return Err(IdeError::not_found(format!("no function or method at {}:{}", line + 1, col + 1)));
            };
            hierarchy_at(at).await?
        }
        result => result?,
    };
    if scope.dir().is_some() {
        found.items.retain(|i| i.uri.is_none() && scope.contains(&i.path.0));
    }
    let incomplete = found.incomplete;
    let (mut root, items) = call_items(found, |p| call.display(p));
    let mut out = serde_json::Map::new();
    let mut items = page.take(items, &mut out);
    // One file in memory at a time, as `search::fill_lines` reads them.
    let mut places: Vec<&mut Place> = root
        .iter_mut()
        .chain(&mut items)
        .flat_map(|i| std::iter::once(&mut i.at).chain(&mut i.call_sites))
        .filter(|place| place.file.is_some())
        .collect();
    places.sort_by(|a, b| a.file.cmp(&b.file));
    for in_file in places.chunk_by_mut(|a, b| a.file == b.file) {
        if call.cancel.is_cancelled() {
            return Err(IdeError::cancelled());
        }
        let Some(path) = in_file[0].file.clone() else { continue };
        if let Ok(text) = crate::ops::fs::fs_read_text(&call.host, call.window(), path).await {
            fill_line_texts(in_file, &text);
        }
    }
    Output::json(CallHierarchyOutput { root, items, page: out, incomplete })
}

#[derive(Serialize)]
struct CallHierarchyOutput {
    #[serde(skip_serializing_if = "Option::is_none")]
    root: Option<CallItem>,
    items: Vec<CallItem>,
    /// `total`, and `more` and `nextOffset` when items follow.
    #[serde(flatten)]
    page: serde_json::Map<String, serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    incomplete: Option<ReferencesIncomplete>,
}

/// A function or method in the call hierarchy, at its name.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
struct CallItem {
    name: String,
    kind: SymbolKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<String>,
    #[serde(flatten)]
    at: Place,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    call_sites: Vec<Place>,
    #[serde(skip_serializing_if = "Option::is_none")]
    call_site_count: Option<usize>,
}

/// A range as the tools show it: 1-based UTF-16, with the text of its first line.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
struct Place {
    file_path: String,
    start_line: u32,
    start_column: u32,
    end_line: u32,
    end_column: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    line_text: Option<String>,
    /// The file `line_text` is read from; none in a library.
    #[serde(skip)]
    file: Option<PathBuf>,
}

/// The root and the items of `h`, sorted by file and position, with call sites in source
/// order, at most [`MAX_CALL_SITES`] per item. Library items show their URI.
fn call_items(h: CallHierarchy, display: impl Fn(&Path) -> String) -> (Option<CallItem>, Vec<CallItem>) {
    let CallHierarchy { root, items, .. } = h;
    // A file path, or the URI of a virtual document, which has no lines to read here.
    let target = |path: &Path, uri: Option<&String>| match uri {
        Some(uri) => (None, uri.clone()),
        None => (Some(path.to_path_buf()), display(path)),
    };
    let place = |(file, file_path): (Option<PathBuf>, String), r: Range| Place {
        file_path,
        start_line: r.start.line + 1,
        start_column: r.start.col + 1,
        end_line: r.end.line + 1,
        end_column: r.end.col + 1,
        line_text: None,
        file,
    };
    let convert = |i: HierarchyItem| {
        let at = target(&i.path.0, i.uri.as_ref());
        let sites_in = match &i.from_path {
            Some(p) => {
                let shown = p.0.to_string_lossy();
                target(&p.0, ide_core::is_virtual_uri(&shown).then(|| shown.into_owned()).as_ref())
            }
            None => at.clone(),
        };
        let mut sites = i.from_ranges;
        sites.sort();
        sites.dedup();
        let count = sites.len();
        CallItem {
            call_sites: sites.into_iter().take(MAX_CALL_SITES).map(|r| place(sites_in.clone(), r)).collect(),
            call_site_count: (count > MAX_CALL_SITES).then_some(count),
            at: place(at, i.selection_range),
            name: i.name,
            kind: i.kind,
            detail: i.detail,
        }
    };
    let mut items: Vec<CallItem> = items.into_iter().map(&convert).collect();
    items.sort_by(|a, b| {
        (&a.at.file_path, a.at.start_line, a.at.start_column).cmp(&(
            &b.at.file_path,
            b.at.start_line,
            b.at.start_column,
        ))
    });
    (root.map(convert), items)
}

/// Fills `lineText` of `places`, which are all in the file whose text is `text`.
fn fill_line_texts(places: &mut [&mut Place], text: &str) {
    let lines: Vec<&str> = text.split('\n').collect();
    for place in places {
        let Some(line) = lines.get(place.start_line as usize - 1) else { continue };
        let line = line.strip_suffix('\r').unwrap_or(line);
        let start = place.start_column as usize - 1;
        let end = if place.end_line == place.start_line { place.end_column as usize - 1 } else { start };
        place.line_text = Some(super::search::snippet(line, start, end));
    }
}

/// The innermost function, method or constructor of `outline` whose extent holds `pos`,
/// as the IDE's Call Hierarchy finds it.
fn enclosing_callable(outline: &[OutlineItem], pos: Pos) -> Option<&OutlineItem> {
    let item = outline.iter().find(|i| i.range.start <= pos && pos <= i.range.end)?;
    enclosing_callable(&item.children, pos).or_else(|| {
        matches!(item.kind, SymbolKind::Function | SymbolKind::Method | SymbolKind::Constructor).then_some(item)
    })
}

fn mcp_position(text: &str, line: i64, column: i64) -> IdeResult<Pos> {
    if line < 1 || line > u32::MAX as i64 || column < 1 || column > u32::MAX as i64 {
        return Err(IdeError::invalid("line and column must be positive 1-based positions"));
    }
    let row = text.split('\n').nth((line - 1) as usize).ok_or_else(|| IdeError::invalid("line is out of bounds"))?;
    if column as usize > row.encode_utf16().count() + 1 {
        return Err(IdeError::invalid("column is out of bounds"));
    }
    Ok(Pos::new((line - 1) as u32, (column - 1) as u32))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn range(line: u32, col: u32, end_line: u32, end_col: u32) -> Range {
        Range::new(Pos::new(line, col), Pos::new(end_line, end_col))
    }

    fn item(name: &str, path: &str, line: u32, from_ranges: Vec<Range>) -> HierarchyItem {
        HierarchyItem {
            name: name.into(),
            kind: SymbolKind::Function,
            detail: Some(format!("fn {name}()")),
            path: PathBuf::from(path).into(),
            uri: None,
            range: range(line, 0, line + 2, 1),
            selection_range: range(line, 3, line, 3 + name.len() as u32),
            from_ranges,
            from_path: None,
        }
    }

    fn shown(path: &Path) -> String {
        path.strip_prefix("/p").unwrap_or(path).to_string_lossy().into_owned()
    }

    fn hierarchy(root: HierarchyItem, items: Vec<HierarchyItem>) -> CallHierarchy {
        CallHierarchy { root: Some(root), items, incomplete: None }
    }

    #[test]
    fn incoming_call_sites_are_in_the_callers_file_one_based() {
        let h = hierarchy(
            item("price", "/p/src/lib.rs", 10, Vec::new()),
            vec![item("main", "/p/src/main.rs", 2, vec![range(4, 8, 4, 13)])],
        );
        let (root, items) = call_items(h, shown);
        let root = serde_json::to_value(root.unwrap()).unwrap();
        assert_eq!(
            root,
            json!({"name":"price","kind":"function","detail":"fn price()","filePath":"src/lib.rs",
                   "startLine":11,"startColumn":4,"endLine":11,"endColumn":9})
        );
        assert_eq!(
            serde_json::to_value(&items).unwrap(),
            json!([{"name":"main","kind":"function","detail":"fn main()","filePath":"src/main.rs",
                    "startLine":3,"startColumn":4,"endLine":3,"endColumn":8,
                    "callSites":[{"filePath":"src/main.rs","startLine":5,"startColumn":9,"endLine":5,"endColumn":14}]}])
        );
    }

    #[test]
    fn outgoing_call_sites_are_in_the_file_ide_lsp_names() {
        let mut price = item("price", "/p/src/lib.rs", 10, vec![range(4, 8, 4, 13)]);
        price.from_path = Some(PathBuf::from("/p/src/main.rs").into());
        let (_, items) = call_items(hierarchy(item("main", "/p/src/main.rs", 2, Vec::new()), vec![price]), shown);
        assert_eq!(items[0].at.file_path, "src/lib.rs");
        assert_eq!(items[0].call_sites[0].file_path, "src/main.rs");
        assert_eq!(items[0].call_sites[0].file.as_deref(), Some(Path::new("/p/src/main.rs")));
    }

    #[test]
    fn library_items_show_their_uri() {
        let mut library = item("len", "/virtual", 0, vec![range(4, 8, 4, 11)]);
        library.uri = Some("jar:file:///lib.jar!/Str.class".into());
        library.from_path = Some(PathBuf::from("/p/src/main.rs").into());
        let mut called_from_library = item("parse", "/p/src/a.rs", 3, vec![range(1, 0, 1, 4)]);
        called_from_library.from_path = Some(PathBuf::from("jdt://contents/lib.jar/Caller.class").into());
        let h = hierarchy(item("main", "/p/src/main.rs", 2, Vec::new()), vec![library, called_from_library]);
        let (_, items) = call_items(h, shown);
        assert_eq!(items[0].at.file_path, "jar:file:///lib.jar!/Str.class");
        assert_eq!(items[0].at.file, None, "no line text for a library item");
        assert_eq!(items[0].call_sites[0].file_path, "src/main.rs");
        assert_eq!(items[1].call_sites[0].file_path, "jdt://contents/lib.jar/Caller.class");
        assert_eq!(items[1].call_sites[0].file, None);
    }

    #[test]
    fn call_items_are_sorted_by_file_and_line() {
        let h = hierarchy(
            item("price", "/p/src/lib.rs", 10, Vec::new()),
            vec![
                item("c", "/p/src/main.rs", 9, Vec::new()),
                item("b", "/p/src/main.rs", 2, Vec::new()),
                item("a", "/p/src/a.rs", 5, Vec::new()),
            ],
        );
        let (_, items) = call_items(h, shown);
        assert_eq!(items.iter().map(|i| i.name.as_str()).collect::<Vec<_>>(), ["a", "b", "c"]);
    }

    #[test]
    fn call_sites_are_capped_with_their_count() {
        let sites = (0..MAX_CALL_SITES as u32 + 5).map(|l| range(l, 0, l, 1)).collect();
        let h = hierarchy(item("price", "/p/src/lib.rs", 10, Vec::new()), vec![item("main", "/p/a.rs", 0, sites)]);
        let (_, items) = call_items(h, shown);
        assert_eq!(items[0].call_sites.len(), MAX_CALL_SITES);
        assert_eq!(items[0].call_site_count, Some(MAX_CALL_SITES + 5));
        let one = hierarchy(
            item("price", "/p/src/lib.rs", 10, Vec::new()),
            vec![item("main", "/p/a.rs", 0, vec![range(1, 0, 1, 1)])],
        );
        assert_eq!(call_items(one, shown).1[0].call_site_count, None);
    }

    #[test]
    fn call_sites_are_in_source_order_without_duplicates() {
        let sites = vec![range(5, 0, 5, 1), range(1, 4, 1, 5), range(5, 0, 5, 1), range(1, 2, 1, 3)];
        let h = hierarchy(item("price", "/p/src/lib.rs", 10, Vec::new()), vec![item("main", "/p/a.rs", 0, sites)]);
        let (_, items) = call_items(h, shown);
        let at: Vec<_> = items[0].call_sites.iter().map(|s| (s.start_line, s.start_column)).collect();
        assert_eq!(at, [(2, 3), (2, 5), (6, 1)]);
        assert_eq!(items[0].call_site_count, None);
    }

    #[test]
    fn line_text_is_cut_from_the_line_of_each_place() {
        let h = hierarchy(item("price", "/p/src/lib.rs", 3, vec![range(0, 4, 0, 9), range(1, 0, 3, 1)]), Vec::new());
        let mut root = call_items(h, shown).0.unwrap();
        let mut places: Vec<&mut Place> = std::iter::once(&mut root.at).chain(&mut root.call_sites).collect();
        fill_line_texts(&mut places, "    price();\r\nfn other() {\n\nfn price() {}");
        assert_eq!(root.at.line_text.as_deref(), Some("fn price() {}"));
        assert_eq!(root.call_sites[0].line_text.as_deref(), Some("    price();"));
        assert_eq!(root.call_sites[1].line_text.as_deref(), Some("fn other() {"), "a range over lines");
    }

    #[test]
    fn enclosing_callable_is_the_innermost_function() {
        let outline = |name: &str, kind, range, children| OutlineItem {
            name: name.into(),
            detail: None,
            kind,
            range,
            selection_range: Range::new(range.start, range.start),
            children,
            visibility: None,
        };
        let method = outline(
            "total",
            SymbolKind::Method,
            range(2, 4, 8, 5),
            vec![outline("add", SymbolKind::Function, range(3, 8, 5, 9), Vec::new())],
        );
        let items = vec![outline("Cart", SymbolKind::Struct, range(0, 0, 9, 1), vec![method])];
        let name = |pos| enclosing_callable(&items, pos).map(|i| i.name.as_str());
        assert_eq!(name(Pos::new(4, 0)), Some("add"));
        assert_eq!(name(Pos::new(5, 9)), Some("add"), "the end is inside");
        assert_eq!(name(Pos::new(7, 0)), Some("total"));
        assert_eq!(name(Pos::new(0, 3)), None, "a struct is not callable");
        assert_eq!(name(Pos::new(12, 0)), None);
    }
}
