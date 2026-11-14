//! IPC commands of `ide_host::ops::nav` (the shared implementation).

use crate::state::AppState;
use ide_core::{DocId, IdeResult, IpcPath, Pos};
#[allow(unused_imports)]
pub use ide_host::ops::nav::*;
use ide_index::{ExtensionCount, FileMatch, IndexStatus, SymbolFilter, SymbolMatch};
use ide_language::FileReference;
use ide_workspace::file_refs::PathCompletion;
use std::path::PathBuf;
use tauri::{State, Window};

#[tauri::command]
#[specta::specta]
pub fn index_status(window: Window, state: State<'_, AppState>) -> IdeResult<IndexStatus> {
    ide_host::ops::nav::index_status(&state.host, window.label())
}

#[tauri::command]
#[specta::specta]
pub fn index_file_extensions(window: Window, state: State<'_, AppState>) -> IdeResult<Vec<ExtensionCount>> {
    ide_host::ops::nav::index_file_extensions(&state.host, window.label())
}

#[tauri::command]
#[specta::specta]
pub fn find_files(window: Window, state: State<'_, AppState>, query: String, limit: u32) -> IdeResult<Vec<FileMatch>> {
    ide_host::ops::nav::find_files(&state.host, window.label(), query, limit)
}

#[tauri::command]
#[specta::specta]
pub async fn find_files_named(window: Window, state: State<'_, AppState>, name: String) -> IdeResult<Vec<IpcPath>> {
    ide_host::ops::nav::find_files_named(&state.host, window.label(), name).await
}

/// Folders holding indexed files, for `@` references.
#[tauri::command]
#[specta::specta]
pub fn find_dirs(window: Window, state: State<'_, AppState>, query: String, limit: u32) -> IdeResult<Vec<FileMatch>> {
    ide_host::ops::nav::find_dirs(&state.host, window.label(), query, limit)
}

/// Spring Web mapping sources for the request-path index of Search Everywhere.
#[tauri::command]
#[specta::specta]
pub fn spring_route_sources(
    window: Window,
    state: State<'_, AppState>,
) -> IdeResult<Vec<ide_host::ops::routes::RouteSource>> {
    ide_host::ops::routes::spring_route_sources(&state.host, window.label())
}

/// The Laravel routes matching `query` (name, URI, method or action parts) for
/// Search Everywhere's Routes scope, from the native PHP engine.
#[tauri::command]
#[specta::specta]
pub async fn php_laravel_routes(
    window: Window,
    state: State<'_, AppState>,
    query: String,
) -> IdeResult<Vec<ide_host::ops::routes::LaravelRoute>> {
    ide_host::ops::routes::php_laravel_routes(&state.host, window.label(), query).await
}

/// The edit adding Laravel translation `key` with each locale's text (the
/// "Create translation key…" dialog), from the native PHP engine.
#[tauri::command]
#[specta::specta]
pub async fn php_laravel_create_translation(
    window: Window,
    state: State<'_, AppState>,
    key: String,
    texts: Vec<ide_host::ops::laravel::TranslationText>,
) -> IdeResult<ide_core::WorkspaceEdit> {
    ide_host::ops::laravel::php_laravel_create_translation(&state.host, window.label(), key, texts).await
}

/// The Eloquent model view of Laravel model class `model` (table, columns,
/// relations, scopes, accessors, related classes), from the native PHP engine.
#[tauri::command]
#[specta::specta]
pub async fn php_laravel_model_view(
    window: Window,
    state: State<'_, AppState>,
    model: String,
) -> IdeResult<ide_host::ops::laravel::LaravelModelView> {
    ide_host::ops::laravel::php_laravel_model_view(&state.host, window.label(), model).await
}

/// The edit of the Eloquent model view's Add Columns button: a migration adding
/// `columns` to the model's table, and the columns added to `$fillable`.
#[tauri::command]
#[specta::specta]
pub async fn php_laravel_add_columns(
    window: Window,
    state: State<'_, AppState>,
    model: String,
    columns: Vec<ide_host::ops::laravel::LaravelNewColumn>,
    fillable: bool,
    timestamp: String,
) -> IdeResult<ide_core::WorkspaceEdit> {
    ide_host::ops::laravel::php_laravel_add_columns(&state.host, window.label(), model, columns, fillable, timestamp)
        .await
}

/// The Artisan commands of the Laravel project (classes, closure commands, packages',
/// Laravel's own) with their arguments and options; `None` outside Laravel projects and
/// without the native PHP engine.
#[tauri::command]
#[specta::specta]
pub async fn php_laravel_artisan_commands(
    window: Window,
    state: State<'_, AppState>,
) -> IdeResult<Option<Vec<ide_host::ops::laravel::LaravelArtisanCommand>>> {
    ide_host::ops::laravel::php_laravel_artisan_commands(&state.host, window.label()).await
}

/// What the Laravel generator dialogs offer (namespace, modules, models, generators);
/// `None` outside Laravel projects and without the native PHP engine.
#[tauri::command]
#[specta::specta]
pub async fn php_laravel_generation_context(
    window: Window,
    state: State<'_, AppState>,
) -> IdeResult<Option<ide_host::ops::laravel::LaravelGenerationContext>> {
    ide_host::ops::laravel::php_laravel_generation_context(&state.host, window.label()).await
}

/// The edit of the Laravel New Model dialog: the model and its companion classes,
/// rendered from the file templates (`templates`: the user's edited ones).
#[tauri::command]
#[specta::specta]
pub async fn php_laravel_new_model(
    window: Window,
    state: State<'_, AppState>,
    spec: ide_host::ops::laravel::LaravelNewModel,
    templates: Vec<ide_host::ops::laravel::LaravelTemplate>,
    timestamp: String,
) -> IdeResult<ide_core::WorkspaceEdit> {
    ide_host::ops::laravel::php_laravel_new_model(&state.host, window.label(), spec, templates, timestamp).await
}

/// The edit of a Laravel class generator (controller, job, view, test…): the new files
/// rendered from the file templates (`templates`: the user's edited ones).
#[tauri::command]
#[specta::specta]
pub async fn php_laravel_generate_class(
    window: Window,
    state: State<'_, AppState>,
    spec: ide_host::ops::laravel::LaravelNewClass,
    templates: Vec<ide_host::ops::laravel::LaravelTemplate>,
    timestamp: String,
) -> IdeResult<ide_core::WorkspaceEdit> {
    ide_host::ops::laravel::php_laravel_generate_class(&state.host, window.label(), spec, templates, timestamp).await
}

/// Keeps the user's edited Laravel generator templates for the Generate actions inside
/// a model class.
#[tauri::command]
#[specta::specta]
pub async fn php_laravel_set_templates(
    window: Window,
    state: State<'_, AppState>,
    templates: Vec<ide_host::ops::laravel::LaravelTemplate>,
) -> IdeResult<()> {
    ide_host::ops::laravel::php_laravel_set_templates(&state.host, window.label(), templates).await
}

/// Reads the schema of the data source chosen in Settings › PHP › Laravel again for the
/// native PHP engine (`None`: none chosen).
#[tauri::command]
#[specta::specta]
pub async fn php_laravel_refresh_schema(
    window: Window,
    state: State<'_, AppState>,
) -> IdeResult<Option<ide_host::ops::laravel::LaravelSchemaStatus>> {
    ide_host::ops::laravel::php_laravel_refresh_schema(&state.host, window.label()).await
}

#[tauri::command]
#[specta::specta]
pub fn find_symbols(
    window: Window,
    state: State<'_, AppState>,
    query: String,
    filter: SymbolFilter,
    limit: u32,
) -> IdeResult<Vec<SymbolMatch>> {
    ide_host::ops::nav::find_symbols(&state.host, window.label(), query, filter, limit)
}

#[tauri::command]
#[specta::specta]
pub fn mark_recent(window: Window, state: State<'_, AppState>, path: PathBuf) -> IdeResult<()> {
    ide_host::ops::nav::mark_recent(&state.host, window.label(), path)
}

#[tauri::command]
#[specta::specta]
pub fn remove_recent(window: Window, state: State<'_, AppState>, path: PathBuf) -> IdeResult<()> {
    ide_host::ops::nav::remove_recent(&state.host, window.label(), path)
}

/// Recently opened files, most recent first (⌘E).
#[tauri::command]
#[specta::specta]
pub fn recent_files(window: Window, state: State<'_, AppState>) -> IdeResult<Vec<ide_core::IpcPath>> {
    ide_host::ops::nav::recent_files(&state.host, window.label())
}

/// The web reference at `pos` of `doc` and its targets; `None` when there is no reference.
#[tauri::command]
#[specta::specta]
pub async fn web_goto(window: Window, state: State<'_, AppState>, doc: DocId, pos: Pos) -> IdeResult<Option<WebGoto>> {
    ide_host::ops::nav::web_goto(&state.host, window.label(), doc, pos).await
}

/// The file a Python import path (`a.b.c`, or `.x` relative to `from`) names; `None` when
/// no project or content root has it.
#[tauri::command]
#[specta::specta]
pub async fn nav_resolve_module(
    window: Window,
    state: State<'_, AppState>,
    name: String,
    from: IpcPath,
) -> IdeResult<Option<IpcPath>> {
    ide_host::ops::nav::nav_resolve_module(&state.host, window.label(), name, from).await
}

/// Index definitions named `name` within the roots `from` may navigate into (its own root
/// plus its configured dependencies).
#[tauri::command]
#[specta::specta]
pub async fn nav_index_definitions(
    window: Window,
    state: State<'_, AppState>,
    name: String,
    from: IpcPath,
) -> IdeResult<Vec<SymbolMatch>> {
    ide_host::ops::nav::nav_index_definitions(&state.host, window.label(), name, from).await
}

/// The existing file or directory a path written in `from` names (`href`, `url()`, a string literal).
#[tauri::command]
#[specta::specta]
pub async fn fs_resolve_reference(
    window: Window,
    state: State<'_, AppState>,
    from: IpcPath,
    value: String,
) -> IdeResult<Option<IpcPath>> {
    ide_host::ops::nav::fs_resolve_reference(&state.host, window.label(), from, value).await
}

/// Files and folders that continue `prefix`, a path being typed in `from`.
#[tauri::command]
#[specta::specta]
pub async fn path_completions(
    window: Window,
    state: State<'_, AppState>,
    from: IpcPath,
    prefix: String,
) -> IdeResult<Vec<PathCompletion>> {
    ide_host::ops::nav::path_completions(&state.host, window.label(), from, prefix).await
}

/// Paths in an HTML document or stylesheet that name no existing file.
#[tauri::command]
#[specta::specta]
pub async fn web_unresolved_references(
    window: Window,
    state: State<'_, AppState>,
    doc: DocId,
) -> IdeResult<Vec<FileReference>> {
    ide_host::ops::nav::web_unresolved_references(&state.host, window.label(), doc).await
}
