# Frozen API 1.4 run-target guest

`dist/plugin.wasm` is the execution fixture shipped in OpenIDEA v0.1.40,
from commit `37c2a6048eea89d4f6db645622612358b643862b`, built against API 1.4.
The manifest exposes its `target` command under a separate plugin id.
Keep this binary frozen: rebuilding it with the current SDK would stop testing
released guests. Its source is `crates/ide-plugin/tests/fixtures/execution/src/lib.rs`
at that commit. It registers a Composer override inheriting the shared cwd arguments.
