# todo-finder — API 1.4 example

Run **Example: Find TODOs**, including from a search result's context menu.
`project.search-text` supplies a list view; activating a row opens its location.
The invoking window's status item combines the match count with
`diagnostics.problems`. Both search and rendering use the invocation's project,
so the example keeps no cross-window cache. Results are capped at 500.

Grant: `project.read`. Remote Problems snapshots are currently empty; text
search still runs on the server. This is a small view/API example, not a TODO
indexer or a replacement for Find in Files.

Build from the repository root:

```sh
plugins/build.sh official/todo-finder
cargo test --manifest-path plugins/official/todo-finder/Cargo.toml
cargo run -p ide-host --bin openidea-plugin -- check plugins/official/todo-finder
```

Install the built package folder through Settings › Plugins › Install from
Disk. See the [plugin guide](../../README.md#api-14) and
[official/community policy](../../README.md#81-official-and-community-plugins).
