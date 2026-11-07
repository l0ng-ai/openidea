# Rust plugin SDK

The Rust API is documented by `cargo doc`. Web pages shipped alongside a Rust
component use `window.openidea` rather than Rust imports.

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
