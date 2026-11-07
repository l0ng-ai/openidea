# Rust plugin SDK

The Rust API is documented by `cargo doc`. Web pages shipped alongside a Rust
component use `window.openidea` rather than Rust imports.

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
