# Semantic tokens test fixture

Colours the name after every `->` in PHP documents that is not called: `method`
when the document declares `function <name>(`, `property` otherwise.

Used by `cargo test -p ide-host --test plugin_semantic_tokens` to exercise the
optional `semantic-tokens-provider` export. It is not a marketplace plugin.
