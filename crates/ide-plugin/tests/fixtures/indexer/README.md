# Document indexer test fixture

A small line-oriented test language (`.idx`), unrelated to any framework:
`def key`, `ref key`, `alias prefix# target#`, `sql text`, and `symbols prefix`.
References also produce gutter markers. `symbols` uses host-supplied UTF-16
syntax ranges. `invalid key` deliberately returns an out-of-bounds range.

Used by `cargo test -p ide-host --test plugin_indexing` to exercise the optional
WIT export, lifecycle invalidation, permissions, per-window isolation, candidate
selection and warm memory-only lookups. It is not a marketplace plugin.
