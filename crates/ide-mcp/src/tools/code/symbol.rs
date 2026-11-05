// Ported from JetBrains intellij-community plugins/mcp-server (mcpserver.toolsets/src/general/CodeInsightToolset.kt, src/com/intellij/mcpserver/util/psi.util.kt), Apache-2.0.
//! `get_symbol_info`: Quick Documentation for the symbol at a position.
//!
//! IntelliJ resolves the reference under the caret (PSI) and renders its documentation
//! targets; here the language server's hover is the documentation and its go-to-definition
//! the declaration. Files no server serves (or a server that finds nothing) fall back to
//! the symbol index for the declaration; the documentation is then empty.

use super::{
    Docs, INDEXING_PARTIAL_RESULT_REASON, RELATIVE_PATH_DESCRIPTION, blocking, char_column, html, indexing, load_text,
    name_position, word_at,
};
use crate::tool::{Call, Output, Param, ParamType, Tool};
use ide_core::mcp::McpToolKind;
use ide_core::{IdeError, Pos, Range};
use ide_lsp::types::GotoKind;
use serde::Serialize;
use serde_json::json;
use std::path::Path;
use std::time::Duration;

/// The JetBrains tool has no timeout parameter; a server that is still starting gets this long.
const LANGUAGE_SERVER_BUDGET: Duration = Duration::from_secs(20);
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

/// The declaration's file text is readable only through the server for library code (`jdt://`).
fn file_target(l: &ide_core::Location) -> bool {
    l.uri.is_none()
}

pub(super) fn get_symbol_info() -> Tool {
    Tool::new(
        "get_symbol_info",
        McpToolKind::Read,
        "Retrieves information about the symbol at the specified position in the specified file.
Provides the same information as the Quick Documentation feature of the IDE does (the language server's hover).

This tool is useful for getting information about the symbol at the specified position in the specified file.
The information may include the symbol's name, signature, type, documentation, etc. It depends on a particular language.

If the position has a reference to a symbol the tool will return a piece of code with the declaration of the symbol if \
possible.

Use this tool to understand symbols declaration, semantics, where it's declared, etc.",
        |call| async move {
            let requested = call.str("filePath")?;
            let path = call.resolve_readable(&requested).await?;
            let line = call.opt_i64("line")?.ok_or_else(|| IdeError::invalid("missing required argument `line`"))?;
            let column =
                call.opt_i64("column")?.ok_or_else(|| IdeError::invalid("missing required argument `column`"))?;
            if !path.exists() {
                return Err(IdeError::not_found(format!("File not found: {requested}")));
            }
            let project = call.project().clone();
            let file = {
                let (project, path) = (project.clone(), path.clone());
                blocking(move || Ok(load_text(&project, &path))).await?
            };
            let file = match file {
                Ok(f) => f,
                Err(_) => {
                    return Err(IdeError::invalid(format!("Cannot read file: {requested}")));
                }
            };
            let lines = file.text.split('\n').count() as i64;
            if line < 1 || line > lines {
                return Err(IdeError::invalid("Line number is out of bounds of the document"));
            }
            let line_text = file.line(line as u32 - 1);
            let len = line_text.encode_utf16().count() as i64;
            if column < 1 || column > len + 1 {
                return Err(IdeError::invalid(format!(
                    "Line and column {line}:{column} is out of bounds (line {line} has {len} characters)"
                )));
            }
            let (line, column) = (line as u32, column as u32);
            let pos = Pos::new(line - 1, column - 1);
            let word = word_at(line_text, char_column(line_text, column));
            let indexing_before = indexing(&project);

            let mut documentation = String::new();
            let mut info = None;
            let mut reasons: Vec<String> = Vec::new();
            if file.served {
                let docs = Docs::new(project.clone());
                let work = async {
                    let doc = docs.open(&path).await?;
                    let lsp = &project.lsp;
                    let hover = async {
                        let first = lsp.hover(doc, pos, call.cancel.clone()).await;
                        // A server that just received the file may answer before it analysed it.
                        if matches!(first, Ok(None)) && word.is_some() {
                            tokio::time::sleep(Duration::from_millis(800)).await;
                            return lsp.hover(doc, pos, call.cancel.clone()).await;
                        }
                        first
                    };
                    let goto = lsp.goto(doc, pos, GotoKind::Definition);
                    Ok::<_, IdeError>(futures::join!(hover, goto))
                };
                match tokio::time::timeout(LANGUAGE_SERVER_BUDGET, work).await {
                    Ok(Ok((hover, goto))) => {
                        match hover {
                            Ok(Some(h)) => documentation = html::to_markdown(&h.contents.kind, &h.contents.value),
                            Ok(None) => {}
                            Err(e) if e.kind == ide_core::error::ErrorKind::Cancelled => return Err(e),
                            Err(_) => {}
                        }
                        if let Ok(locations) = goto
                            && let Some(l) = locations.iter().find(|l| file_target(l))
                        {
                            let text = project.text_of(&l.path).unwrap_or_default();
                            let name = word.clone().filter(|w| !w.is_empty());
                            let at = match &name {
                                Some(n) => name_position(&text, n, l.range),
                                None => l.range.start,
                            };
                            info = symbol_info(&call, &l.path, name, Range::point(at), 1);
                        }
                    }
                    Ok(Err(e)) => return Err(e),
                    Err(_) => reasons.push(
                        "The language server did not answer in time (it may still be starting or indexing); retry \
later."
                            .into(),
                    ),
                }
            } else {
                reasons.push(
                    "No language server serves this file, so there is no documentation; the declaration comes from \
the symbol index."
                        .into(),
                );
            }
            if info.is_none()
                && let Some(w) = &word
            {
                let mut found = project.index.symbols_named(w, None, 50);
                // A declaration in this file first.
                found.sort_by_key(|m| *m.path != *path);
                if let Some(m) = found.into_iter().next() {
                    info = symbol_info(&call, &m.path, Some(m.name), m.range, 1);
                }
            }
            if indexing_before || indexing(&project) {
                reasons.insert(0, INDEXING_PARTIAL_RESULT_REASON.into());
            }
            let mut out = json!({ "documentation": documentation });
            if let Some(info) = info {
                out["symbolInfo"] = serde_json::to_value(info).unwrap_or_default();
            }
            if !reasons.is_empty() {
                out["partialResultReason"] = reasons.join(" ").into();
            }
            Output::json(out)
        },
    )
    .param(Param::required("filePath", ParamType::String, RELATIVE_PATH_DESCRIPTION))
    .param(Param::required("line", ParamType::Integer, "1-based line number"))
    .param(Param::required("column", ParamType::Integer, "1-based column number"))
    .output(json!({
        "type": "object",
        "properties": {
            "symbolInfo": {
                "type": "object",
                "properties": {
                    "name": { "type": "string" },
                    "declarationText": { "type": "string" },
                    "declarationFile": { "type": "string" },
                    "declarationLine": { "type": "integer" },
                    "language": { "type": "string" },
                },
                "required": ["declarationText"],
            },
            "documentation": { "type": "string" },
            "partialResultReason": { "type": "string" },
        },
        "required": ["documentation"],
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn takes_comments_and_annotations_above() {
        assert!(leads_declaration("  /// Adds one.", Some("//")));
        assert!(leads_declaration("    @Override", Some("//")));
        assert!(leads_declaration("# comment", Some("#")));
        assert!(!leads_declaration("", Some("//")));
        assert!(!leads_declaration("}", Some("//")));
    }
}
