use super::doc::blocking;
use crate::Host;
use crate::apply_workspace_edit as apply_edit;
use crate::language_service::{ask, ask_all};
use crate::plugins::{ProviderKind, editor_providers_for as editor_providers};
use crate::rpc::Dispatcher;
use ide_core::{DocId, IdeResult, Location, Pos, Range, RequestId, ServerId, TextEdit, WorkspaceEdit};
use ide_lsp::types::*;
use ide_plugin::ProviderDocument;

async fn prepare_actions(
    project: std::sync::Arc<crate::Project>,
    doc: DocId,
    version: u32,
    mut actions: Vec<CodeAction>,
) -> IdeResult<Vec<CodeAction>> {
    blocking(move || {
        if project.documents.version(doc)? != version {
            return Err(ide_core::IdeError::new(
                ide_core::error::ErrorKind::OutOfSync,
                "document changed while computing code actions; request them again",
            ));
        }
        for action in &mut actions {
            if let Some(edit) = &mut action.edit {
                project.documents.prepare_workspace_edit(edit)?;
            }
        }
        Ok(actions)
    })
    .await
}

pub async fn lsp_completion(
    host: &Host,
    window: &str,
    request: RequestId,
    doc: DocId,
    pos: Pos,
    trigger: Option<String>,
) -> IdeResult<CompletionList> {
    let project = host.project(window)?;
    let cancel = host.begin_request(request);
    let native = {
        let (trigger, cancel) = (trigger.clone(), cancel.clone());
        ask(&project, doc, move |s| s.completion(doc, pos, trigger.as_deref(), &cancel)).await
    };
    let result = match native {
        Some(result) => result,
        None => project.lsp.completion(doc, pos, trigger.clone(), cancel).await,
    };
    host.end_request(request);
    // Plugin providers (`[[contributes.providers]]`) add theirs.
    let Some((plugins, d)) = plugin_providers(host, window, doc, ProviderKind::Completion) else { return result };
    let items = plugin_call(move || plugins.provide_completion(&d, pos, trigger.as_deref())).await.unwrap_or_default();
    if items.is_empty() {
        return result;
    }
    let mut list = result.unwrap_or(CompletionList { is_incomplete: false, items: Vec::new() });
    list.items.extend(items.into_iter().map(|(_, item)| plugin_completion(item)));
    Ok(list)
}

/// The plugin host and the document, when some plugin provides `kind`.
fn plugin_providers(
    host: &Host,
    window: &str,
    doc: DocId,
    kind: ProviderKind,
) -> Option<(std::sync::Arc<crate::plugins::PluginHost>, ProviderDocument)> {
    let plugins = editor_providers(kind)?;
    let snap = host.project(window).ok()?.documents.snapshot(doc).ok()?;
    let d = ProviderDocument {
        path: snap.path.0,
        language: snap.language.0,
        version: u64::from(snap.version),
        text: snap.text,
    };
    Some((plugins, d))
}

/// Plugin calls block (the plugin's actor thread does the work).
async fn plugin_call<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Option<T> {
    tokio::task::spawn_blocking(f).await.ok()
}

/// Items from plugins carry no server: commands don't apply, and a code
/// action is resolved by the plugin named in its `data` ([`PluginActionRef`]).
const PLUGIN_SERVER: ServerId = ServerId(0);

/// `data` of a plugin's code action whose edits it computes when picked.
#[derive(serde::Serialize, serde::Deserialize)]
struct PluginActionRef {
    plugin: String,
    data: String,
}

/// A plugin's `completion-item.kind` (wit/providers.wit lists them).
fn plugin_completion_kind(kind: &str) -> Option<CompletionKind> {
    Some(match kind {
        "text" => CompletionKind::Text,
        "method" => CompletionKind::Method,
        "function" => CompletionKind::Function,
        "constructor" => CompletionKind::Constructor,
        "field" => CompletionKind::Field,
        "variable" => CompletionKind::Variable,
        "class" => CompletionKind::Class,
        "interface" => CompletionKind::Interface,
        "module" => CompletionKind::Module,
        "property" => CompletionKind::Property,
        "unit" => CompletionKind::Unit,
        "value" => CompletionKind::Value,
        "enum" => CompletionKind::Enum,
        "keyword" => CompletionKind::Keyword,
        "snippet" => CompletionKind::Snippet,
        "color" => CompletionKind::Color,
        "file" => CompletionKind::File,
        "reference" => CompletionKind::Reference,
        "folder" => CompletionKind::Folder,
        "enum-member" => CompletionKind::EnumMember,
        "constant" => CompletionKind::Constant,
        "struct" => CompletionKind::Struct,
        "event" => CompletionKind::Event,
        "operator" => CompletionKind::Operator,
        "type-parameter" => CompletionKind::TypeParameter,
        _ => return None,
    })
}

fn plugin_completion(item: ide_plugin::CompletionItem) -> CompletionItem {
    let kind = item.kind.as_deref().and_then(plugin_completion_kind);
    CompletionItem {
        label: item.label,
        label_detail: None,
        detail: item.detail,
        kind,
        documentation: item.documentation.map(|value| Markup { kind: "markdown".into(), value }),
        sort_text: item.sort_text,
        filter_text: item.filter_text,
        preselect: false,
        deprecated: false,
        insert_text: item.insert_text,
        is_snippet: item.snippet,
        replace_range: item.replace,
        replace_range_tab: None,
        additional_edits: item.additional_edits,
        commit_characters: Vec::new(),
        command: None,
        data: None,
        server: PLUGIN_SERVER,
    }
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
    let project = host.project(window)?;
    let cancel = host.begin_request(request);
    let native = {
        let cancel = cancel.clone();
        ask(&project, doc, move |s| s.inline_completion(doc, pos, automatic, &cancel)).await
    };
    let result = match native {
        Some(result) => result,
        None => project.lsp.inline_completion(doc, pos, automatic, cancel.clone()).await,
    };
    // Plugins: cancelled (cooperatively) when the editor cancels the request.
    let plugin = match plugin_providers(host, window, doc, ProviderKind::InlineCompletion) {
        Some((plugins, d)) if !matches!(&result, Ok(items) if !items.is_empty()) => {
            let cancel = cancel.clone();
            plugin_call(move || plugins.provide_inline_completion(&d, pos, &cancel)).await.flatten()
        }
        _ => None,
    };
    host.end_request(request);
    match plugin {
        Some((_, s)) => Ok(vec![InlineCompletionItem {
            insert_text: s.insert_text,
            range: s.replace,
            filter_text: None,
            command: None,
            server: PLUGIN_SERVER,
        }]),
        None => result,
    }
}

pub async fn lsp_resolve_completion(
    host: &Host,
    window: &str,
    doc: DocId,
    item: CompletionItem,
) -> IdeResult<CompletionItem> {
    let project = host.project(window)?;
    let native = {
        let item = item.clone();
        ask(&project, doc, move |s| s.resolve_completion(doc, &item)).await
    };
    match native {
        Some(result) => result,
        None => project.lsp.resolve_completion(doc, item).await,
    }
}

pub async fn lsp_hover(
    host: &Host,
    window: &str,
    request: RequestId,
    doc: DocId,
    pos: Pos,
) -> IdeResult<Option<Hover>> {
    let project = host.project(window)?;
    let cancel = host.begin_request(request);
    let native = {
        let cancel = cancel.clone();
        ask(&project, doc, move |s| s.hover(doc, pos, &cancel)).await
    };
    let result = match native {
        Some(result) => result,
        None => project.lsp.hover(doc, pos, cancel).await,
    };
    host.end_request(request);
    result
}

pub async fn lsp_signature_help(host: &Host, window: &str, doc: DocId, pos: Pos) -> IdeResult<Option<SignatureHelp>> {
    let project = host.project(window)?;
    match ask(&project, doc, move |s| s.signature_help(doc, pos)).await {
        Some(result) => result,
        None => project.lsp.signature_help(doc, pos).await,
    }
}

pub async fn lsp_goto(host: &Host, window: &str, doc: DocId, pos: Pos, kind: GotoKind) -> IdeResult<Vec<Location>> {
    let project = host.project(window)?;
    let result = match ask(&project, doc, move |s| s.goto(doc, pos, kind)).await {
        Some(result) => result,
        None => project.lsp.goto(doc, pos, kind).await,
    };
    if kind != GotoKind::Definition {
        return result;
    }
    let Some((plugins, d)) = plugin_providers(host, window, doc, ProviderKind::Definition) else { return result };
    let found = plugin_call(move || plugins.provide_definition(&d, pos)).await.unwrap_or_default();
    if found.is_empty() {
        return result;
    }
    let mut out = result.unwrap_or_default();
    out.extend(found.into_iter().map(|l| Location { path: l.path.into(), range: l.range, uri: None }));
    Ok(out)
}

/// Gutter markers from plugins (`line-markers` providers) for `doc`.
pub async fn plugin_line_markers(
    host: &Host,
    window: &str,
    doc: DocId,
) -> IdeResult<Vec<crate::plugins::LineMarkerInfo>> {
    let Some((plugins, d)) = plugin_providers(host, window, doc, ProviderKind::LineMarkers) else {
        return Ok(Vec::new());
    };
    let markers = plugin_call(move || plugins.provide_line_markers(&d)).await.unwrap_or_default();
    Ok(markers
        .into_iter()
        .map(|(plugin_id, m)| crate::plugins::LineMarkerInfo {
            plugin_id,
            line: m.line,
            icon: m.icon,
            tooltip: m.tooltip,
            target: m.target.map(|l| Location { path: l.path.into(), range: l.range, uri: None }),
        })
        .collect())
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
    let project = host.project(window)?;
    let cancel = host.begin_request(request);
    let native = {
        let (positions, cancel) = (positions.clone(), cancel.clone());
        ask(&project, doc, move |s| s.implementations(doc, &positions, &cancel)).await
    };
    let result = match native {
        Some(result) => result,
        None => project.lsp.implementations(doc, &positions, cancel).await,
    };
    host.end_request(request);
    result
}

/// Contents of a read-only language-server document, including JDT library
/// classes and disk class files. Cached per project.
pub async fn lsp_virtual_document(host: &Host, window: &str, uri: String) -> IdeResult<VirtualDocument> {
    if uri.starts_with("git-revision:") {
        return crate::ops::vcs::revision_virtual_document(host, window, &uri).await;
    }
    host.project(window)?.lsp.virtual_document(&uri).await
}

/// Opens compiled classes through JDT, with project source taking priority on disk.
pub async fn lsp_resolve_class_file(host: &Host, window: &str, path: std::path::PathBuf) -> IdeResult<String> {
    let archive = ide_vfs::split_archive_path(&path);
    host.project(window)?.lsp.java_class_file(&path, archive).await
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
    let project = host.project(window)?;
    let cancel = host.begin_request(request);
    let native = {
        let cancel = cancel.clone();
        ask(&project, doc, move |s| s.references(doc, pos, include_declaration, project_wide, &cancel)).await
    };
    let result = match native {
        Some(result) => result,
        None => project.lsp.references(doc, pos, include_declaration, project_wide, cancel).await,
    };
    host.end_request(request);
    result
}

pub async fn lsp_document_highlights(host: &Host, window: &str, doc: DocId, pos: Pos) -> IdeResult<Vec<Highlight>> {
    let project = host.project(window)?;
    match ask(&project, doc, move |s| s.document_highlights(doc, pos)).await {
        Some(result) => result,
        None => project.lsp.document_highlights(doc, pos).await,
    }
}

pub async fn lsp_workspace_symbols(
    host: &Host,
    window: &str,
    request: RequestId,
    query: String,
) -> IdeResult<Vec<WorkspaceSymbol>> {
    let project = host.project(window)?;
    let cancel = host.begin_request(request);
    // Not tied to a language: the services' symbols join the language servers'.
    let native = {
        let (query, cancel) = (query.clone(), cancel.clone());
        ask_all(&project, move |s| s.workspace_symbols(&query, &cancel)).await
    };
    let result = project.lsp.workspace_symbols(&query, cancel).await;
    host.end_request(request);
    merge_symbols(native, result)
}

/// The services' symbols, then the language servers' (an error only when every answer failed).
fn merge_symbols(
    native: Vec<IdeResult<Vec<WorkspaceSymbol>>>,
    lsp: IdeResult<Vec<WorkspaceSymbol>>,
) -> IdeResult<Vec<WorkspaceSymbol>> {
    if native.is_empty() {
        return lsp;
    }
    let mut out = Vec::new();
    let mut error = None;
    for answer in native.into_iter().chain([lsp]) {
        match answer {
            Ok(symbols) => out.extend(symbols),
            Err(e) => error = error.or(Some(e)),
        }
    }
    match error {
        Some(e) if out.is_empty() => Err(e),
        _ => Ok(out),
    }
}

pub async fn lsp_code_actions(
    host: &Host,
    window: &str,
    doc: DocId,
    range: Range,
    only: Vec<String>,
) -> IdeResult<Vec<CodeAction>> {
    let project = host.project(window)?;
    let documents = project.documents.clone();
    let version = blocking(move || documents.version(doc)).await?;
    let native = {
        let only = only.clone();
        ask(&project, doc, move |s| s.code_actions(doc, range, &only)).await
    };
    let result = match native {
        Some(result) => result,
        None => project.lsp.code_actions(doc, range, only.clone()).await,
    };
    let plugin_actions = match plugin_providers(host, window, doc, ProviderKind::CodeActions) {
        Some((plugins, d)) => plugin_call(move || plugins.provide_code_actions(&d, range)).await.unwrap_or_default(),
        None => Vec::new(),
    };
    let plugin_actions: Vec<CodeAction> = plugin_actions
        .into_iter()
        .map(|(plugin, a)| plugin_code_action(&plugin, a))
        .filter(|a| {
            only.is_empty()
                || a.kind.as_ref().is_some_and(|k| only.iter().any(|o| k == o || k.starts_with(&format!("{o}."))))
        })
        .collect();
    let actions = if plugin_actions.is_empty() {
        result?
    } else {
        let mut out = result.unwrap_or_default();
        out.extend(plugin_actions);
        out
    };
    prepare_actions(project, doc, version, actions).await
}

fn plugin_code_action(plugin: &str, a: ide_plugin::CodeAction) -> CodeAction {
    // With `data` and no edits, the plugin computes them when the action is picked.
    let lazy = a.edits.is_empty() && a.data.is_some();
    let files: Vec<_> = a
        .edits
        .into_iter()
        .map(|(path, edits)| ide_core::FileEdit::Edit { path: path.into(), edits, version: None })
        .collect();
    let data = a
        .data
        .filter(|_| lazy)
        .and_then(|data| serde_json::to_value(PluginActionRef { plugin: plugin.to_owned(), data }).ok());
    CodeAction {
        title: a.title,
        kind: a.kind,
        is_preferred: a.preferred,
        disabled_reason: None,
        edit: (!lazy).then(|| WorkspaceEdit { files, preconditions: Vec::new() }),
        command: None,
        data,
        server: PLUGIN_SERVER,
    }
}

/// A code action resolved by whoever offered it: the in-process language
/// service, its language server, or
/// the plugin its `data` names.
async fn resolve_action(host: &Host, window: &str, doc: DocId, action: CodeAction) -> IdeResult<CodeAction> {
    if action.server != PLUGIN_SERVER {
        let project = host.project(window)?;
        let native = {
            let action = action.clone();
            ask(&project, doc, move |s| s.resolve_code_action(doc, &action, &ide_core::CancellationToken::new())).await
        };
        if let Some(resolved) = native {
            return resolved;
        }
        return project.lsp.resolve_code_action(doc, action).await;
    }
    let Some(r) = action.data.clone().and_then(|d| serde_json::from_value::<PluginActionRef>(d).ok()) else {
        return Ok(action);
    };
    let (plugins, d) = plugin_providers(host, window, doc, ProviderKind::CodeActions)
        .ok_or_else(|| ide_core::IdeError::unavailable("the plugin that offered this action is gone"))?;
    let pending = ide_plugin::CodeAction {
        title: action.title.clone(),
        kind: action.kind.clone(),
        preferred: action.is_preferred,
        edits: Vec::new(),
        data: Some(r.data),
    };
    let plugin = r.plugin.clone();
    let resolved = blocking(move || plugins.resolve_code_action(&plugin, &d, pending)).await?;
    Ok(plugin_code_action(&r.plugin, ide_plugin::CodeAction { data: None, ..resolved }))
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
    let project = host.project(window)?;
    let documents = project.documents.clone();
    let version = blocking(move || documents.version(doc)).await?;
    let cancel = host.begin_request(request);
    let native = {
        let (only, cancel) = (only.clone(), cancel.clone());
        ask(&project, doc, move |s| s.code_action_query(doc, range, &only, &cancel)).await
    };
    let result = match native {
        Some(result) => result,
        None => project.lsp.code_action_query(doc, range, only, cancel).await,
    };
    host.end_request(request);
    let mut result = result?;
    result.actions = prepare_actions(project, doc, version, result.actions).await?;
    Ok(result)
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
    let project = host.project(window)?;
    let documents = project.documents.clone();
    let version = blocking(move || documents.version(doc)).await?;
    let action = resolve_action(host, window, doc, action).await?;
    Ok(prepare_actions(project, doc, version, vec![action]).await?.remove(0))
}

/// Resolves (if needed), applies the edit, then runs the command of a code action.
pub async fn lsp_apply_code_action(host: &Host, window: &str, doc: DocId, action: CodeAction) -> IdeResult<()> {
    let project = host.project(window)?;
    let action = if action.edit.is_none() && action.command.is_none() {
        let documents = project.documents.clone();
        let version = blocking(move || documents.version(doc)).await?;
        let action = resolve_action(host, window, doc, action).await?;
        prepare_actions(project.clone(), doc, version, vec![action]).await?.remove(0)
    } else {
        action
    };
    if let Some(edit) = &action.edit {
        let documents = project.documents.clone();
        let edit = edit.clone();
        blocking(move || apply_edit(&documents, &edit)).await?;
    }
    if let Some(command) = action.command
        && !(action.edit.is_some() && is_client_follow_up(&project, doc, None, &command).await)
    {
        project.lsp.execute_command(doc, command).await?;
    }
    Ok(())
}

/// A command after a code action's edit that no server provides: what other editors'
/// extensions do once the edit is applied (vtsls' `_typescript.didOrganizeImports`). The edit
/// is the action; there is nothing to run.
async fn is_client_follow_up(
    project: &crate::project::Project,
    doc: DocId,
    server: Option<ide_core::ServerId>,
    command: &Command,
) -> bool {
    let provided = project.lsp.provides_command(doc, server, &command.command).await;
    if !provided {
        tracing::debug!("skipping `{}` after the code action's edit: no server provides it", command.command);
    }
    !provided
}

pub async fn lsp_prepare_rename(host: &Host, window: &str, doc: DocId, pos: Pos) -> IdeResult<Option<Range>> {
    let project = host.project(window)?;
    match ask(&project, doc, move |s| s.prepare_rename(doc, pos)).await {
        Some(result) => result,
        None => project.lsp.prepare_rename(doc, pos).await,
    }
}

/// Computes the rename edit without applying it, so the UI can preview conflicts.
/// The class at `pos` and the members a class-hierarchy refactoring can move.
pub async fn lsp_hierarchy_members(
    host: &Host,
    window: &str,
    request: RequestId,
    doc: DocId,
    pos: Pos,
    kind: HierarchyRefactoring,
) -> IdeResult<HierarchyMembers> {
    let project = host.project(window)?;
    let cancel = host.begin_request(request);
    let result = project.lsp.hierarchy_members(doc, pos, kind, cancel).await;
    host.end_request(request);
    result
}

/// Checks a class-hierarchy refactoring and computes its edit without applying it.
#[allow(clippy::too_many_arguments)]
pub async fn lsp_hierarchy_refactor(
    host: &Host,
    window: &str,
    request: RequestId,
    doc: DocId,
    pos: Pos,
    kind: HierarchyRefactoring,
    target: Option<String>,
    choices: Vec<HierarchyChoice>,
) -> IdeResult<HierarchyRefactored> {
    let project = host.project(window)?;
    let documents = project.documents.clone();
    let version = blocking(move || documents.version(doc)).await?;
    let cancel = host.begin_request(request);
    let result = project.lsp.hierarchy_refactor(doc, pos, kind, target, choices, cancel).await;
    host.end_request(request);
    let mut refactored = result?;
    blocking(move || {
        if project.documents.version(doc)? != version {
            return Err(ide_core::IdeError::new(
                ide_core::error::ErrorKind::OutOfSync,
                "document changed while computing the refactoring; request it again",
            ));
        }
        if let Some(edit) = &mut refactored.edit {
            project.documents.prepare_workspace_edit(edit)?;
        }
        Ok(refactored)
    })
    .await
}

pub async fn lsp_rename(
    host: &Host,
    window: &str,
    request: RequestId,
    doc: DocId,
    pos: Pos,
    new_name: String,
) -> IdeResult<Renamed> {
    let project = host.project(window)?;
    let documents = project.documents.clone();
    let version = blocking(move || documents.version(doc)).await?;
    let cancel = host.begin_request(request);
    let native = {
        let (new_name, cancel) = (new_name.clone(), cancel.clone());
        ask(&project, doc, move |s| s.rename(doc, pos, &new_name, &cancel)).await
    };
    let result = match native {
        Some(result) => result,
        None => project.lsp.rename(doc, pos, new_name, cancel).await,
    };
    host.end_request(request);
    let mut renamed = result?;
    blocking(move || {
        if project.documents.version(doc)? != version {
            return Err(ide_core::IdeError::new(
                ide_core::error::ErrorKind::OutOfSync,
                "document changed while computing rename; request it again",
            ));
        }
        project.documents.prepare_workspace_edit(&mut renamed.edit)?;
        Ok(renamed)
    })
    .await
}

pub async fn lsp_format(
    host: &Host,
    window: &str,
    doc: DocId,
    range: Option<Range>,
    options: FormatOptions,
) -> IdeResult<Vec<TextEdit>> {
    crate::formatter::format(host, window, doc, range, options).await
}

pub async fn lsp_inlay_hints(host: &Host, window: &str, doc: DocId, range: Range) -> IdeResult<Vec<InlayHint>> {
    let project = host.project(window)?;
    match ask(&project, doc, move |s| s.inlay_hints(doc, range)).await {
        Some(result) => result,
        None => project.lsp.inlay_hints(doc, range).await,
    }
}

pub async fn lsp_semantic_tokens(host: &Host, window: &str, doc: DocId) -> IdeResult<Option<SemanticTokens>> {
    let project = host.project(window)?;
    match ask(&project, doc, move |s| s.semantic_tokens(doc)).await {
        Some(result) => result,
        None => project.lsp.semantic_tokens(doc).await,
    }
}

pub async fn lsp_code_lens(host: &Host, window: &str, doc: DocId) -> IdeResult<Vec<CodeLens>> {
    let project = host.project(window)?;
    match ask(&project, doc, move |s| s.code_lens(doc)).await {
        Some(result) => result,
        None => project.lsp.code_lens(doc).await,
    }
}

/// Links in a document (`href`s, Markdown links, `#include`s…) from its language servers.
pub async fn lsp_document_links(host: &Host, window: &str, doc: DocId) -> IdeResult<Vec<DocumentLink>> {
    let project = host.project(window)?;
    match ask(&project, doc, move |s| s.document_links(doc)).await {
        Some(result) => result,
        None => project.lsp.document_links(doc).await,
    }
}

pub async fn lsp_call_hierarchy(
    host: &Host,
    window: &str,
    request: RequestId,
    doc: DocId,
    pos: Pos,
    direction: HierarchyDirection,
) -> IdeResult<CallHierarchy> {
    let project = host.project(window)?;
    let cancel = host.begin_request(request);
    let native = {
        let cancel = cancel.clone();
        ask(&project, doc, move |s| s.call_hierarchy(doc, pos, direction, &cancel)).await
    };
    let result = match native {
        Some(result) => result,
        None => project.lsp.call_hierarchy(doc, pos, direction, cancel).await,
    };
    host.end_request(request);
    result
}

pub async fn lsp_type_hierarchy(
    host: &Host,
    window: &str,
    doc: DocId,
    pos: Pos,
    direction: HierarchyDirection,
) -> IdeResult<Vec<HierarchyItem>> {
    let project = host.project(window)?;
    match ask(&project, doc, move |s| s.type_hierarchy(doc, pos, direction)).await {
        Some(result) => result,
        None => project.lsp.type_hierarchy(doc, pos, direction).await,
    }
}

pub fn lsp_servers(host: &Host, window: &str) -> IdeResult<Vec<ServerInfo>> {
    Ok(host.project(window)?.lsp.servers())
}

pub fn lsp_resend_diagnostics(host: &Host, window: &str) -> IdeResult<()> {
    host.project(window)?.lsp.resend_diagnostics();
    Ok(())
}

pub async fn lsp_restart(host: &Host, window: &str, server: ServerId) -> IdeResult<()> {
    let project = host.project(window)?;
    let java = project.lsp.servers().iter().any(|s| s.id == server && s.name == "jdtls");
    project.lsp.restart(server).await?;
    if java && let Some(bridge) = &project.kotlin_bridge {
        bridge.schedule();
    }
    Ok(())
}

/// Applies a (previewed) workspace edit, e.g. after rename confirmation.
pub async fn apply_workspace_edit(host: &Host, window: &str, edit: WorkspaceEdit) -> IdeResult<()> {
    let project = host.project(window)?;
    blocking(move || {
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
    })
    .await
}

pub async fn prepare_workspace_edit(host: &Host, window: &str, mut edit: WorkspaceEdit) -> IdeResult<WorkspaceEdit> {
    let project = host.project(window)?;
    blocking(move || {
        project.documents.prepare_workspace_edit(&mut edit)?;
        Ok(edit)
    })
    .await
}

pub async fn undo_workspace_edit(host: &Host, window: &str, id: u32) -> IdeResult<()> {
    let project = host.project(window)?;
    blocking(move || project.documents.undo_workspace_edit(id)).await
}

pub async fn redo_workspace_edit(host: &Host, window: &str, id: u32) -> IdeResult<()> {
    let project = host.project(window)?;
    blocking(move || project.documents.redo_workspace_edit(id)).await
}

/// Runs a server command (`workspace/executeCommand`), e.g. a completion item's
/// follow-up command. Edits the server requests arrive via `workspace/applyEdit`.
pub async fn lsp_execute_command(host: &Host, window: &str, doc: DocId, command: Command) -> IdeResult<()> {
    host.project(window)?.lsp.execute_command(doc, command).await
}

/// Resolves an interactive command without applying edits or executing it.
pub async fn lsp_resolve_command(
    host: &Host,
    window: &str,
    request: RequestId,
    doc: DocId,
    server: ServerId,
    command: Command,
    answers: Vec<FormAnswer>,
) -> IdeResult<Option<CommandForm>> {
    let lsp = host.project(window)?.lsp.clone();
    let cancel = host.begin_request(request);
    let result = lsp.resolve_command(doc, server, command, answers, cancel).await;
    host.end_request(request);
    result
}

/// Applies an explicitly invoked action after the interactive answers have been validated.
pub async fn lsp_execute_code_action(
    host: &Host,
    window: &str,
    request: RequestId,
    doc: DocId,
    action: CodeAction,
    answers: Vec<FormAnswer>,
) -> IdeResult<Vec<ide_core::IpcPath>> {
    let project = host.project(window)?;
    let cancel = host.begin_request(request);
    let result = async {
        if cancel.is_cancelled() {
            return Err(ide_core::IdeError::cancelled());
        }
        let edited = action.edit.is_some();
        if let Some(edit) = action.edit {
            let documents = project.documents.clone();
            tokio::task::spawn_blocking(move || apply_edit(&documents, &edit))
                .await
                .map_err(|e| ide_core::IdeError::internal(e.to_string()))??;
        }
        match action.command {
            Some(command) if edited && is_client_follow_up(&project, doc, Some(action.server), &command).await => {
                Ok(Vec::new())
            }
            Some(command) => project
                .lsp
                .execute_action_command(doc, action.server, command, answers, cancel)
                .await
                .map(|paths| paths.into_iter().map(ide_core::IpcPath::from).collect()),
            None => Ok(Vec::new()),
        }
    }
    .await;
    host.end_request(request);
    result
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
    d.add(
        "lsp_resolve_class_file",
        |c| async move { lsp_resolve_class_file(&c.host, &c.window, c.arg("path")?).await },
    );
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
        lsp_rename(&c.host, &c.window, c.arg("request")?, c.arg("doc")?, c.arg("pos")?, c.arg("newName")?).await
    });
    d.add("lsp_hierarchy_members", |c| async move {
        lsp_hierarchy_members(&c.host, &c.window, c.arg("request")?, c.arg("doc")?, c.arg("pos")?, c.arg("kind")?).await
    });
    d.add("lsp_hierarchy_refactor", |c| async move {
        lsp_hierarchy_refactor(
            &c.host,
            &c.window,
            c.arg("request")?,
            c.arg("doc")?,
            c.arg("pos")?,
            c.arg("kind")?,
            c.arg("target")?,
            c.arg("choices")?,
        )
        .await
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
        lsp_call_hierarchy(&c.host, &c.window, c.arg("request")?, c.arg("doc")?, c.arg("pos")?, c.arg("direction")?)
            .await
    });
    d.add("lsp_type_hierarchy", |c| async move {
        lsp_type_hierarchy(&c.host, &c.window, c.arg("doc")?, c.arg("pos")?, c.arg("direction")?).await
    });
    d.add("lsp_servers", |c| async move { lsp_servers(&c.host, &c.window) });
    d.add("lsp_resend_diagnostics", |c| async move { lsp_resend_diagnostics(&c.host, &c.window) });
    d.add("lsp_restart", |c| async move { lsp_restart(&c.host, &c.window, c.arg("server")?).await });
    d.add("apply_workspace_edit", |c| async move { apply_workspace_edit(&c.host, &c.window, c.arg("edit")?).await });
    d.add("lsp_resolve_command", |c| async move {
        lsp_resolve_command(
            &c.host,
            &c.window,
            c.arg("request")?,
            c.arg("doc")?,
            c.arg("server")?,
            c.arg("command")?,
            c.arg("answers")?,
        )
        .await
    });
    d.add("lsp_execute_code_action", |c| async move {
        lsp_execute_code_action(
            &c.host,
            &c.window,
            c.arg("request")?,
            c.arg("doc")?,
            c.arg("action")?,
            c.arg("answers")?,
        )
        .await
    });
    d.add(
        "prepare_workspace_edit",
        |c| async move { prepare_workspace_edit(&c.host, &c.window, c.arg("edit")?).await },
    );
    d.add("redo_workspace_edit", |c| async move { redo_workspace_edit(&c.host, &c.window, c.arg("id")?).await });
    d.add("undo_workspace_edit", |c| async move { undo_workspace_edit(&c.host, &c.window, c.arg("id")?).await });
    d.add("lsp_execute_command", |c| async move {
        lsp_execute_command(&c.host, &c.window, c.arg("doc")?, c.arg("command")?).await
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_plugin_action_with_data_and_no_edits_is_resolved_by_its_plugin() {
        let action = |edits: Vec<(std::path::PathBuf, Vec<TextEdit>)>, data: Option<&str>| ide_plugin::CodeAction {
            title: "Fix".into(),
            kind: None,
            preferred: false,
            edits,
            data: data.map(str::to_owned),
        };
        let lazy = plugin_code_action("acme.x", action(Vec::new(), Some("ref")));
        assert!(lazy.edit.is_none());
        let r: PluginActionRef = serde_json::from_value(lazy.data.unwrap()).unwrap();
        assert_eq!((r.plugin.as_str(), r.data.as_str()), ("acme.x", "ref"));
        // With edits, `data` is the plugin's business: applied as is.
        let edit = TextEdit { range: Range::default(), new_text: "x".into() };
        let eager = plugin_code_action("acme.x", action(vec![("/a".into(), vec![edit])], Some("ref")));
        assert!(eager.edit.is_some() && eager.data.is_none());
    }

    #[test]
    fn every_completion_kind_the_plugin_api_documents_is_understood() {
        let wit = include_str!("../../../../wit/providers.wit");
        let doc: String = wit
            .lines()
            .map(|l| l.trim().trim_start_matches("///").trim())
            .skip_while(|l| !l.starts_with("Icon and sort group:"))
            .take_while(|l| !l.starts_with("kind:"))
            .collect::<Vec<_>>()
            .join(" ");
        let list = doc.strip_prefix("Icon and sort group:").unwrap().split(". Unknown").next().unwrap();
        let list = list.replace(" or ", ", ");
        let kinds: Vec<&str> = list.split(',').map(str::trim).filter(|k| !k.is_empty()).collect();
        assert_eq!(kinds.len(), 25, "{kinds:?}");
        for k in kinds {
            assert!(plugin_completion_kind(k).is_some(), "{k:?}");
        }
        assert_eq!(plugin_completion_kind("nonsense"), None);
    }
}
