# Diagnostics provider fixture

Build with `plugins/build.sh crates/ide-plugin/tests/fixtures/diagnostics`.
Used by `cargo test -p ide-host --test plugin_diagnostics` for real Wasm dispatch,
UTF-16 ranges, debouncing, cancellation, window/project lifecycle and coexistence
with manually published diagnostics. Not a marketplace plugin.
