# Background document indexers (API 1.2)

Use `contributes.providers` for interactive definition, completion and line-marker
requests about one document. A document indexer is for cross-file associations
that need the whole project: it publishes keys once per document, and the host
resolves clicks and gutter markers from memory, without scanning files or
calling the plugin.

```toml
[[contributes.documentIndexers]]
extensions = ["java", "xml"]
```

Implement `openidea_plugin::indexing::DocumentIndexer` and register with
`register_plugin!(Plugin, indexing)` (or `register_plugin!(Plugin, providers, indexing)`
when the plugin also has interactive providers). Components built with other
tools target the `plugin-indexing` world. Indexers require `project.read` and run
only in trusted projects.

`index` gets the document's text (the editor's while it is open) and the symbols
the host's syntax support found in it, and returns:

- `definitions`: where keys are declared;
- `references`: ranges that go to the definitions of their key on Go to
  Declaration and Ctrl/⌘-click. Elsewhere the language server answers as usual;
- `aliases`: a `prefix#` whose keys also resolve under `target#`, for inherited
  members. Chains are followed with bounded depth and candidates;
- `markers`: gutter icons that go to the definitions of their key.

Keys are the plugin's own strings and ranges are UTF-16. When a key has
definitions in the same detected module, other modules' definitions are left
out. Several targets open a chooser.

Initial discovery reuses the host's project index. The editor schedules
cancellable batches of at most 16 files; edits and file changes invalidate the
affected entries before they are indexed again. Reloading, disabling or a
failing runtime drops the plugin's graph, and nothing is answered from a
document version older than the editor's.

Limits: 2 MiB per document, 20,000 files per graph, 4,096 definitions and
references and 4,096 markers per document, 256 aliases, 200,000 entries per
graph, 16 project/window graphs and 256 candidates per lookup. A document over
a limit is not indexed; editing is never blocked.

## Minimal fixture

`crates/ide-plugin/tests/fixtures/indexer` uses a tiny line-oriented `.idx`
language to exercise definitions, references, aliases, markers and host syntax
symbols without framework-specific parsing. Run
`cargo test -p ide-host --test plugin_indexing` for the real-component contract
checks.

Framework plugins (MyBatis mappers, Rails routes) belong in their authors'
repositories and are listed through the registry; see `plugins/README.md`.
