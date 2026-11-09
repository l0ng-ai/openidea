# blame-annotations — API 1.4 example

Run **Example: Show Blame Annotations** in a trusted Git project with a text
file open, or click its code lens. `vcs.blame` becomes `decorations.set` after
text at each UTF-16 line end (up to 2,000 lines). The host withdraws the set
when the plugin stops. The lens performs no Git work itself.

Grants: `project.read`, `editor.read`, `vcs.read`. This example annotates on
demand; it intentionally has no background refresh or attribution cache.

Build from the repository root:

```sh
plugins/build.sh official/blame-annotations
cargo test --manifest-path plugins/official/blame-annotations/Cargo.toml
cargo run -p ide-host --bin openidea-plugin -- check plugins/official/blame-annotations
```

Install the built package folder through Settings › Plugins › Install from
Disk. See the [plugin guide](../../README.md#api-14) and
[official/community policy](../../README.md#81-official-and-community-plugins).
