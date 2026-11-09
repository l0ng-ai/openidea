# test-runner — API 1.4 example

Put this directory on PATH **before installing/granting** the plugin, so
`process:openidea-example-tests` resolves to the included executable. Copy
`example.tests` to a trusted project. Its presence enables the dynamic
`run-configurations` export. Open it as plain text and click a gutter run
button, or use **Example: Run Tests** / the Run selector for all tests.

The gutter command appends the test name as a filter to `run.start`. The fake
executable prints a deliberately tiny `start NAME` / `pass NAME` protocol;
`test-results.parse` retains split lines and emits stable test ids. Replace
that protocol/parser and executable to integrate a real framework. This is an
API example, not a general test framework or a custom rerun-failed contract.

Build from the repository root:

```sh
plugins/build.sh official/test-runner
cargo test --manifest-path plugins/official/test-runner/Cargo.toml
cargo run -p ide-host --bin openidea-plugin -- check plugins/official/test-runner
```

Install the built package folder through Settings › Plugins › Install from
Disk. See the [plugin guide](../../README.md#api-14) and
[official/community policy](../../README.md#81-official-and-community-plugins).
