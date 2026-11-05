# Background document indexers (API 1.0)

Use `contributes.providers` for interactive definition, completion and line-marker
requests. A document indexer is for cross-file associations that need project
prewarming: it publishes symbolic references once, and the host resolves clicks
without scanning files or invoking Wasm. It also describes source ranges and
embedded SQL regions, which the existing interactive providers cannot return.

```toml
[[contributes.documentIndexers]]
extensions = ["java", "xml"]
```

Implement `openidea_plugin::indexing::DocumentIndexer` and use
`register_plugin!(Plugin, indexing)` (or add `providers` when also implementing
interactive providers). The optional `document-indexer`
export is additive: existing API 1.0 components and provider signatures are
unchanged. Indexers require `project.read` and run only in trusted projects.

The host supplies bounded file text and cached syntax symbols. Return definitions
and references with plugin-local symbolic keys and UTF-16 source ranges. An alias
maps one `type#` prefix to another for inherited members; cycles and candidate
counts are bounded. References with duplicate targets remain selectable. Targets
in the same detected module take precedence. Unsaved documents are indexed from
their buffers, separately for each window.

`presentation.markers` resolves through the same associations. `presentation.icon`
is the id of this plugin's existing `fileIcons` contribution (assets use the usual
SVG validation and theme variants). `linked_only` hides the semantic icon unless
a mapping exists. Regions currently support `sql`; they must exclude dynamic XML
tags. SQL parsing is lazy, version-cached, and bounded. No HTML or executable UI
content comes from the component.

Initial discovery reuses the host project index. The editor schedules cancellable
batches of at most 16 files; edits and filesystem changes invalidate affected
entries before rebuilding. Click and visible-file presentation queries only read
memory. Reload, disable, failed runtimes, changed project roots, or editor versions
cannot reuse stale contributions. The native operations are shared by the desktop
and remote host.

Limits: 2 MiB per document, 20,000 files per graph, 4,096 references/definitions
per document, 256 aliases, 200,000 total association/presentation entries, 16
project/window graphs, and 256 candidates per lookup. Exceeding a limit reports
incomplete indexing rather than blocking editing.

## Minimal fixture and consumers

`crates/ide-plugin/tests/fixtures/indexer` uses a tiny line-oriented `.idx`
language to exercise definitions, references, aliases, host syntax symbols and
presentation without framework-specific parsing. Run
`cargo test -p ide-host --test plugin_indexing` for the real-component contract
checks. The existing official samples are unchanged.

Full language/framework plugins belong in their authors' repositories. The
external [MyBatis Navigator](https://github.com/qjlqyf/openidea-mybatis) is a
consumer; it is not bundled or required by this API's tests. Its marketplace
release depends on a released host that includes this extension.
