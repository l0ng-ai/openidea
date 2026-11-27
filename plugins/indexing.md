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

A marker's tooltip lists its targets. With API 1.3, a `[[contributes.markerIcons]]`
entry can brand markers by key prefix; the longest matching prefix wins, and
other markers keep the navigation glyph:

```toml
[[contributes.markerIcons]]
id = "usages"
icon = "icons/usages.svg"
iconDark = "icons/usages_dark.svg"
markers = ["usages#"]
tooltip = "Usages of this class"   # shown above the targets
```

A marker published as `Anchor { key: "usages#User".into(), range }` then shows
that icon. See `plugins/README.md` for the limits.

Initial discovery reuses the host's project index. The editor schedules
cancellable batches of at most 16 files; edits and file changes invalidate the
affected entries before they are indexed again. Reloading, disabling or a
failing runtime drops the plugin's graph, and nothing is answered from a
document version older than the editor's.

Limits: 2 MiB per document, 20,000 files per graph, 4,096 definitions and
references and 4,096 markers per document, 256 aliases, 200,000 entries per
graph, 16 project/window graphs and 256 candidates per lookup. A document over
a limit is not indexed; editing is never blocked.

## Find Usages and Rename (API 1.3)

Find Usages on a published definition or reference lists every definition and
reference of its key alongside the language server's results. Rename replaces
every such anchor with the new name, merging language-server edits into the
same workspace edit. Alias-linked keys follow the same definition targets and
module preference as navigation. Markers are excluded: their ranges may cover
an annotation or an entire line.

Anchors must cover **exactly the name**, without quotes, delimiters or surrounding
syntax. Use UTF-16 columns, including two columns for an astral character.
Rename always shows a preview, even for a single file; cancelling leaves files
unchanged, and applying it creates one undoable workspace change. The host
checks snapshots containing returned anchors against current buffers and disk
before returning the edit, and checks preview fingerprints again before applying
it. If a document changed, wait for indexing and request the rename again.

Queries flush queued indexing work; they do not rescan the project. External
changes must reach the filesystem watcher and be indexed before newly added
anchors appear. Files without matching anchors are not refreshed by the query.

A language server that declines ownership of the indexed name does not prevent
its indexed anchors from being renamed. Failed reference or name-preparation
queries show an incomplete-search warning. A server that owns the same name
keeps its rename validation; a rejected native rename changes nothing.

When no language server can rename there (none is running, or it has no rename
support), an anchor on a code identifier, per the file's syntax tree, is not
renamed: the anchors would miss the declaration, imports and file name its
language owns. Anchors in strings, comments or attribute values, and in files
without a syntax grammar, are still renamed from the index alone.

These features consume the existing graph; no references or rename export is
needed. Unindexed names continue through the normal language-server path.

## Minimal fixture

`crates/ide-plugin/tests/fixtures/indexer` uses a tiny line-oriented `.idx`
language to exercise definitions, references, aliases, markers and host syntax
symbols without framework-specific parsing. Run
`cargo test -p ide-host --test plugin_indexing` for the real-component contract
checks.

Framework plugins (MyBatis mappers, Rails routes) belong in their authors'
repositories and are listed through the registry; see `plugins/README.md`.
