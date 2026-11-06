use super::doc::blocking;
use crate::Host;
use crate::apply_workspace_edit as apply_edit;
use crate::plugins::{ProviderKind, editor_providers_for as editor_providers};
use crate::rpc::Dispatcher;
use ide_core::{DocId, IdeResult, Location, Pos, Range, RequestId, ServerId, TextEdit, WorkspaceEdit};
use ide_lsp::types::*;
use ide_plugin::ProviderDocument;
use std::path::Path;

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
    let lsp = host.project(window)?.lsp.clone();
    let cancel = host.begin_request(request);
    let result = lsp.completion(doc, pos, trigger.clone(), cancel).await;
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
    data: Option<String>,
    /// Opened once the action is applied.
    open: Option<ide_core::IpcPath>,
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
    let lsp = host.project(window)?.lsp.clone();
    let cancel = host.begin_request(request);
    let result = lsp.inline_completion(doc, pos, automatic, cancel.clone()).await;
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
    if kind == GotoKind::Definition
        && let Some(plugins) = crate::plugins::editor_plugin_host()
    {
        let project = host.project(window)?;
        let (path, version) = project.documents.identity(doc)?;
        if let Some(found) = plugins.navigation_at(&project.root, &path, version, pos, Some(window), |p| {
            project.documents.by_path(p).and_then(|id| project.documents.version(id).ok())
        }) {
            return Ok(found.targets);
        }
    }
    let result = host.project(window)?.lsp.goto(doc, pos, kind).await;
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
    let lsp = host.project(window)?.lsp.clone();
    let cancel = host.begin_request(request);
    let result = lsp.implementations(doc, &positions, cancel).await;
    host.end_request(request);
    result
}

/// Go to Implementation of the symbol at `pos`. Implementations found before a slower
/// search for the rest (Java: the project's, before the dependencies') arrive on
/// `on_partial`; the result has them all. Cancel with `cancel_request(request)`.
pub async fn lsp_goto_implementation(
    host: &Host,
    window: &str,
    request: RequestId,
    doc: DocId,
    pos: Pos,
    on_partial: super::Channel<Vec<Location>>,
) -> IdeResult<Vec<Location>> {
    let lsp = host.project(window)?.lsp.clone();
    let cancel = host.begin_request(request);
    let result = lsp
        .goto_implementation(doc, pos, cancel, &|locs| {
            let _ = on_partial.send(locs);
        })
        .await;
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
    let project = host.project(window)?;
    let documents = project.documents.clone();
    let version = blocking(move || documents.version(doc)).await?;
    let result = project.lsp.code_actions(doc, range, only.clone()).await;
    let plugin_actions = match plugin_providers(host, window, doc, ProviderKind::CodeActions) {
        Some((plugins, d)) => plugin_call(move || plugins.provide_code_actions(&d, range)).await.unwrap_or_default(),
        None => Vec::new(),
    };
    let plugin_actions: Vec<CodeAction> = plugin_actions
        .into_iter()
        .map(|(plugin, a)| plugin_code_action(&plugin, &project.root, a))
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

fn plugin_code_action(plugin: &str, root: &Path, a: ide_plugin::CodeAction) -> CodeAction {
    // With `data` and nothing to apply, the plugin computes the edits when the action is picked.
    let lazy = a.edits.is_empty() && a.operations.is_empty() && a.data.is_some();
    let (files, open, disabled_reason) = match plugin_file_edits(root, &a) {
        Ok((files, open)) => (files, open, None),
        Err(reason) => (Vec::new(), None, Some(reason)),
    };
    let data = (lazy || open.is_some())
        .then(|| PluginActionRef {
            plugin: plugin.to_owned(),
            data: a.data.filter(|_| lazy),
            open: open.map(Into::into),
        })
        .and_then(|r| serde_json::to_value(r).ok());
    CodeAction {
        title: a.title,
        kind: a.kind,
        is_preferred: a.preferred,
        disabled_reason,
        edit: (!lazy).then(|| WorkspaceEdit { files, preconditions: Vec::new() }),
        command: None,
        data,
        server: PLUGIN_SERVER,
    }
}

/// The action's file operations, then its text edits, as one workspace edit's files, and the
/// file to open. An action with file operations or an `open` target stays inside the project
/// root as a whole: a path outside it disables the action.
fn plugin_file_edits(
    root: &Path,
    a: &ide_plugin::CodeAction,
) -> Result<(Vec<ide_core::FileEdit>, Option<std::path::PathBuf>), String> {
    use ide_core::FileEdit;
    use ide_plugin::FileOperation;
    let confine = !a.operations.is_empty() || a.open.is_some();
    let confined = |path: &Path| ide_plugin::resolve_new_in_root(root, &path.to_string_lossy());
    let mut files = Vec::new();
    let mut created_with_text = Vec::new();
    for operation in &a.operations {
        match operation {
            FileOperation::Create { path, text, overwrite } => {
                let path = confined(path)?;
                files.push(FileEdit::Create { path: path.clone().into(), overwrite: *overwrite });
                if !text.is_empty() {
                    let start = Range::point(Pos::new(0, 0));
                    files.push(FileEdit::Edit {
                        path: path.clone().into(),
                        edits: vec![TextEdit { range: start, new_text: text.clone() }],
                        version: None,
                    });
                    created_with_text.push(path);
                }
            }
            FileOperation::Rename { from, to } => {
                files.push(FileEdit::Rename { from: confined(from)?.into(), to: confined(to)?.into() });
            }
            FileOperation::Delete { path } => {
                files.push(FileEdit::Delete { path: confined(path)?.into(), recursive: false });
            }
        }
    }
    for (path, edits) in &a.edits {
        let path = if confine { confined(path)? } else { path.clone() };
        if created_with_text.contains(&path) {
            return Err("put the text of a created file in its `create`, not in an edit".into());
        }
        files.push(FileEdit::Edit { path: path.into(), edits: edits.clone(), version: None });
    }
    let open = a.open.as_deref().map(confined).transpose()?;
    Ok((files, open))
}

/// A code action resolved by whoever offered it: its language server, or
/// the plugin its `data` names.
async fn resolve_action(host: &Host, window: &str, doc: DocId, action: CodeAction) -> IdeResult<CodeAction> {
    if action.server != PLUGIN_SERVER {
        return host.project(window)?.lsp.resolve_code_action(doc, action).await;
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
        operations: Vec::new(),
        open: None,
        data: r.data,
    };
    let plugin = r.plugin.clone();
    let resolved = blocking(move || plugins.resolve_code_action(&plugin, &d, pending)).await?;
    let root = host.project(window)?.root.clone();
    Ok(plugin_code_action(&r.plugin, &root, ide_plugin::CodeAction { data: None, ..resolved }))
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
    let result = project.lsp.code_action_query(doc, range, only, cancel).await;
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
    if let Some(reason) = &action.disabled_reason {
        return Err(ide_core::IdeError::invalid(reason.clone()));
    }
    if let Some(edit) = &action.edit {
        let documents = project.documents.clone();
        let edit = edit.clone();
        blocking(move || apply_edit(&documents, &edit)).await?;
    }
    open_plugin_action_target(&action, window);
    if let Some(command) = action.command
        && !(action.edit.is_some() && is_client_follow_up(&project, doc, None, &command).await)
    {
        project.lsp.execute_command(doc, command).await?;
    }
    Ok(())
}

/// Opens the file a plugin's action asked to show, now that the action is applied.
fn open_plugin_action_target(action: &CodeAction, window: &str) {
    if action.server != PLUGIN_SERVER {
        return;
    }
    let Some(r) = action.data.clone().and_then(|d| serde_json::from_value::<PluginActionRef>(d).ok()) else {
        return;
    };
    let (Some(path), Some(plugins)) = (r.open, crate::plugins::editor_plugin_host()) else {
        return;
    };
    plugins.open_file(&r.plugin, window, path);
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
    host.project(window)?.lsp.prepare_rename(doc, pos).await
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
    let result = project.lsp.rename(doc, pos, new_name, cancel).await;
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
    request: RequestId,
    doc: DocId,
    pos: Pos,
    direction: HierarchyDirection,
) -> IdeResult<CallHierarchy> {
    let lsp = host.project(window)?.lsp.clone();
    let cancel = host.begin_request(request);
    let result = lsp.call_hierarchy(doc, pos, direction, cancel).await;
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
    host.project(window)?.lsp.type_hierarchy(doc, pos, direction).await
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
    d.add("lsp_goto_implementation", |c| async move {
        let on_partial = c.sender("onPartial")?;
        lsp_goto_implementation(&c.host, &c.window, c.arg("request")?, c.arg("doc")?, c.arg("pos")?, on_partial).await
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
            operations: Vec::new(),
            open: None,
            data: data.map(str::to_owned),
        };
        let root = Path::new("/p");
        let lazy = plugin_code_action("acme.x", root, action(Vec::new(), Some("ref")));
        assert!(lazy.edit.is_none());
        let r: PluginActionRef = serde_json::from_value(lazy.data.unwrap()).unwrap();
        assert_eq!((r.plugin.as_str(), r.data.as_deref()), ("acme.x", Some("ref")));
        // With edits, `data` is the plugin's business: applied as is.
        let edit = TextEdit { range: Range::default(), new_text: "x".into() };
        let eager = plugin_code_action("acme.x", root, action(vec![("/a".into(), vec![edit])], Some("ref")));
        assert!(eager.edit.is_some() && eager.data.is_none());
    }

    #[test]
    fn a_plugin_action_maps_its_file_operations_before_its_edits_and_stays_in_the_project() {
        use ide_core::FileEdit;
        use ide_plugin::FileOperation;
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("proj");
        std::fs::create_dir_all(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let action = |operations: Vec<FileOperation>| ide_plugin::CodeAction {
            title: "Create view".into(),
            kind: Some("quickfix".into()),
            preferred: false,
            edits: vec![(root.join("a.txt"), vec![TextEdit { range: Range::default(), new_text: "x".into() }])],
            operations,
            open: Some(root.join("views/home.html")),
            data: None,
        };

        let created = plugin_code_action(
            "acme.x",
            &root,
            action(vec![
                FileOperation::Create { path: "views/home.html".into(), text: "<h1/>".into(), overwrite: false },
                FileOperation::Rename { from: root.join("old.txt"), to: root.join("new.txt") },
                FileOperation::Delete { path: root.join("gone.txt") },
            ]),
        );
        assert_eq!(created.disabled_reason, None);
        let files = created.edit.unwrap().files;
        let home = root.join("views/home.html");
        assert!(matches!(&files[0], FileEdit::Create { path, overwrite: false } if **path == home));
        assert!(
            matches!(&files[1], FileEdit::Edit { path, edits, .. } if **path == home && edits[0].new_text == "<h1/>")
        );
        assert!(matches!(&files[2], FileEdit::Rename { to, .. } if **to == root.join("new.txt")));
        assert!(matches!(&files[3], FileEdit::Delete { recursive: false, .. }));
        assert!(matches!(&files[4], FileEdit::Edit { path, .. } if **path == root.join("a.txt")));
        let r: PluginActionRef = serde_json::from_value(created.data.unwrap()).unwrap();
        assert_eq!(r.data, None);
        let opened = r.open.unwrap().to_path_buf();
        assert!(opened.components().eq(dunce::simplified(&home).components()), "{opened:?}");

        let outside = tmp.path().join("evil.txt");
        let mut open_outside = action(Vec::new());
        open_outside.open = Some(outside.clone());
        assert!(plugin_code_action("acme.x", &root, open_outside).disabled_reason.is_some());
        let mut edit_outside = action(vec![FileOperation::Delete { path: root.join("gone.txt") }]);
        edit_outside.edits.push((outside, Vec::new()));
        assert!(plugin_code_action("acme.x", &root, edit_outside).disabled_reason.is_some());
        let mut edit_created =
            action(vec![FileOperation::Create { path: root.join("n.txt"), text: "x".into(), overwrite: false }]);
        edit_created.edits = vec![(root.join("n.txt"), Vec::new())];
        assert!(plugin_code_action("acme.x", &root, edit_created).disabled_reason.is_some());

        for outside in [tmp.path().join("evil.txt"), "../evil.txt".into()] {
            for operation in [
                FileOperation::Create { path: outside.clone(), text: String::new(), overwrite: false },
                FileOperation::Rename { from: root.join("old.txt"), to: outside.clone() },
                FileOperation::Delete { path: outside.clone() },
            ] {
                let rejected = plugin_code_action("acme.x", &root, action(vec![operation]));
                assert!(rejected.disabled_reason.is_some_and(|r| r.contains("outside the project root")));
                assert!(rejected.edit.unwrap().files.is_empty());
            }
        }
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
