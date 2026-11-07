use super::doc::blocking;
use crate::Host;
use crate::apply_workspace_edit as apply_edit;
use crate::plugins::{ProviderKind, editor_providers_for as editor_providers};
use crate::rpc::Dispatcher;
use ide_core::error::ErrorKind;
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
        return Ok(result.unwrap_or(CompletionList { is_incomplete: true, items: Vec::new() }));
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
    /// Listed by the plugin's `file-actions` export, which resolves it.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    file: bool,
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
    let Some((plugins, d)) = plugin_providers(host, window, doc, ProviderKind::Hover) else {
        let result = lsp.hover(doc, pos, cancel).await;
        host.end_request(request);
        return result;
    };
    let (result, hovers) =
        tokio::join!(lsp.hover(doc, pos, cancel), plugin_call(move || plugins.provide_hover(&d, pos)));
    host.end_request(request);
    let hovers = hovers.unwrap_or_default();
    if hovers.is_empty() {
        return result;
    }
    let server = match result {
        Ok(server) => server,
        Err(e) if matches!(e.kind, ErrorKind::NotFound | ErrorKind::Unavailable) => None,
        Err(e) => return Err(e),
    };
    Ok(crate::plugins::merge_hover(server, hovers))
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
    let found: Vec<Location> =
        found.into_iter().map(|l| Location { path: l.path.into(), range: l.range, uri: None }).collect();
    let in_string = !found.is_empty() && in_string_literal(host, window, doc, pos).await;
    definition_targets(result, found, in_string)
}

async fn in_string_literal(host: &Host, window: &str, doc: DocId, pos: Pos) -> bool {
    let Ok(project) = host.project(window) else { return false };
    blocking(move || {
        let snap = project.documents.text_snapshot(doc)?;
        if snap.large {
            return Ok(false);
        }
        let s = ide_syntax::Snapshot::doc(doc, snap.version, &snap.language, &snap.text);
        Ok(string_at(&project.structure, &s, pos))
    })
    .await
    .unwrap_or(false)
}

fn string_at(structure: &ide_syntax::StructureService, snap: &ide_syntax::Snapshot, pos: Pos) -> bool {
    let cancel = ide_core::CancellationToken::new();
    let Ok(Some(at)) = structure.node_at(snap, Range::new(pos, pos), &cancel) else { return false };
    let stringy = |kind: &str| kind.contains("string") || kind.contains("heredoc") || kind.contains("nowdoc");
    let part = |kind: &str| kind.contains("content") || kind.contains("fragment") || kind.contains("escape");
    stringy(&at.node.kind) || (part(&at.node.kind) && at.ancestors.first().is_some_and(|parent| stringy(&parent.kind)))
}

fn definition_targets(
    server: IdeResult<Vec<Location>>,
    plugin: Vec<Location>,
    in_string: bool,
) -> IdeResult<Vec<Location>> {
    if plugin.is_empty() {
        return server.map(without_generated_helpers);
    }
    if in_string {
        return Ok(plugin);
    }
    let same_place = |l: &Location| plugin.iter().any(|p| p.path == l.path && p.range.start.line == l.range.start.line);
    let server: Vec<Location> =
        without_generated_helpers(server.unwrap_or_default()).into_iter().filter(|l| !same_place(l)).collect();
    let mut out = plugin;
    out.extend(server);
    Ok(out)
}

fn without_generated_helpers(locations: Vec<Location>) -> Vec<Location> {
    let generated = |l: &Location| {
        let path = l.path.to_string_lossy().replace('\\', "/");
        let file = path.rsplit('/').next().unwrap_or(&path);
        file.starts_with("_ide_helper") || file == ".phpstorm.meta.php" || path.contains("/vendor/_laravel_ide")
    };
    if locations.iter().all(generated) {
        return locations;
    }
    locations.into_iter().filter(|l| !generated(l)).collect()
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
/// leave it off. Java, `project_wide`: without `libraries`, the dependencies and the JDK
/// are not searched; with it, those found in the sources arrive on `on_partial` before
/// the slower search for the rest, and the result has them all. Cancel with
/// `cancel_request(request)`.
#[allow(clippy::too_many_arguments)]
pub async fn lsp_references(
    host: &Host,
    window: &str,
    request: RequestId,
    doc: DocId,
    pos: Pos,
    include_declaration: bool,
    project_wide: bool,
    libraries: bool,
    on_partial: super::Channel<References>,
) -> IdeResult<References> {
    let project = host.project(window)?;
    let lsp = project.lsp.clone();
    let cancel = host.begin_request(request);
    let result = async {
        let symbol = indexed_symbol(host, window, doc, pos).await?;
        if let Some(symbol) = &symbol {
            let project = project.clone();
            let snapshot = symbol.clone();
            let cancellation = cancel.clone();
            blocking(move || validate_indexed_symbol(&project, &snapshot, Some(&cancellation))).await?;
            let _ = on_partial.send(merge_indexed_references(References::default(), symbol));
        }
        let result = lsp
            .references_streaming(
                doc,
                pos,
                include_declaration,
                project_wide,
                libraries,
                cancel.clone(),
                Some(&|refs| {
                    let refs =
                        symbol.as_ref().map_or_else(|| refs.clone(), |s| merge_indexed_references(refs.clone(), s));
                    let _ = on_partial.send(refs);
                }),
            )
            .await;
        if cancel.is_cancelled() {
            return Err(ide_core::IdeError::cancelled());
        }
        match symbol {
            None => result,
            Some(symbol) => {
                let server = match result {
                    Ok(server) => server,
                    Err(e) => References { incomplete: indexed_lsp_error(e)?, ..Default::default() },
                };
                blocking(move || {
                    validate_indexed_symbol(&project, &symbol, Some(&cancel))?;
                    Ok(merge_indexed_references(server, &symbol))
                })
                .await
            }
        }
    }
    .await;
    host.end_request(request);
    result
}

/// Native servers can decline names owned by indexers. A failed native query
/// keeps the graph usable but must not look like a complete merged result.
fn indexed_lsp_error(error: ide_core::IdeError) -> IdeResult<Option<ReferencesIncomplete>> {
    match error.kind {
        ErrorKind::NotFound | ErrorKind::Unavailable => Ok(None),
        ErrorKind::Protocol => Ok(Some(ReferencesIncomplete::ServerFailed)),
        _ => Err(error),
    }
}

async fn indexed_symbol(
    host: &Host,
    window: &str,
    doc: DocId,
    pos: Pos,
) -> IdeResult<Option<crate::plugins::navigation::IndexedSymbol>> {
    let Some(plugins) = crate::plugins::editor_plugin_host() else { return Ok(None) };
    let project = host.project(window)?;
    let client = window.to_owned();
    blocking(move || {
        let Ok((path, _)) = project.documents.identity(doc) else { return Ok(None) };
        Ok(plugins.indexed_symbol_at(&project.root, &path, pos, Some(&client)))
    })
    .await
}

fn validate_indexed_symbol(
    project: &crate::Project,
    symbol: &crate::plugins::navigation::IndexedSymbol,
    cancel: Option<&ide_core::CancellationToken>,
) -> IdeResult<()> {
    use std::io::Read;
    for file in &symbol.files {
        if cancel.is_some_and(|cancel| cancel.is_cancelled()) {
            return Err(ide_core::IdeError::cancelled());
        }
        let stale = || {
            ide_core::IdeError::new(ErrorKind::OutOfSync, "indexed document changed; wait for indexing and try again")
        };
        if ide_plugin::resolve_in_root(&project.root, &file.path.to_string_lossy()).ok().as_ref() != Some(&file.path) {
            return Err(stale());
        }
        let text = if let Some(doc) = project.documents.by_path(&file.path) {
            let snapshot = project.documents.text_snapshot(doc)?;
            if snapshot.large || file.version.is_some_and(|v| v != snapshot.version) {
                return Err(stale());
            }
            snapshot.text
        } else {
            let mut text = String::new();
            std::fs::File::open(&file.path)
                .map_err(|_| stale())?
                .take((crate::plugins::navigation::MAX_DOCUMENT_BYTES + 1) as u64)
                .read_to_string(&mut text)
                .map_err(|_| stale())?;
            text
        };
        if text.len() > crate::plugins::navigation::MAX_DOCUMENT_BYTES
            || crate::plugins::navigation::snapshot_hash(&text) != file.hash
        {
            return Err(stale());
        }
        let text = ide_text::Document::new(&text);
        for range in &file.ranges {
            if [range.start, range.end].into_iter().any(|pos| text.offset_to_pos(text.pos_to_offset(pos)) != pos) {
                return Err(ide_core::IdeError::invalid("indexed name is not on a UTF-16 character boundary"));
            }
        }
    }
    Ok(())
}

fn merge_indexed_references(mut server: References, symbol: &crate::plugins::navigation::IndexedSymbol) -> References {
    let mut seen: std::collections::HashSet<_> = server.locations.iter().cloned().collect();
    for file in &symbol.files {
        for range in &file.ranges {
            let location = Location::file(file.path.clone(), *range);
            if seen.insert(location.clone()) {
                server.locations.push(location);
            }
        }
    }
    server
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
            file: a.file_action,
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
        file_action: r.file,
    };
    let plugin = r.plugin.clone();
    let invocation = ide_plugin::Invocation { client: Some(window.to_owned()), ..Default::default() };
    let resolved = blocking(move || plugins.resolve_code_action(&plugin, &d, pending, invocation)).await?;
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

/// Resolves a code action's edit without applying it.
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

/// The plugin and the file its action asks to show once applied.
fn plugin_action_open(action: &CodeAction) -> Option<(String, ide_core::IpcPath)> {
    if action.server != PLUGIN_SERVER {
        return None;
    }
    let r = action.data.clone().and_then(|d| serde_json::from_value::<PluginActionRef>(d).ok())?;
    Some((r.plugin, r.open?))
}

/// Opens the file a plugin's action asked to show, now that the action is applied.
fn open_plugin_action_target(action: &CodeAction, window: &str) {
    let (Some((plugin, path)), Some(plugins)) = (plugin_action_open(action), crate::plugins::editor_plugin_host())
    else {
        return;
    };
    plugins.open_file(&plugin, window, path);
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
    if let Some(symbol) = indexed_symbol(host, window, doc, pos).await? {
        let project = host.project(window)?;
        return blocking(move || {
            validate_indexed_symbol(&project, &symbol, None)?;
            Ok(Some(symbol.range))
        })
        .await;
    }
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
    let result = async {
        let symbol = indexed_symbol(host, window, doc, pos).await?;
        let mut native_owned = false;
        let result = async {
            if let Some(symbol) = &symbol {
                let range = tokio::select! {
                    _ = cancel.cancelled() => return Err(ide_core::IdeError::cancelled()),
                    range = project.lsp.prepare_rename(doc, pos) => range?,
                };
                if range != Some(symbol.range) {
                    return Ok(Renamed::default());
                }
                native_owned = true;
            }
            project.lsp.rename(doc, pos, new_name.clone(), cancel.clone()).await
        }
        .await;
        if cancel.is_cancelled() {
            return Err(ide_core::IdeError::cancelled());
        }
        let mut renamed = match result {
            Ok(renamed) => renamed,
            Err(e) if symbol.is_some() && !native_owned => {
                Renamed { incomplete: indexed_lsp_error(e)?, ..Default::default() }
            }
            Err(e) => return Err(e),
        };
        blocking(move || {
            if project.documents.version(doc)? != version {
                return Err(ide_core::IdeError::new(
                    ErrorKind::OutOfSync,
                    "document changed while computing rename; request it again",
                ));
            }
            if let Some(symbol) = &symbol {
                merge_indexed_rename(&mut renamed, symbol, &new_name, &project.documents);
            }
            project.documents.prepare_workspace_edit(&mut renamed.edit)?;
            if let Some(symbol) = &symbol {
                validate_indexed_symbol(&project, symbol, Some(&cancel))?;
            }
            if cancel.is_cancelled() {
                return Err(ide_core::IdeError::cancelled());
            }
            Ok(renamed)
        })
        .await
    }
    .await;
    host.end_request(request);
    result
}

fn merge_indexed_rename(
    renamed: &mut Renamed,
    symbol: &crate::plugins::navigation::IndexedSymbol,
    new_name: &str,
    documents: &ide_workspace::Documents,
) {
    use ide_core::FileEdit;
    renamed.preview = true;
    let server = std::mem::take(&mut renamed.edit.files);
    let mut additions: Vec<Vec<FileEdit>> = vec![vec![]; server.len() + 1];
    for file in &symbol.files {
        let mut path = file.path.clone();
        let mut at = server.len();
        for (index, operation) in server.iter().enumerate() {
            match operation {
                FileEdit::Edit { path: target, .. } if target.0 == path => {
                    at = index;
                    break;
                }
                FileEdit::Rename { from, to } => {
                    if let Ok(suffix) = path.strip_prefix(&from.0) {
                        path = to.join(suffix);
                    }
                }
                _ => {}
            }
        }
        additions[at].push(FileEdit::Edit {
            path: path.into(),
            version: documents
                .by_path(&file.path)
                .and_then(|id| documents.version(id).ok())
                .and_then(|v| i32::try_from(v).ok()),
            edits: file.ranges.iter().map(|range| TextEdit { range: *range, new_text: new_name.to_owned() }).collect(),
        });
    }
    for (index, operation) in server.into_iter().enumerate() {
        renamed.edit.files.push(operation);
        renamed.edit.files.append(&mut additions[index]);
    }
    renamed.edit.files.append(additions.last_mut().expect("one trailing batch"));
    renamed.edit.deduplicate();
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
    let lsp = host.project(window)?.lsp.clone();
    let Some((plugins, d)) = plugin_providers(host, window, doc, ProviderKind::InlayHints) else {
        return lsp.inlay_hints(doc, range).await;
    };
    let (result, hints) =
        tokio::join!(lsp.inlay_hints(doc, range), plugin_call(move || plugins.provide_inlay_hints(&d, range)));
    let hints = hints.unwrap_or_default();
    if hints.is_empty() {
        return result;
    }
    let server = match result {
        Ok(server) => server,
        Err(e) if matches!(e.kind, ErrorKind::NotFound | ErrorKind::Unavailable) => Vec::new(),
        Err(e) => return Err(e),
    };
    Ok(crate::plugins::merge_inlay_hints(server, hints, range))
}

pub async fn lsp_semantic_tokens(host: &Host, window: &str, doc: DocId) -> IdeResult<Option<SemanticTokens>> {
    let lsp = host.project(window)?.lsp.clone();
    let Some((plugins, d)) = plugin_providers(host, window, doc, ProviderKind::SemanticTokens) else {
        return lsp.semantic_tokens(doc).await;
    };
    let (result, tokens) =
        tokio::join!(lsp.semantic_tokens(doc), plugin_call(move || plugins.provide_semantic_tokens(&d)));
    let tokens = tokens.unwrap_or_default();
    if tokens.is_empty() {
        return result;
    }
    let server = match result {
        Ok(server) => server,
        Err(e) if matches!(e.kind, ErrorKind::NotFound | ErrorKind::Unavailable) => None,
        Err(e) => return Err(e),
    };
    Ok(Some(crate::plugins::merge_semantic_tokens(server, tokens)))
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
        // A plugin's action may name a file to show once applied; the caller opens it.
        let open = plugin_action_open(&action).map(|(_, path)| path);
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
            None => Ok(open.into_iter().collect()),
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
        let on_partial = c.sender("onPartial")?;
        lsp_references(
            &c.host,
            &c.window,
            c.arg("request")?,
            c.arg("doc")?,
            c.arg("pos")?,
            c.arg("includeDeclaration")?,
            c.arg("projectWide")?,
            c.arg("libraries")?,
            on_partial,
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
    fn indexed_names_survive_native_refusal_without_hiding_cancellation_or_staleness() {
        use ide_core::IdeError;
        for kind in [ErrorKind::NotFound, ErrorKind::Unavailable] {
            assert_eq!(indexed_lsp_error(IdeError::new(kind, "no native provider")).unwrap(), None);
        }
        assert_eq!(
            indexed_lsp_error(IdeError::new(ErrorKind::Protocol, "not a native identifier")).unwrap(),
            Some(ReferencesIncomplete::ServerFailed)
        );
        for kind in [ErrorKind::Cancelled, ErrorKind::OutOfSync, ErrorKind::InvalidInput] {
            assert_eq!(indexed_lsp_error(IdeError::new(kind, "must propagate")).unwrap_err().kind, kind);
        }
    }

    #[test]
    fn indexed_results_merge_with_lsp_locations_edits_and_incompleteness() {
        use crate::plugins::navigation::{IndexedAnchors, IndexedSymbol};
        use ide_core::{FileEdit, LanguageId};
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().canonicalize().unwrap();
        let shared = root.join("shared.idx");
        let native = root.join("native.txt");
        std::fs::write(&shared, "old old").unwrap();
        std::fs::write(&native, "old").unwrap();
        let range = Range::new(Pos::new(0, 0), Pos::new(0, 3));
        let other = Range::new(Pos::new(0, 4), Pos::new(0, 7));
        let symbol = IndexedSymbol {
            range,
            files: vec![IndexedAnchors {
                path: shared.clone(),
                version: None,
                hash: blake3::hash(b"old old"),
                ranges: vec![range, other],
            }],
        };
        let location = Location::file(shared.clone(), range);
        let native_location = Location::file(native.clone(), range);
        let merged = merge_indexed_references(
            References {
                locations: vec![location.clone(), native_location.clone()],
                incomplete: Some(ReferencesIncomplete::Indexing),
                libraries_skipped: true,
                ..Default::default()
            },
            &symbol,
        );
        assert_eq!(merged.locations, vec![location, native_location, Location::file(shared.clone(), other)]);
        assert_eq!(merged.incomplete, Some(ReferencesIncomplete::Indexing));
        assert!(merged.libraries_skipped);
        let edit = |path, range| FileEdit::Edit {
            path,
            version: None,
            edits: vec![TextEdit { range, new_text: "new".into() }],
        };
        let mut renamed = Renamed {
            edit: WorkspaceEdit {
                files: vec![edit(shared.clone().into(), range), edit(native.clone().into(), range)],
                ..Default::default()
            },
            incomplete: Some(ReferencesIncomplete::FilesSkipped),
            ..Default::default()
        };
        let docs = ide_workspace::Documents::new(
            std::sync::Arc::new(ide_core::NullSink),
            Box::new(|_: &Path, _: Option<&str>| LanguageId::plain_text()),
        );
        merge_indexed_rename(&mut renamed, &symbol, "new", &docs);
        assert!(renamed.preview);
        assert_eq!(renamed.incomplete, Some(ReferencesIncomplete::FilesSkipped));
        assert_eq!(renamed.edit.files.len(), 2);
        docs.prepare_workspace_edit(&mut renamed.edit).unwrap();
        docs.apply_workspace_edit(&renamed.edit).unwrap();
        assert_eq!(std::fs::read_to_string(&shared).unwrap(), "new new");
        assert_eq!(std::fs::read_to_string(&native).unwrap(), "new");

        // A class rename may move its file before editing the new path. Indexed
        // anchors still describe the original file and must join that text batch.
        let moved = root.join("moved.idx");
        let mut renamed = Renamed {
            edit: WorkspaceEdit {
                files: vec![
                    FileEdit::Rename { from: shared.clone().into(), to: moved.clone().into() },
                    FileEdit::Edit {
                        path: moved.clone().into(),
                        version: None,
                        edits: vec![TextEdit { range, new_text: "moved".into() }],
                    },
                ],
                ..Default::default()
            },
            ..Default::default()
        };
        merge_indexed_rename(&mut renamed, &symbol, "moved", &docs);
        docs.prepare_workspace_edit(&mut renamed.edit).unwrap();
        docs.apply_workspace_edit(&renamed.edit).unwrap();
        assert!(!shared.exists());
        assert_eq!(std::fs::read_to_string(&moved).unwrap(), "moved moved");
    }

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
            file_action: false,
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
    fn plugin_definitions_own_strings_and_join_the_server_elsewhere() {
        let at = |path: &str, line: u32| Location {
            path: path.into(),
            range: Range::new(Pos::new(line, 0), Pos::new(line, 4)),
            uri: None,
        };
        let paths = |found: IdeResult<Vec<Location>>| {
            found.unwrap().into_iter().map(|l| l.path.to_string_lossy().into_owned()).collect::<Vec<_>>()
        };
        let xml = at("/p/src/main/resources/UserMapper.xml", 3);
        let java = at("/p/src/main/java/UserMapper.java", 7);
        let helper = at("/p/_ide_helper.php", 1);
        let route = at("/p/routes/web.php", 2);
        let guess = at("/p/app/helpers.php", 9);

        assert_eq!(
            paths(definition_targets(Ok(vec![java.clone(), helper.clone()]), vec![xml.clone()], false)),
            ["/p/src/main/resources/UserMapper.xml", "/p/src/main/java/UserMapper.java"]
        );
        assert_eq!(
            paths(definition_targets(Ok(vec![xml.clone(), java.clone()]), vec![xml.clone()], false)),
            ["/p/src/main/resources/UserMapper.xml", "/p/src/main/java/UserMapper.java"]
        );
        assert_eq!(
            paths(definition_targets(Ok(vec![guess.clone(), helper.clone()]), vec![route.clone()], true)),
            ["/p/routes/web.php"]
        );
        assert_eq!(
            paths(definition_targets(Err(ide_core::IdeError::unavailable("no server")), vec![route.clone()], false)),
            ["/p/routes/web.php"]
        );
        assert_eq!(paths(definition_targets(Ok(vec![helper, guess]), Vec::new(), false)), ["/p/app/helpers.php"]);
    }

    #[test]
    fn positions_inside_string_literals_are_told_apart() {
        let syntax = std::sync::Arc::new(ide_language::Syntax::new());
        let structure = ide_syntax::StructureService::new(std::sync::Arc::new(ide_language::SyntaxCache::new(syntax)));
        let php = ide_core::LanguageId::new("php");
        let text = "<?php\nreturn to_route('users.show', $user);\necho \"Hi {$name}\";\n";
        let snap = ide_syntax::Snapshot::text(&php, text);
        assert!(string_at(&structure, &snap, Pos::new(1, 20)), "inside 'users.show'");
        assert!(!string_at(&structure, &snap, Pos::new(1, 9)), "on to_route");
        assert!(!string_at(&structure, &snap, Pos::new(1, 35)), "on $user");
        assert!(!string_at(&structure, &snap, Pos::new(2, 12)), "on an interpolated variable");
        let java = ide_core::LanguageId::new("java");
        let text = "class A {\n    User find(long id) { return mapper.selectById(\"users\"); }\n}\n";
        let snap = ide_syntax::Snapshot::text(&java, text);
        assert!(!string_at(&structure, &snap, Pos::new(1, 9)), "on a method name");
        assert!(string_at(&structure, &snap, Pos::new(1, 53)), "inside \"users\"");
    }

    #[test]
    fn generated_ide_helpers_give_way_to_real_declarations() {
        let at = |path: &str| Location { path: path.into(), range: Range::default(), uri: None };
        let paths =
            |found: Vec<Location>| found.into_iter().map(|l| l.path.to_string_lossy().into_owned()).collect::<Vec<_>>();
        let real = at("/app/app/Models/User.php");
        let helper = at("/app/_ide_helper_models.php");
        let meta = at("/app/.phpstorm.meta.php");
        let vendor = at("/app/vendor/_laravel_idea/_ide_helper.php");
        assert_eq!(
            paths(without_generated_helpers(vec![helper.clone(), real.clone(), meta.clone(), vendor])),
            ["/app/app/Models/User.php"]
        );
        assert_eq!(
            paths(without_generated_helpers(vec![helper.clone(), meta.clone()])),
            ["/app/_ide_helper_models.php", "/app/.phpstorm.meta.php"]
        );
        assert!(without_generated_helpers(Vec::new()).is_empty());
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
            file_action: true,
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
        assert!(r.file, "resolved by the file-actions export");
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

        // `data` and nothing to apply: the file-actions export computes it when picked.
        let mut lazy = action(Vec::new());
        (lazy.edits, lazy.open, lazy.data) = (Vec::new(), None, Some("ref".into()));
        let lazy = plugin_code_action("acme.x", &root, lazy);
        assert!(lazy.edit.is_none());
        let r: PluginActionRef = serde_json::from_value(lazy.data.unwrap()).unwrap();
        assert_eq!((r.data.as_deref(), r.file), (Some("ref"), true));
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
