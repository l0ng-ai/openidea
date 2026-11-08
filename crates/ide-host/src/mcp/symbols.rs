//! Quick Documentation through the project's language services.
use super::tool::{Call, Output, Param, ParamType, Tool};
use ide_core::{IdeError, IdeResult, Pos, Range};
use ide_lsp::types::GotoKind;
use serde::Serialize;
use serde_json::json;
use std::path::Path;

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
