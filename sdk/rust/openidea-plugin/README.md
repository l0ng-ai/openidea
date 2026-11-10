# Rust plugin SDK

The Rust API is documented by `cargo doc`. Web pages shipped alongside a Rust
component use `window.openidea` rather than Rust imports.

## Background document WebSockets

`host::WebSocket` keeps a bounded, host-owned connection alive between plugin
calls. `connect`, `send` and `drain` require the same explicit `Project`, so a
handle cannot be reused from another project. Non-loopback endpoints must use
`wss://`; the URL cannot contain
credentials, a query, or a fragment. Authentication is supplied through one
`Authorization` header, whose value may contain a declared
`{{secret:name}}`. The manifest must grant `net:<host>`, `secrets` when a
placeholder is used, `events`, and the editor/project capabilities used by the
plugin.

`subscribe_document(project, path)` accepts only an open, regular file resolved
inside that project. Symlinks, IDE/VCS control directories and common secret
files (`.env*`, private-key and credential files) are refused. Each local edit
to the open document is sent after the versioned backend accepts it, as one
binary JSON frame containing `path`, `baseVersion`, `version`, and UTF-16
`changes`. Subscriptions are
idempotent and isolated by connection and path. Unsubscribe stops delivery;
dropping the connection removes all subscriptions. The outgoing and incoming
queues are bounded (256 frames, 8 MiB total, 1 MiB per frame). A full queue
rejects the new frame explicitly instead of reporting it as sent.

Declare `activation = ["on-event:websocket-ready"]` and handle that event to
call `drain` without polling. Inbound frames are plugin protocol data. After
validation and conflict handling, a plugin can use `Project::document` and
`Project::apply_document_edits`, or decode a relayed `DocumentChanged` and call
`Project::apply_document_change`; applying against a stale version fails
without changing the editor so the plugin can merge or surface the conflict.
Transport shutdown removes subscriptions immediately.
`drain` returns a `closed` flag with the final queued frames; the handle is
removed after that drain, or after a short expiry if the plugin abandons it.

API 1.3 adds `Event::FilesChanged(FilesChanged)` for debounced external file
creation, modification and removal in open projects. Declare
`engines.openidea = "^1.3"`, the `events` capability and
`activation = ["on-event:files-changed"]`, then handle the typed event in
`Plugin::handle_events`. Use `host::subscribe_paths("files-changed", &["config/**"])`
to receive only matching project-relative paths in each category. An empty
filter pauses delivery. Paths are absolute, like `Event::FileSaved`; pending
batches are discarded when their project closes. The released WIT variant
is unchanged: the SDK decodes `event::other` with kind `files-changed`.

See [the event contract](../../../plugins/README.md#events)
and the [real Wasm fixture](../../../crates/ide-plugin/tests/fixtures/files-events).

API 1.3 adds capability-gated interactive PTYs to that web bridge. Declare
`engines.openidea = "^1.3"` and `process:<program>` in `plugin.toml`, then send
`pty-spawn`, `pty-input`, `pty-resize` and `pty-kill` JSON strings using
`openidea.postMessage`. Consume `pty-data` and acknowledge its `sequence` using
`pty-ack`; handle `pty-exit` and `pty-error` through `openidea.onMessage`.

See [the protocol, permission and resource limits](../../../plugins/README.md#web-frame-ptys-api-13)
and the [minimal fixture](../../../crates/ide-plugin/tests/fixtures/web-pty).
The frame cannot access IPC directly. Its sessions belong to that frame and
end with its view or plugin. There is no new WIT import for this API.

API 1.3 also answers Find Usages and Rename from `DocumentIndexer` definitions
and references. Existing indexers work without another export; declare
`engines.openidea = "^1.3"` when requiring these host features. Each anchor must
cover exactly the name, using UTF-16 columns. The host merges native results,
previews indexed renames and applies them as one undoable workspace edit.
The existing `project.read` capability and trusted-project boundary apply.
See [the indexing contract](../../../plugins/indexing.md#find-usages-and-rename-api-13)
and [the minimal fixture](../../../crates/ide-plugin/tests/fixtures/indexer).

API 1.3 also adds diagnostics for unsaved documents. Declare
`kinds = ["diagnostics"]` and the supported `languages` under
`[[contributes.providers]]`, implement
`openidea_plugin::diagnostics::DiagnosticsProvider`, and export it with
`register_plugin!(MyPlugin, diagnostics)`. The host supplies versioned text
after a 300 ms debounce, cancels superseded calls, and drops stale answers
under the editor-provider budget. Ranges use 0-based UTF-16 positions.

The provider declaration supplies the document; host imports retain their
usual capability checks. Provider results coexist with manually published
diagnostics and are cleared with the document, project or plugin. Native
tests can call `MockHost::refresh_diagnostics` and inspect
`MockHost::provider_diagnostics`.

See [the diagnostics contract and limits](../../../plugins/README.md#diagnostics-while-typing)
and the [real Wasm fixture](../../../crates/ide-plugin/tests/fixtures/diagnostics).

API 1.3 also adds `open-log-tab` to the web bridge: a generic read-only editor
tab streams output from a granted process, with plugin-defined argument toggles.
It uses the same backend authorization and bounded PTY transport. See the
[protocol and lifecycle](../../../plugins/README.md#streaming-log-editor-tabs-api-13)
and the [built fixture](../../../crates/ide-plugin/tests/fixtures/web-log).

API 1.3 also adds `open-content-tab` to the web bridge: a plugin-backed editor
tab with custom toolbar actions (`content-tab-action` / `content-tab-reply`),
native diff viewer integration, and full `EditorDocumentLifecycle` support. See
the [protocol and lifecycle](../../../plugins/README.md#plugin-backed-content-editor-tabs-api-13)
and the [built fixture](../../../crates/ide-plugin/tests/fixtures/web-content).

## Multi-page settings (API 1.3)

Declare `[[contributes.settings.pages]]` with `id`, `title`, and `schema` and
require `engines.openidea = "^1.3"`. The IDE supplies searchable pages, grouped
fields, string lists and object tables. Values stay plugin-wide; read a table
with `host::setting("profiles")` and deserialize its JSON array.

A page action declares `title` and `command`. Pending settings are applied
before the command runs; return `Error::Invalid` / `Error::Failed` for an inline
failure and call `host::notify` on success. Keep API keys in declared secrets.

The [complete example](../../../crates/ide-plugin/tests/fixtures/settings-pages)
contains two pages, a model-profile table and a Test button, including the
manifest, schemas and Rust command implementation. See the
[settings contract](../../../plugins/README.md#multiple-pages-groups-lists-and-tables-api-13)
for supported field types, limits and Apply/Cancel behavior.
