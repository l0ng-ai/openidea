use crate::Host;
use crate::apply_workspace_edit as apply_edit;
use crate::rpc::Dispatcher;
use ide_core::{DocId, IdeResult, Location, Pos, Range, RequestId, ServerId, TextEdit, WorkspaceEdit};
use ide_lsp::types::*;

pub async fn lsp_completion(
    host: &Host,
    window: &str,
    request: RequestId,
    doc: DocId,
    pos: Pos,
    trigger: Option<String>,
) -> IdeResult<CompletionList> {
    let lsp = host.project(window)?.lsp.clone();
    let cancel = host.begin_request(request);
    let result = lsp.completion(doc, pos, trigger, cancel).await;
    host.end_request(request);
    result
}

/// Inline (ghost text) suggestions at `pos`; `automatic` when triggered by typing.
pub async fn lsp_inline_completion(
    host: &Host,
    window: &str,
    request: RequestId,
    doc: DocId,
    pos: Pos,
    automatic: bool,
) -> IdeResult<Vec<InlineCompletionItem>> {
    let lsp = host.project(window)?.lsp.clone();
    let cancel = host.begin_request(request);
    let result = lsp.inline_completion(doc, pos, automatic, cancel).await;
    host.end_request(request);
    result
}

pub async fn lsp_resolve_completion(
    host: &Host,
    window: &str,
    doc: DocId,
    item: CompletionItem,
) -> IdeResult<CompletionItem> {
    host.project(window)?.lsp.resolve_completion(doc, item).await
}

pub async fn lsp_hover(
    host: &Host,
    window: &str,
    request: RequestId,
    doc: DocId,
    pos: Pos,
) -> IdeResult<Option<Hover>> {
    let lsp = host.project(window)?.lsp.clone();
    let cancel = host.begin_request(request);
    let result = lsp.hover(doc, pos, cancel).await;
    host.end_request(request);
    result
}

pub async fn lsp_signature_help(host: &Host, window: &str, doc: DocId, pos: Pos) -> IdeResult<Option<SignatureHelp>> {
    host.project(window)?.lsp.signature_help(doc, pos).await
}

pub async fn lsp_goto(host: &Host, window: &str, doc: DocId, pos: Pos, kind: GotoKind) -> IdeResult<Vec<Location>> {
    host.project(window)?.lsp.goto(doc, pos, kind).await
}

/// Implementations of the symbols at `positions`, one list per position (the
/// editor's "is implemented / overridden" gutter markers). Cancel with
/// `cancel_request(request)`.
pub async fn lsp_implementations(
    host: &Host,
    window: &str,
    request: RequestId,
    doc: DocId,
    positions: Vec<Pos>,
) -> IdeResult<Vec<Vec<Location>>> {
    let lsp = host.project(window)?.lsp.clone();
    let cancel = host.begin_request(request);
    let result = lsp.implementations(doc, &positions, cancel).await;
    host.end_request(request);
    result
}

/// Contents of a virtual document (library class, decompiled code) that a
/// language server returned a non-`file:` URI for. Cached per project.
pub async fn lsp_virtual_document(host: &Host, window: &str, uri: String) -> IdeResult<VirtualDocument> {
    host.project(window)?.lsp.virtual_document(&uri).await
}

/// References of the symbol at `pos`. `project_wide` also searches project files
/// outside the language server's analysis scope; bulk scans over many symbols
/// leave it off. Cancel with `cancel_request(request)`.
pub async fn lsp_references(
    host: &Host,
    window: &str,
    request: RequestId,
    doc: DocId,
    pos: Pos,
    include_declaration: bool,
    project_wide: bool,
) -> IdeResult<References> {
    let lsp = host.project(window)?.lsp.clone();
    let cancel = host.begin_request(request);
    let result = lsp.references(doc, pos, include_declaration, project_wide, cancel).await;
    host.end_request(request);
    result
}

pub async fn lsp_document_highlights(host: &Host, window: &str, doc: DocId, pos: Pos) -> IdeResult<Vec<Highlight>> {
    host.project(window)?.lsp.document_highlights(doc, pos).await
}

pub async fn lsp_workspace_symbols(
    host: &Host,
    window: &str,
    request: RequestId,
    query: String,
) -> IdeResult<Vec<WorkspaceSymbol>> {
    let lsp = host.project(window)?.lsp.clone();
    let cancel = host.begin_request(request);
    let result = lsp.workspace_symbols(&query, cancel).await;
    host.end_request(request);
    result
}

pub async fn lsp_code_actions(
    host: &Host,
    window: &str,
    doc: DocId,
    range: Range,
    only: Vec<String>,
) -> IdeResult<Vec<CodeAction>> {
    host.project(window)?.lsp.code_actions(doc, range, only).await
}

/// Cancellable code actions with the kinds the servers advertise (Refactor This, refactoring availability).
pub async fn lsp_code_action_query(
    host: &Host,
    window: &str,
    request: RequestId,
    doc: DocId,
    range: Range,
    only: Vec<String>,
) -> IdeResult<CodeActionQuery> {
    let lsp = host.project(window)?.lsp.clone();
    let cancel = host.begin_request(request);
    let result = lsp.code_action_query(doc, range, only, cancel).await;
    host.end_request(request);
    result
}

/// Resolves a code action's edit without applying it (intention preview).
pub async fn lsp_resolve_code_action(
    host: &Host,
    window: &str,
    doc: DocId,
    action: CodeAction,
) -> IdeResult<CodeAction> {
    if action.edit.is_some() {
        return Ok(action);
    }
    host.project(window)?.lsp.resolve_code_action(doc, action).await
}

/// Resolves (if needed), applies the edit, then runs the command of a code action.
pub async fn lsp_apply_code_action(host: &Host, window: &str, doc: DocId, action: CodeAction) -> IdeResult<()> {
    let project = host.project(window)?;
    let action = if action.edit.is_none() && action.command.is_none() {
        project.lsp.resolve_code_action(doc, action).await?
    } else {
        action
    };
    if let Some(edit) = &action.edit {
        apply_edit(&project.documents, edit)?;
    }
    if let Some(command) = action.command {
        project.lsp.execute_command(doc, command).await?;
    }
    Ok(())
}

pub async fn lsp_prepare_rename(host: &Host, window: &str, doc: DocId, pos: Pos) -> IdeResult<Option<Range>> {
    host.project(window)?.lsp.prepare_rename(doc, pos).await
}

/// Computes the rename edit without applying it, so the UI can preview conflicts.
pub async fn lsp_rename(host: &Host, window: &str, doc: DocId, pos: Pos, new_name: String) -> IdeResult<WorkspaceEdit> {
    host.project(window)?.lsp.rename(doc, pos, new_name).await
}

pub async fn lsp_format(
    host: &Host,
    window: &str,
    doc: DocId,
    range: Option<Range>,
    options: FormatOptions,
) -> IdeResult<Vec<TextEdit>> {
    host.project(window)?.lsp.format(doc, range, options).await
}

pub async fn lsp_inlay_hints(host: &Host, window: &str, doc: DocId, range: Range) -> IdeResult<Vec<InlayHint>> {
    host.project(window)?.lsp.inlay_hints(doc, range).await
}

pub async fn lsp_semantic_tokens(host: &Host, window: &str, doc: DocId) -> IdeResult<Option<SemanticTokens>> {
    host.project(window)?.lsp.semantic_tokens(doc).await
}

pub async fn lsp_code_lens(host: &Host, window: &str, doc: DocId) -> IdeResult<Vec<CodeLens>> {
    host.project(window)?.lsp.code_lens(doc).await
}

/// Links in a document (`href`s, Markdown links, `#include`s…) from its language servers.
pub async fn lsp_document_links(host: &Host, window: &str, doc: DocId) -> IdeResult<Vec<DocumentLink>> {
    host.project(window)?.lsp.document_links(doc).await
}

pub async fn lsp_call_hierarchy(
    host: &Host,
    window: &str,
    doc: DocId,
    pos: Pos,
    direction: HierarchyDirection,
) -> IdeResult<Vec<HierarchyItem>> {
    host.project(window)?.lsp.call_hierarchy(doc, pos, direction).await
}

pub async fn lsp_type_hierarchy(
    host: &Host,
    window: &str,
    doc: DocId,
    pos: Pos,
    direction: HierarchyDirection,
) -> IdeResult<Vec<HierarchyItem>> {
    host.project(window)?.lsp.type_hierarchy(doc, pos, direction).await
}

pub fn lsp_servers(host: &Host, window: &str) -> IdeResult<Vec<ServerInfo>> {
    Ok(host.project(window)?.lsp.servers())
}

pub async fn lsp_restart(host: &Host, window: &str, server: ServerId) -> IdeResult<()> {
    host.project(window)?.lsp.restart(server).await
}

/// Applies a (previewed) workspace edit, e.g. after rename confirmation.
pub fn apply_workspace_edit(host: &Host, window: &str, edit: WorkspaceEdit) -> IdeResult<()> {
    let project = host.project(window)?;
    // Multi-file refactorings leave a Local History point to go back to.
    let paths: Vec<&std::path::Path> = edit
        .files
        .iter()
        .filter_map(|f| match f {
            ide_core::FileEdit::Edit { path, .. } => Some(&**path),
            _ => None,
        })
        .collect();
    if edit.files.len() > 1 {
        project.record_before_refactoring(&paths, "Apply changes");
    }
    apply_edit(&project.documents, &edit)
}

/// Runs a server command (`workspace/executeCommand`), e.g. a completion item's
/// follow-up command. Edits the server requests arrive via `workspace/applyEdit`.
pub async fn lsp_execute_command(host: &Host, window: &str, doc: DocId, command: Command) -> IdeResult<()> {
    host.project(window)?.lsp.execute_command(doc, command).await
}

/// Commands of this module the remote server answers.
pub(crate) fn register(d: &mut Dispatcher) {
    d.add("lsp_completion", |c| async move {
        lsp_completion(&c.host, &c.window, c.arg("request")?, c.arg("doc")?, c.arg("pos")?, c.arg("trigger")?).await
    });
    d.add("lsp_inline_completion", |c| async move {
        lsp_inline_completion(&c.host, &c.window, c.arg("request")?, c.arg("doc")?, c.arg("pos")?, c.arg("automatic")?)
            .await
    });
    d.add("lsp_resolve_completion", |c| async move {
        lsp_resolve_completion(&c.host, &c.window, c.arg("doc")?, c.arg("item")?).await
    });
    d.add("lsp_hover", |c| async move {
        lsp_hover(&c.host, &c.window, c.arg("request")?, c.arg("doc")?, c.arg("pos")?).await
    });
    d.add("lsp_signature_help", |c| async move {
        lsp_signature_help(&c.host, &c.window, c.arg("doc")?, c.arg("pos")?).await
    });
    d.add(
        "lsp_goto",
        |c| async move { lsp_goto(&c.host, &c.window, c.arg("doc")?, c.arg("pos")?, c.arg("kind")?).await },
    );
    d.add("lsp_implementations", |c| async move {
        lsp_implementations(&c.host, &c.window, c.arg("request")?, c.arg("doc")?, c.arg("positions")?).await
    });
    d.add("lsp_virtual_document", |c| async move { lsp_virtual_document(&c.host, &c.window, c.arg("uri")?).await });
    d.add("lsp_references", |c| async move {
        lsp_references(
            &c.host,
            &c.window,
            c.arg("request")?,
            c.arg("doc")?,
            c.arg("pos")?,
            c.arg("includeDeclaration")?,
            c.arg("projectWide")?,
        )
        .await
    });
    d.add("lsp_document_highlights", |c| async move {
        lsp_document_highlights(&c.host, &c.window, c.arg("doc")?, c.arg("pos")?).await
    });
    d.add("lsp_workspace_symbols", |c| async move {
        lsp_workspace_symbols(&c.host, &c.window, c.arg("request")?, c.arg("query")?).await
    });
    d.add("lsp_code_actions", |c| async move {
        lsp_code_actions(&c.host, &c.window, c.arg("doc")?, c.arg("range")?, c.arg("only")?).await
    });
    d.add("lsp_code_action_query", |c| async move {
        lsp_code_action_query(&c.host, &c.window, c.arg("request")?, c.arg("doc")?, c.arg("range")?, c.arg("only")?)
            .await
    });
    d.add("lsp_resolve_code_action", |c| async move {
        lsp_resolve_code_action(&c.host, &c.window, c.arg("doc")?, c.arg("action")?).await
    });
    d.add("lsp_apply_code_action", |c| async move {
        lsp_apply_code_action(&c.host, &c.window, c.arg("doc")?, c.arg("action")?).await
    });
    d.add("lsp_prepare_rename", |c| async move {
        lsp_prepare_rename(&c.host, &c.window, c.arg("doc")?, c.arg("pos")?).await
    });
    d.add("lsp_rename", |c| async move {
        lsp_rename(&c.host, &c.window, c.arg("doc")?, c.arg("pos")?, c.arg("newName")?).await
    });
    d.add("lsp_format", |c| async move {
        lsp_format(&c.host, &c.window, c.arg("doc")?, c.arg("range")?, c.arg("options")?).await
    });
    d.add(
        "lsp_inlay_hints",
        |c| async move { lsp_inlay_hints(&c.host, &c.window, c.arg("doc")?, c.arg("range")?).await },
    );
    d.add("lsp_semantic_tokens", |c| async move { lsp_semantic_tokens(&c.host, &c.window, c.arg("doc")?).await });
    d.add("lsp_code_lens", |c| async move { lsp_code_lens(&c.host, &c.window, c.arg("doc")?).await });
    d.add("lsp_document_links", |c| async move { lsp_document_links(&c.host, &c.window, c.arg("doc")?).await });
    d.add("lsp_call_hierarchy", |c| async move {
        lsp_call_hierarchy(&c.host, &c.window, c.arg("doc")?, c.arg("pos")?, c.arg("direction")?).await
    });
    d.add("lsp_type_hierarchy", |c| async move {
        lsp_type_hierarchy(&c.host, &c.window, c.arg("doc")?, c.arg("pos")?, c.arg("direction")?).await
    });
    d.add("lsp_servers", |c| async move { lsp_servers(&c.host, &c.window) });
    d.add("lsp_restart", |c| async move { lsp_restart(&c.host, &c.window, c.arg("server")?).await });
    d.add("apply_workspace_edit", |c| async move { apply_workspace_edit(&c.host, &c.window, c.arg("edit")?) });
    d.add("lsp_execute_command", |c| async move {
        lsp_execute_command(&c.host, &c.window, c.arg("doc")?, c.arg("command")?).await
    });
}
