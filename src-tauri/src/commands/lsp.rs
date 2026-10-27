//! IPC commands of `ide_host::ops::lsp` (the shared implementation).

use crate::state::AppState;
use ide_core::{DocId, IdeResult, Location, Pos, Range, RequestId, ServerId, TextEdit, WorkspaceEdit};
#[allow(unused_imports)]
pub use ide_host::ops::lsp::*;
use ide_lsp::types::*;
use tauri::{State, Window};

#[tauri::command]
#[specta::specta]
pub async fn lsp_completion(
    window: Window,
    state: State<'_, AppState>,
    request: RequestId,
    doc: DocId,
    pos: Pos,
    trigger: Option<String>,
) -> IdeResult<CompletionList> {
    ide_host::ops::lsp::lsp_completion(&state.host, window.label(), request, doc, pos, trigger).await
}

/// Inline (ghost text) suggestions at `pos`; `automatic` when triggered by typing.
#[tauri::command]
#[specta::specta]
pub async fn lsp_inline_completion(
    window: Window,
    state: State<'_, AppState>,
    request: RequestId,
    doc: DocId,
    pos: Pos,
    automatic: bool,
) -> IdeResult<Vec<InlineCompletionItem>> {
    ide_host::ops::lsp::lsp_inline_completion(&state.host, window.label(), request, doc, pos, automatic).await
}

#[tauri::command]
#[specta::specta]
pub async fn lsp_resolve_completion(
    window: Window,
    state: State<'_, AppState>,
    doc: DocId,
    item: CompletionItem,
) -> IdeResult<CompletionItem> {
    ide_host::ops::lsp::lsp_resolve_completion(&state.host, window.label(), doc, item).await
}

#[tauri::command]
#[specta::specta]
pub async fn lsp_hover(
    window: Window,
    state: State<'_, AppState>,
    request: RequestId,
    doc: DocId,
    pos: Pos,
) -> IdeResult<Option<Hover>> {
    ide_host::ops::lsp::lsp_hover(&state.host, window.label(), request, doc, pos).await
}

#[tauri::command]
#[specta::specta]
pub async fn lsp_signature_help(
    window: Window,
    state: State<'_, AppState>,
    doc: DocId,
    pos: Pos,
) -> IdeResult<Option<SignatureHelp>> {
    ide_host::ops::lsp::lsp_signature_help(&state.host, window.label(), doc, pos).await
}

#[tauri::command]
#[specta::specta]
pub async fn lsp_goto(
    window: Window,
    state: State<'_, AppState>,
    doc: DocId,
    pos: Pos,
    kind: GotoKind,
) -> IdeResult<Vec<Location>> {
    ide_host::ops::lsp::lsp_goto(&state.host, window.label(), doc, pos, kind).await
}

/// Implementations of the symbols at `positions`, one list per position (the
/// editor's "is implemented / overridden" gutter markers). Cancel with
/// `cancel_request(request)`.
#[tauri::command]
#[specta::specta]
pub async fn lsp_implementations(
    window: Window,
    state: State<'_, AppState>,
    request: RequestId,
    doc: DocId,
    positions: Vec<Pos>,
) -> IdeResult<Vec<Vec<Location>>> {
    ide_host::ops::lsp::lsp_implementations(&state.host, window.label(), request, doc, positions).await
}

/// Contents of a virtual document (library class, decompiled code) that a
/// language server returned a non-`file:` URI for. Cached per project.
#[tauri::command]
#[specta::specta]
pub async fn lsp_virtual_document(
    window: Window,
    state: State<'_, AppState>,
    uri: String,
) -> IdeResult<VirtualDocument> {
    ide_host::ops::lsp::lsp_virtual_document(&state.host, window.label(), uri).await
}

/// References of the symbol at `pos`. `project_wide` also searches project files
/// outside the language server's analysis scope; bulk scans over many symbols
/// leave it off. Cancel with `cancel_request(request)`.
#[tauri::command]
#[specta::specta]
pub async fn lsp_references(
    window: Window,
    state: State<'_, AppState>,
    request: RequestId,
    doc: DocId,
    pos: Pos,
    include_declaration: bool,
    project_wide: bool,
) -> IdeResult<References> {
    ide_host::ops::lsp::lsp_references(
        &state.host,
        window.label(),
        request,
        doc,
        pos,
        include_declaration,
        project_wide,
    )
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn lsp_document_highlights(
    window: Window,
    state: State<'_, AppState>,
    doc: DocId,
    pos: Pos,
) -> IdeResult<Vec<Highlight>> {
    ide_host::ops::lsp::lsp_document_highlights(&state.host, window.label(), doc, pos).await
}

#[tauri::command]
#[specta::specta]
pub async fn lsp_workspace_symbols(
    window: Window,
    state: State<'_, AppState>,
    request: RequestId,
    query: String,
) -> IdeResult<Vec<WorkspaceSymbol>> {
    ide_host::ops::lsp::lsp_workspace_symbols(&state.host, window.label(), request, query).await
}

#[tauri::command]
#[specta::specta]
pub async fn lsp_code_actions(
    window: Window,
    state: State<'_, AppState>,
    doc: DocId,
    range: Range,
    only: Vec<String>,
) -> IdeResult<Vec<CodeAction>> {
    ide_host::ops::lsp::lsp_code_actions(&state.host, window.label(), doc, range, only).await
}

/// Cancellable code actions with the kinds the servers advertise (Refactor This, refactoring availability).
#[tauri::command]
#[specta::specta]
pub async fn lsp_code_action_query(
    window: Window,
    state: State<'_, AppState>,
    request: RequestId,
    doc: DocId,
    range: Range,
    only: Vec<String>,
) -> IdeResult<CodeActionQuery> {
    ide_host::ops::lsp::lsp_code_action_query(&state.host, window.label(), request, doc, range, only).await
}

/// Resolves a code action's edit without applying it (intention preview).
#[tauri::command]
#[specta::specta]
pub async fn lsp_resolve_code_action(
    window: Window,
    state: State<'_, AppState>,
    doc: DocId,
    action: CodeAction,
) -> IdeResult<CodeAction> {
    ide_host::ops::lsp::lsp_resolve_code_action(&state.host, window.label(), doc, action).await
}

/// Resolves (if needed), applies the edit, then runs the command of a code action.
#[tauri::command]
#[specta::specta]
pub async fn lsp_apply_code_action(
    window: Window,
    state: State<'_, AppState>,
    doc: DocId,
    action: CodeAction,
) -> IdeResult<()> {
    ide_host::ops::lsp::lsp_apply_code_action(&state.host, window.label(), doc, action).await
}

#[tauri::command]
#[specta::specta]
pub async fn lsp_prepare_rename(
    window: Window,
    state: State<'_, AppState>,
    doc: DocId,
    pos: Pos,
) -> IdeResult<Option<Range>> {
    ide_host::ops::lsp::lsp_prepare_rename(&state.host, window.label(), doc, pos).await
}

/// Computes the rename edit without applying it, so the UI can preview conflicts.
#[tauri::command]
#[specta::specta]
pub async fn lsp_rename(
    window: Window,
    state: State<'_, AppState>,
    doc: DocId,
    pos: Pos,
    new_name: String,
) -> IdeResult<WorkspaceEdit> {
    ide_host::ops::lsp::lsp_rename(&state.host, window.label(), doc, pos, new_name).await
}

#[tauri::command]
#[specta::specta]
pub async fn lsp_format(
    window: Window,
    state: State<'_, AppState>,
    doc: DocId,
    range: Option<Range>,
    options: FormatOptions,
) -> IdeResult<Vec<TextEdit>> {
    ide_host::ops::lsp::lsp_format(&state.host, window.label(), doc, range, options).await
}

#[tauri::command]
#[specta::specta]
pub async fn lsp_inlay_hints(
    window: Window,
    state: State<'_, AppState>,
    doc: DocId,
    range: Range,
) -> IdeResult<Vec<InlayHint>> {
    ide_host::ops::lsp::lsp_inlay_hints(&state.host, window.label(), doc, range).await
}

#[tauri::command]
#[specta::specta]
pub async fn lsp_semantic_tokens(
    window: Window,
    state: State<'_, AppState>,
    doc: DocId,
) -> IdeResult<Option<SemanticTokens>> {
    ide_host::ops::lsp::lsp_semantic_tokens(&state.host, window.label(), doc).await
}

#[tauri::command]
#[specta::specta]
pub async fn lsp_code_lens(window: Window, state: State<'_, AppState>, doc: DocId) -> IdeResult<Vec<CodeLens>> {
    ide_host::ops::lsp::lsp_code_lens(&state.host, window.label(), doc).await
}

/// Links in a document (`href`s, Markdown links, `#include`s…) from its language servers.
#[tauri::command]
#[specta::specta]
pub async fn lsp_document_links(
    window: Window,
    state: State<'_, AppState>,
    doc: DocId,
) -> IdeResult<Vec<DocumentLink>> {
    ide_host::ops::lsp::lsp_document_links(&state.host, window.label(), doc).await
}

#[tauri::command]
#[specta::specta]
pub async fn lsp_call_hierarchy(
    window: Window,
    state: State<'_, AppState>,
    doc: DocId,
    pos: Pos,
    direction: HierarchyDirection,
) -> IdeResult<Vec<HierarchyItem>> {
    ide_host::ops::lsp::lsp_call_hierarchy(&state.host, window.label(), doc, pos, direction).await
}

#[tauri::command]
#[specta::specta]
pub async fn lsp_type_hierarchy(
    window: Window,
    state: State<'_, AppState>,
    doc: DocId,
    pos: Pos,
    direction: HierarchyDirection,
) -> IdeResult<Vec<HierarchyItem>> {
    ide_host::ops::lsp::lsp_type_hierarchy(&state.host, window.label(), doc, pos, direction).await
}

#[tauri::command]
#[specta::specta]
pub fn lsp_servers(window: Window, state: State<'_, AppState>) -> IdeResult<Vec<ServerInfo>> {
    ide_host::ops::lsp::lsp_servers(&state.host, window.label())
}

#[tauri::command]
#[specta::specta]
pub async fn lsp_restart(window: Window, state: State<'_, AppState>, server: ServerId) -> IdeResult<()> {
    ide_host::ops::lsp::lsp_restart(&state.host, window.label(), server).await
}

/// Applies a (previewed) workspace edit, e.g. after rename confirmation.
#[tauri::command]
#[specta::specta]
pub fn apply_workspace_edit(window: Window, state: State<'_, AppState>, edit: WorkspaceEdit) -> IdeResult<()> {
    ide_host::ops::lsp::apply_workspace_edit(&state.host, window.label(), edit)
}

/// Runs a server command (`workspace/executeCommand`), e.g. a completion item's
/// follow-up command. Edits the server requests arrive via `workspace/applyEdit`.
#[tauri::command]
#[specta::specta]
pub async fn lsp_execute_command(
    window: Window,
    state: State<'_, AppState>,
    doc: DocId,
    command: Command,
) -> IdeResult<()> {
    ide_host::ops::lsp::lsp_execute_command(&state.host, window.label(), doc, command).await
}
