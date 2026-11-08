# Document indexer test fixture

A small line-oriented test language (`.idx`), unrelated to any framework:
`def key`, `ref key`, `alias prefix# target#` and `symbols prefix`.
References also produce gutter markers. `symbols` uses host-supplied UTF-16
syntax ranges. `invalid key` deliberately returns an out-of-bounds range.

Used by `cargo test -p ide-host --test plugin_indexing` to exercise the optional
WIT export, lifecycle invalidation, permissions, per-window isolation, candidate
selection and warm memory-only lookups. It is not a marketplace plugin.

The fixture requires `project.read`. Its API 1.2 manifest is retained to check
compatibility; Find Usages and Rename consume the same anchors on API 1.3 hosts.

Build with `plugins/build.sh crates/ide-plugin/tests/fixtures/indexer`, then load
this directory as a development plugin in a trusted scratch project containing:

```text
# definition.idx
def route
ref route

# usage.idx
ref route
```

The filenames and comment lines above describe two separate files. Invoke Find
Usages on either `route` anchor: three locations should appear. Rename `route`
to `new.route`: the preview must contain all three anchors. Cancel leaves both
files unchanged; applying changes both files, and one Undo restores both.

Run `cargo test -p ide-host --test plugin_indexing --test plugin_refactoring`
for the real Wasm graph and preview/apply/undo checks, including UTF-16 names,
aliases, duplicate anchors and stale files.
